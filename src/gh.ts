import { spawn } from "node:child_process";

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
    const json = await runGh(["api", "/user"]);
    const data = JSON.parse(json);
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
  const path = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const json = await runGh(["api", path]);
  const data = JSON.parse(json);
  return {
    number: data.number,
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
  };
}

export async function fetchPrDiff(ref: PrRef): Promise<string> {
  const path = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  return await runGh([
    "api",
    "-H",
    "Accept: application/vnd.github.v3.diff",
    path,
  ]);
}

export interface ReviewComment {
  id: number;
  inReplyToId: number | null;
  userLogin: string;
  userAvatarUrl: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  originalLine: number | null;
  originalSide: "LEFT" | "RIGHT" | null;
  startLine: number | null;
  startSide: "LEFT" | "RIGHT" | null;
}

export async function fetchReviewComments(
  ref: PrRef,
): Promise<ReviewComment[]> {
  const path = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/comments?per_page=100`;
  const json = await runGh(["api", "--paginate", path]);
  // --paginate concatenates JSON arrays across pages into a single array.
  const arr = JSON.parse(json) as any[];
  return arr.map((c) => ({
    id: c.id,
    inReplyToId: c.in_reply_to_id ?? null,
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
    startLine: c.start_line ?? null,
    startSide: normalizeSide(c.start_side),
  }));
}

function normalizeSide(v: unknown): "LEFT" | "RIGHT" | null {
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

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
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
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `gh ${args.join(" ")} exited with code ${code}\n${stderr.trim()}`,
          ),
        );
    });
  });
}
