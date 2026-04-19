import { spawn } from "node:child_process";

export type DiffSide = "LEFT" | "RIGHT";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface AuthedUser {
  login: string;
  avatarUrl: string;
  name: string | null;
}

export async function fetchAuthedUser(): Promise<AuthedUser | null> {
  try {
    const data = await ghApiJson<any>(["/user"]);
    return {
      login: data.login,
      avatarUrl: data.avatar_url,
      name: data.name ?? null,
    };
  } catch {
    return null;
  }
}

export interface PrInfo {
  number: number;
  nodeId: string; // GraphQL global ID; needed for review/auto-merge mutations.
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  baseRef: string;
  headRef: string;
  baseSha: string;
  headSha: string;
  url: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
}

export function parsePrUrl(input: string): PrRef {
  const m = input.match(
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/pull\/(\d+)/,
  );
  if (!m) {
    throw new Error(
      `Could not parse PR URL: ${input}\nExpected something like https://github.com/owner/repo/pull/123`,
    );
  }
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export async function fetchPrInfo(ref: PrRef): Promise<PrInfo> {
  const data = await ghApiJson<any>([
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
  ]);
  return {
    number: data.number,
    nodeId: data.node_id ?? "",
    title: data.title,
    state: data.state,
    isDraft: Boolean(data.draft),
    author: data.user?.login ?? "",
    baseRef: data.base?.ref ?? "",
    headRef: data.head?.ref ?? "",
    baseSha: data.base?.sha ?? "",
    headSha: data.head?.sha ?? "",
    url: data.html_url,
    body: data.body ?? "",
    additions: data.additions ?? 0,
    deletions: data.deletions ?? 0,
    changedFiles: data.changed_files ?? 0,
    updatedAt: data.updated_at ?? "",
  };
}

export async function fetchPrDiff(ref: PrRef): Promise<string> {
  // We avoid the `Accept: application/vnd.github.v3.diff` endpoint because it
  // returns HTTP 406 for PRs with diffs > 20k lines — exactly the case this
  // tool exists to review. `/pulls/{n}/files` is paginated, has no global
  // line limit, and returns per-file `patch` hunks we can stitch together.
  const files = await ghApiJson<any[]>([
    "--paginate",
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`,
  ]);
  return files.map(synthesizeFileDiff).join("");
}

function synthesizeFileDiff(f: any): string {
  const filename: string = f.filename;
  const prev: string = f.previous_filename ?? filename;
  const status: string = f.status;
  const lines: string[] = [];

  if (status === "renamed") {
    lines.push(`diff --git a/${prev} b/${filename}`);
    lines.push(`rename from ${prev}`);
    lines.push(`rename to ${filename}`);
    if (f.patch) {
      lines.push(`--- a/${prev}`);
      lines.push(`+++ b/${filename}`);
    }
  } else if (status === "added") {
    lines.push(`diff --git a/${filename} b/${filename}`);
    lines.push("new file mode 100644");
    if (f.patch) {
      lines.push("--- /dev/null");
      lines.push(`+++ b/${filename}`);
    }
  } else if (status === "removed") {
    lines.push(`diff --git a/${filename} b/${filename}`);
    lines.push("deleted file mode 100644");
    if (f.patch) {
      lines.push(`--- a/${filename}`);
      lines.push("+++ /dev/null");
    }
  } else {
    lines.push(`diff --git a/${prev} b/${filename}`);
    if (f.patch) {
      lines.push(`--- a/${prev}`);
      lines.push(`+++ b/${filename}`);
    }
  }

  if (f.patch) lines.push(f.patch);
  return lines.join("\n") + "\n";
}

export interface ReviewComment {
  id: number;
  nodeId: string; // GraphQL node id, needed for update/delete mutations.
  inReplyToId: number | null;
  pullRequestReviewId: number | null;
  userLogin: string;
  userAvatarUrl: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  path: string;
  line: number | null;
  side: DiffSide | null;
  originalLine: number | null;
  originalSide: DiffSide | null;
}

export interface IssueComment {
  id: number;
  userLogin: string;
  userAvatarUrl: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export async function fetchIssueComments(
  ref: PrRef,
): Promise<IssueComment[]> {
  const arr = await ghApiJson<any[]>([
    "--paginate",
    `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=100`,
  ]);
  return arr.map((c) => ({
    id: c.id,
    userLogin: c.user?.login ?? "",
    userAvatarUrl: c.user?.avatar_url ?? "",
    body: c.body ?? "",
    createdAt: c.created_at ?? "",
    updatedAt: c.updated_at ?? "",
    htmlUrl: c.html_url ?? "",
  }));
}

export async function fetchReviewComments(
  ref: PrRef,
): Promise<ReviewComment[]> {
  const arr = await ghApiJson<any[]>([
    "--paginate",
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments?per_page=100`,
  ]);
  return arr.map(mapReviewComment);
}

export async function fetchCommentsForReview(
  ref: PrRef,
  reviewDatabaseId: number,
): Promise<ReviewComment[]> {
  // /pulls/{n}/comments may omit the viewer's own pending comments; this
  // endpoint is scoped to a single review (including PENDING) and returns
  // the full comment objects.
  const arr = await ghApiJson<any[]>([
    "--paginate",
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews/${reviewDatabaseId}/comments?per_page=100`,
  ]);
  return arr.map(mapReviewComment);
}

export async function editReviewComment(
  commentNodeId: string,
  body: string,
): Promise<void> {
  // REST PATCH /pulls/comments/{id} 404s on pending comments; GraphQL
  // handles both submitted and pending.
  const mutation = `
    mutation($id:ID!,$body:String!){
      updatePullRequestReviewComment(input:{
        pullRequestReviewCommentId:$id, body:$body
      }){ pullRequestReviewComment{ id } }
    }`;
  await gqlQuery<any>(mutation, { id: commentNodeId, body });
}

export async function deleteReviewComment(
  commentNodeId: string,
): Promise<void> {
  const mutation = `
    mutation($id:ID!){
      deletePullRequestReviewComment(input:{id:$id}){
        pullRequestReview{ id }
      }
    }`;
  await gqlQuery<any>(mutation, { id: commentNodeId });
}

export async function replyToReviewComment(
  ref: PrRef,
  parentCommentId: number,
  body: string,
): Promise<void> {
  // GitHub auto-attaches the reply to the viewer's pending review if one
  // exists, so the server ensures there's a pending review first.
  await runGh([
    "api",
    "-X",
    "POST",
    "-f",
    `body=${body}`,
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments/${parentCommentId}/replies`,
  ]);
}

function mapReviewComment(c: any): ReviewComment {
  return {
    id: c.id,
    nodeId: c.node_id ?? "",
    inReplyToId: c.in_reply_to_id ?? null,
    pullRequestReviewId: c.pull_request_review_id ?? null,
    userLogin: c.user?.login ?? "",
    userAvatarUrl: c.user?.avatar_url ?? "",
    body: c.body ?? "",
    createdAt: c.created_at ?? "",
    updatedAt: c.updated_at ?? "",
    htmlUrl: c.html_url ?? "",
    path: c.path ?? "",
    line: c.line ?? null,
    side: normalizeSide(c.side),
    originalLine: c.original_line ?? null,
    originalSide: normalizeSide(c.original_side),
  };
}

function normalizeSide(v: unknown): DiffSide | null {
  return v === "LEFT" || v === "RIGHT" ? v : null;
}

export async function fetchFileAtRef(
  ref: PrRef,
  filePath: string,
  sha: string,
): Promise<string | null> {
  const apiPath = `/repos/${ref.owner}/${ref.repo}/contents/${filePath}?ref=${sha}`;
  try {
    const raw = await runGh([
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      apiPath,
    ]);
    return raw;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 404/i.test(msg) || /Not Found/i.test(msg)) return null;
    throw err;
  }
}

async function ghApiJson<T>(apiArgs: string[]): Promise<T> {
  return JSON.parse(await runGh(["api", ...apiArgs])) as T;
}

export interface PendingReview {
  id: string; // GraphQL node ID
  databaseId: number; // REST integer id
  body: string;
}

export async function fetchPendingReview(
  ref: PrRef,
): Promise<PendingReview | null> {
  const query = `
    query($owner:String!,$repo:String!,$num:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$num){
          reviews(first:20,states:[PENDING]){
            nodes{ id databaseId body author{ login } }
          }
        }
      }
      viewer{ login }
    }`;
  try {
    const res = await gqlQuery<any>(query, {
      owner: ref.owner,
      repo: ref.repo,
      num: ref.number,
    });
    const viewerLogin = res.viewer?.login ?? "";
    const reviews: any[] = res.repository?.pullRequest?.reviews?.nodes ?? [];
    const mine = reviews.find((r) => r.author?.login === viewerLogin);
    if (!mine) return null;
    return {
      id: mine.id,
      databaseId: mine.databaseId,
      body: mine.body ?? "",
    };
  } catch {
    return null;
  }
}

export interface ThreadMetadata {
  nodeId: string;
  isResolved: boolean;
}

export interface ReviewState {
  comments: ReviewComment[];
  pendingReview: PendingReview | null;
  pendingCommentIds: Set<number>;
  threadMetaByCommentId: Map<number, ThreadMetadata>;
}

export async function loadReviewState(ref: PrRef): Promise<ReviewState> {
  const [submitted, pendingReview, threadMetaByCommentId] = await Promise.all([
    fetchReviewComments(ref),
    fetchPendingReview(ref),
    fetchThreadMetadata(ref),
  ]);
  const pendingComments = pendingReview
    ? await fetchCommentsForReview(ref, pendingReview.databaseId)
    : [];
  const byId = new Map<number, ReviewComment>();
  for (const c of submitted) byId.set(c.id, c);
  for (const c of pendingComments) byId.set(c.id, c);
  return {
    comments: Array.from(byId.values()),
    pendingReview,
    pendingCommentIds: new Set(pendingComments.map((c) => c.id)),
    threadMetaByCommentId,
  };
}

// GraphQL is the only place `isResolved` and the thread node id (needed for
// resolve/unresolve mutations) live — REST /pulls/{n}/comments omits both.
// We key by comment databaseId so callers can enrich their existing
// ReviewComment-based view without rewriting the whole fetch path.
async function fetchThreadMetadata(
  ref: PrRef,
): Promise<Map<number, ThreadMetadata>> {
  const query = `
    query($owner:String!,$repo:String!,$num:Int!,$cursor:String){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$num){
          reviewThreads(first:100,after:$cursor){
            pageInfo{ hasNextPage endCursor }
            nodes{
              id
              isResolved
              comments(first:100){ nodes{ databaseId } }
            }
          }
        }
      }
    }`;
  const out = new Map<number, ThreadMetadata>();
  let cursor: string | null = null;
  try {
    while (true) {
      const vars: Record<string, unknown> = {
        owner: ref.owner,
        repo: ref.repo,
        num: ref.number,
      };
      if (cursor) vars.cursor = cursor;
      const data = await gqlQuery<any>(query, vars);
      const conn = data.repository?.pullRequest?.reviewThreads;
      if (!conn) break;
      for (const t of conn.nodes ?? []) {
        const meta: ThreadMetadata = { nodeId: t.id, isResolved: !!t.isResolved };
        for (const c of t.comments?.nodes ?? []) {
          if (typeof c.databaseId === "number") out.set(c.databaseId, meta);
        }
      }
      if (!conn.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  } catch {
    // Non-fatal — thread metadata enriches the view but isn't required.
  }
  return out;
}

export async function resolveReviewThread(
  threadNodeId: string,
): Promise<void> {
  await gqlQuery<any>(
    `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}`,
    { id: threadNodeId },
  );
}

export async function unresolveReviewThread(
  threadNodeId: string,
): Promise<void> {
  await gqlQuery<any>(
    `mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id}}}`,
    { id: threadNodeId },
  );
}

export interface AutoMergeState {
  enabled: boolean;
  method?: "MERGE" | "SQUASH" | "REBASE";
  enabledByLogin?: string;
  enabledAt?: string;
}

export async function fetchAutoMerge(ref: PrRef): Promise<AutoMergeState> {
  const query = `
    query($owner:String!,$repo:String!,$num:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$num){
          autoMergeRequest{ mergeMethod enabledAt enabledBy{ login } }
        }
      }
    }`;
  const res = await gqlQuery<any>(query, {
    owner: ref.owner,
    repo: ref.repo,
    num: ref.number,
  });
  const amr = res.repository?.pullRequest?.autoMergeRequest;
  if (!amr) return { enabled: false };
  return {
    enabled: true,
    method: amr.mergeMethod,
    enabledByLogin: amr.enabledBy?.login,
    enabledAt: amr.enabledAt,
  };
}

export async function createPendingReview(
  prNodeId: string,
  body = "",
): Promise<string> {
  const mutation = `
    mutation($prId:ID!,$body:String){
      addPullRequestReview(input:{pullRequestId:$prId, body:$body}){
        pullRequestReview{ id }
      }
    }`;
  const res = await gqlQuery<any>(mutation, { prId: prNodeId, body });
  return res.addPullRequestReview.pullRequestReview.id as string;
}

export interface NewCommentInput {
  reviewId: string;
  body: string;
  path: string;
  line: number;
  side: DiffSide;
}

export async function addPendingThread(input: NewCommentInput): Promise<void> {
  const mutation = `
    mutation($rid:ID!,$body:String!,$path:String!,$line:Int!,$side:DiffSide!){
      addPullRequestReviewThread(input:{
        pullRequestReviewId:$rid, body:$body, path:$path,
        line:$line, side:$side
      }){ thread{ id } }
    }`;
  await gqlQuery<any>(mutation, {
    rid: input.reviewId,
    body: input.body,
    path: input.path,
    line: input.line,
    side: input.side,
  });
}

export async function submitPendingReview(
  reviewId: string,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body: string,
): Promise<void> {
  const mutation = `
    mutation($rid:ID!,$event:PullRequestReviewEvent!,$body:String){
      submitPullRequestReview(input:{
        pullRequestReviewId:$rid, event:$event, body:$body
      }){ pullRequestReview{ id state } }
    }`;
  await gqlQuery<any>(mutation, { rid: reviewId, event, body });
}

export interface ChecksRollup {
  state: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED" | string;
  totalCount: number;
  passing: number;
  failing: number;
  pending: number;
}

export async function fetchChecksRollup(
  ref: PrRef,
): Promise<ChecksRollup | null> {
  const query = `
    query($owner:String!,$repo:String!,$num:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$num){
          commits(last:1){
            nodes{
              commit{
                statusCheckRollup{
                  state
                  contexts(first:100){
                    totalCount
                    nodes{
                      __typename
                      ... on CheckRun { status conclusion }
                      ... on StatusContext { state }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`;
  try {
    const data = await gqlQuery<any>(query, {
      owner: ref.owner,
      repo: ref.repo,
      num: ref.number,
    });
    const rollup =
      data.repository?.pullRequest?.commits?.nodes?.[0]?.commit
        ?.statusCheckRollup;
    if (!rollup) return null;
    let passing = 0;
    let failing = 0;
    let pending = 0;
    for (const n of rollup.contexts?.nodes ?? []) {
      if (n.__typename === "CheckRun") {
        if (n.status !== "COMPLETED") pending++;
        else if (
          n.conclusion === "SUCCESS" ||
          n.conclusion === "NEUTRAL" ||
          n.conclusion === "SKIPPED"
        )
          passing++;
        else failing++;
      } else {
        if (n.state === "PENDING") pending++;
        else if (n.state === "SUCCESS") passing++;
        else failing++;
      }
    }
    return {
      state: rollup.state,
      totalCount: rollup.contexts?.totalCount ?? 0,
      passing,
      failing,
      pending,
    };
  } catch {
    return null;
  }
}

export interface PrCommit {
  sha: string;
  abbreviatedSha: string;
  message: string;
  authorLogin: string;
  authorAvatarUrl: string;
  authoredAt: string;
  htmlUrl: string;
}

export async function fetchPrCommits(ref: PrRef): Promise<PrCommit[]> {
  const arr = await ghApiJson<any[]>([
    "--paginate",
    `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/commits?per_page=100`,
  ]);
  return arr.map((c) => ({
    sha: c.sha,
    abbreviatedSha: (c.sha ?? "").slice(0, 7),
    message: c.commit?.message ?? "",
    authorLogin: c.author?.login ?? c.commit?.author?.name ?? "",
    authorAvatarUrl: c.author?.avatar_url ?? "",
    authoredAt: c.commit?.author?.date ?? "",
    htmlUrl: c.html_url ?? "",
  }));
}

export async function disableAutoMerge(prNodeId: string): Promise<void> {
  const mutation = `
    mutation($prId:ID!){
      disablePullRequestAutoMerge(input:{pullRequestId:$prId}){
        pullRequest{ id }
      }
    }`;
  await gqlQuery<any>(mutation, { prId: prNodeId });
}

async function gqlQuery<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const args = ["graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(variables)) {
    if (typeof v === "number") args.push("-F", `${k}=${v}`);
    else args.push("-f", `${k}=${String(v)}`);
  }
  const json = await runGh(["api", ...args]);
  const parsed = JSON.parse(json);
  if (parsed.errors?.length) {
    const msg = parsed.errors
      .map((e: any) => e.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(`GraphQL error: ${msg}`);
  }
  return parsed.data as T;
}

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    // Buffer chunks and concat once at the end so multi-MB diffs don't pay
    // quadratic string-reallocation cost.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "gh CLI not found. Install it from https://cli.github.com/ and run `gh auth login`.",
          ),
        );
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString("utf8"));
      } else {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(
          new Error(`gh ${args.join(" ")} exited with code ${code}\n${stderr}`),
        );
      }
    });
  });
}
