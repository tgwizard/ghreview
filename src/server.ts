import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addPendingThread,
  createPendingReview,
  deleteReviewComment,
  disableAutoMerge,
  editReviewComment,
  fetchAutoMerge,
  fetchAuthedUser,
  fetchChecksRollup,
  fetchFileAtRef,
  fetchIssueComments,
  fetchPrCommits,
  fetchPrDiff,
  fetchPrInfo,
  loadReviewState,
  replyToReviewComment,
  resolveReviewThread,
  submitPendingReview,
  unresolveReviewThread,
  type AuthedUser,
  type AutoMergeState,
  type ChecksRollup,
  type DiffSide,
  type IssueComment,
  type PrCommit,
  type PrInfo,
  type PrRef,
  type ReviewState,
} from "./gh.js";
import {
  buildGeneratedMatcher,
  type GeneratedMatcher,
} from "./gitattributes.js";
import { detectLanguage } from "./highlight.js";
import { buildThreadIndex } from "./threads.js";
import { renderContextRow, renderPage } from "./ui.js";

export interface ReadyData {
  pr: PrInfo;
  diff: string;
  authedUser: AuthedUser | null;
  generatedMatcher: GeneratedMatcher;
  reviewState: ReviewState;
  issueComments: IssueComment[];
  checks: ChecksRollup | null;
  commits: PrCommit[];
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: ReadyData }
  | { kind: "error"; message: string };

interface PrSession {
  ref: PrRef;
  basePath: string;
  state: State;
  cachedHtml: string | null;
  fileLinesCache: Map<string, string[] | null>;
}

export interface ServerOptions {
  port: number;
  // PR to start loading immediately on boot so the user's first hit lands
  // on a rendered page as fast as possible.
  preload?: PrRef;
}

export interface RunningServer {
  baseUrl: string;
  urlFor(ref: PrRef): string;
  close(): Promise<void>;
}

// Sentinel at a fixed path so a second ghreview process can detect an
// existing one and hand off cleanly instead of fighting for the port.
export const IDENTITY_PATH = "/__ghreview__";

export async function startServer(
  opts: ServerOptions,
): Promise<RunningServer> {
  const sessions = new Map<string, PrSession>();
  // One lookup per process lifetime. `gh auth switch` after boot means
  // restart the server.
  const authedUser = await fetchAuthedUser();

  const keyOf = (ref: PrRef) => `${ref.owner}/${ref.repo}/${ref.number}`;
  const basePathOf = (ref: PrRef) =>
    `/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pull/${ref.number}`;

  const loadSession = (ref: PrRef): PrSession => {
    const key = keyOf(ref);
    const existing = sessions.get(key);
    if (existing) return existing;
    const session: PrSession = {
      ref,
      basePath: basePathOf(ref),
      state: { kind: "loading" },
      cachedHtml: null,
      fileLinesCache: new Map(),
    };
    sessions.set(key, session);
    fetchReadyData(ref, authedUser)
      .then((data) => {
        session.state = { kind: "ready", data };
        session.cachedHtml = null;
      })
      .catch((err: unknown) => {
        session.state = {
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        };
        session.cachedHtml = null;
      });
    return session;
  };

  const renderSessionHtml = (s: PrSession): string => {
    if (s.state.kind !== "ready")
      return renderLoadingPage(s.state, s.basePath);
    if (s.cachedHtml) return s.cachedHtml;
    const d = s.state.data;
    const threadIndex = buildThreadIndex(
      d.reviewState.comments,
      d.reviewState.pendingCommentIds,
      d.reviewState.threadMetaByCommentId,
    );
    s.cachedHtml = renderPage(
      d.pr,
      d.diff,
      d.generatedMatcher,
      d.authedUser,
      threadIndex,
      d.reviewState.pendingReview,
      d.reviewState.pendingCommentIds,
      d.issueComments,
      d.checks,
      d.commits,
      s.basePath,
    );
    return s.cachedHtml;
  };

  const refreshReviewFor = async (s: PrSession) => {
    if (s.state.kind !== "ready") return;
    const [next, issues, checksRollup, newCommits] = await Promise.all([
      loadReviewState(s.ref),
      fetchIssueComments(s.ref),
      fetchChecksRollup(s.ref),
      fetchPrCommits(s.ref),
    ]);
    s.state.data.reviewState = next;
    s.state.data.issueComments = issues;
    s.state.data.checks = checksRollup;
    s.state.data.commits = newCommits;
    s.cachedHtml = null;
  };

  const refreshAllFor = async (s: PrSession) => {
    if (s.state.kind !== "ready") return;
    const [newPr, newDiff] = await Promise.all([
      fetchPrInfo(s.ref),
      fetchPrDiff(s.ref),
    ]);
    const newGitattributes = await fetchFileAtRef(
      s.ref,
      ".gitattributes",
      newPr.headSha,
    );
    s.state.data.pr = newPr;
    s.state.data.diff = newDiff;
    s.state.data.generatedMatcher = buildGeneratedMatcher(newGitattributes);
    s.fileLinesCache.clear();
    await refreshReviewFor(s);
  };

  const getFileLines = async (
    s: PrSession,
    sha: string,
    filePath: string,
  ): Promise<string[] | null> => {
    const cacheKey = `${sha}:${filePath}`;
    const hit = s.fileLinesCache.get(cacheKey);
    if (hit !== undefined) return hit;
    const raw = await fetchFileAtRef(s.ref, filePath, sha);
    const lines = raw === null ? null : raw.split("\n");
    s.fileLinesCache.set(cacheKey, lines);
    return lines;
  };

  const ensurePendingReview = async (s: PrSession): Promise<string> => {
    if (s.state.kind !== "ready") throw new Error("session not ready");
    const d = s.state.data;
    if (d.reviewState.pendingReview) return d.reviewState.pendingReview.id;
    const id = await createPendingReview(d.pr.nodeId, "");
    d.reviewState = {
      ...d.reviewState,
      pendingReview: { id, databaseId: 0, body: "" },
    };
    return id;
  };

  if (opts.preload) loadSession(opts.preload);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === IDENTITY_PATH) {
        return jsonRes(res, 200, { product: "ghreview", ok: true });
      }
      if (path === "/" || path === "/index.html") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(renderIndexPage(Array.from(sessions.values())));
        return;
      }

      // Match /{owner}/{repo}/pull/{N}[suffix]. suffix is `""`, `/files`,
      // `/api/<...>`, `.diff`, or `.json`.
      const m = path.match(
        /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(\/.*|\.diff|\.json)?$/,
      );
      if (!m) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }
      const ref: PrRef = {
        owner: decodeURIComponent(m[1]),
        repo: decodeURIComponent(m[2]),
        number: Number(m[3]),
      };
      const suffix = m[4] ?? "";
      const s = loadSession(ref);
      const d = s.state.kind === "ready" ? s.state.data : null;

      // --- Routes that work regardless of loading state ---
      // Accept GitHub-compatible sub-paths as aliases for the PR page so
      // pasting /pull/N/files, /pull/N/changes, /pull/N/commits etc. into
      // the browser lands on the rendered page. The client handles
      // tab/anchor switching via location.hash.
      const htmlAliases = new Set([
        "",
        "/files",
        "/changes",
        "/commits",
        "/conversation",
        "/checks",
      ]);
      if (req.method === "GET" && htmlAliases.has(suffix)) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(renderSessionHtml(s));
        return;
      }
      if (req.method === "GET" && suffix === "/api/ready") {
        return jsonRes(res, 200, {
          ready: s.state.kind === "ready",
          error: s.state.kind === "error" ? s.state.message : undefined,
        });
      }

      // Everything below needs ready data.
      if (!d) {
        return jsonRes(
          res,
          503,
          s.state.kind === "error"
            ? { error: s.state.message }
            : { error: "still loading" },
        );
      }

      if (req.method === "GET" && suffix === ".diff") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(d.diff);
        return;
      }
      if (req.method === "GET" && suffix === ".json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(d.pr, null, 2));
        return;
      }
      if (req.method === "GET" && suffix === "/api/auto-merge") {
        const st = await fetchAutoMerge(s.ref);
        return jsonRes(res, 200, st);
      }
      if (req.method === "GET" && suffix === "/api/updates") {
        const latest = await fetchPrInfo(s.ref);
        return jsonRes(res, 200, {
          headSha: latest.headSha,
          updatedAt: latest.updatedAt,
        });
      }
      if (req.method === "GET" && suffix === "/api/context") {
        const filePath = url.searchParams.get("path");
        const sideParam = url.searchParams.get("side");
        const startParam = Number(url.searchParams.get("start"));
        const endParam = Number(url.searchParams.get("end"));
        const deltaParam = Number(url.searchParams.get("delta"));
        if (
          !filePath ||
          (sideParam !== "LEFT" && sideParam !== "RIGHT") ||
          !Number.isInteger(startParam) ||
          !Number.isInteger(endParam) ||
          !Number.isInteger(deltaParam) ||
          startParam < 1 ||
          endParam < startParam ||
          endParam - startParam > 500
        ) {
          return jsonRes(res, 400, { error: "invalid context request" });
        }
        const sha = sideParam === "LEFT" ? d.pr.baseSha : d.pr.headSha;
        const lines = await getFileLines(s, sha, filePath);
        if (lines === null) {
          return jsonRes(res, 404, { error: "file not found at ref" });
        }
        const clampedEnd = Math.min(endParam, lines.length);
        const slice = lines.slice(startParam - 1, clampedEnd);
        const language = detectLanguage(filePath);
        const html = slice
          .map((content, i) => {
            const newLine = startParam + i;
            const oldLine = newLine - deltaParam;
            return renderContextRow(
              newLine,
              oldLine,
              content,
              filePath,
              language,
            );
          })
          .join("");
        return jsonRes(res, 200, {
          html,
          firstLine: startParam,
          lastLine: startParam + slice.length - 1,
          eof: clampedEnd >= lines.length,
        });
      }

      if (req.method === "POST" && suffix === "/api/comment") {
        const body = (await readJson(req)) as {
          path: string;
          line: number;
          side: DiffSide;
          body: string;
        };
        if (
          !body?.path ||
          !Number.isFinite(body.line) ||
          (body.side !== "LEFT" && body.side !== "RIGHT") ||
          !body.body?.trim()
        ) {
          return jsonRes(res, 400, { error: "invalid comment payload" });
        }
        const reviewId = await ensurePendingReview(s);
        await addPendingThread({
          reviewId,
          body: body.body,
          path: body.path,
          line: body.line,
          side: body.side,
        });
        await refreshReviewFor(s);
        return jsonRes(res, 200, { ok: true });
      }

      if (req.method === "POST" && suffix === "/api/submit") {
        const body = (await readJson(req)) as {
          event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
          body: string;
        };
        if (
          body.event !== "APPROVE" &&
          body.event !== "REQUEST_CHANGES" &&
          body.event !== "COMMENT"
        ) {
          return jsonRes(res, 400, { error: "invalid event" });
        }
        const reviewId = await ensurePendingReview(s);
        await submitPendingReview(reviewId, body.event, body.body ?? "");
        await refreshReviewFor(s);
        return jsonRes(res, 200, { ok: true });
      }

      if (req.method === "POST" && suffix === "/api/disable-auto-merge") {
        await disableAutoMerge(d.pr.nodeId);
        const st: AutoMergeState = await fetchAutoMerge(s.ref);
        return jsonRes(res, 200, st);
      }

      if (req.method === "POST" && suffix === "/api/refresh") {
        await refreshAllFor(s);
        return jsonRes(res, 200, {
          headSha: d.pr.headSha,
          updatedAt: d.pr.updatedAt,
        });
      }

      if (req.method === "POST" && suffix.startsWith("/api/thread/")) {
        const tm = suffix.match(/^\/api\/thread\/([^/]+)\/(resolve|unresolve)$/);
        if (!tm) return jsonRes(res, 400, { error: "invalid thread route" });
        const nodeId = decodeURIComponent(tm[1]);
        if (tm[2] === "resolve") await resolveReviewThread(nodeId);
        else await unresolveReviewThread(nodeId);
        await refreshReviewFor(s);
        return jsonRes(res, 200, { ok: true });
      }

      if (
        req.method === "POST" &&
        suffix.startsWith("/api/comment/") &&
        suffix.endsWith("/reply")
      ) {
        const idStr = suffix.slice("/api/comment/".length, -"/reply".length);
        const id = Number(idStr);
        if (!Number.isInteger(id) || id <= 0) {
          return jsonRes(res, 400, { error: "invalid comment id" });
        }
        const body = (await readJson(req)) as { body?: string };
        const text = (body?.body ?? "").trim();
        if (!text) return jsonRes(res, 400, { error: "empty body" });
        await ensurePendingReview(s);
        await replyToReviewComment(s.ref, id, body.body ?? "");
        await refreshReviewFor(s);
        return jsonRes(res, 200, { ok: true });
      }

      if (
        (req.method === "PATCH" || req.method === "DELETE") &&
        suffix.startsWith("/api/comment/")
      ) {
        const idStr = suffix.slice("/api/comment/".length);
        const id = Number(idStr);
        if (!Number.isInteger(id) || id <= 0) {
          return jsonRes(res, 400, { error: "invalid comment id" });
        }
        const target = d.reviewState.comments.find((c) => c.id === id);
        if (!target || !target.nodeId) {
          return jsonRes(res, 404, { error: "comment not found" });
        }
        if (req.method === "DELETE") {
          await deleteReviewComment(target.nodeId);
          await refreshReviewFor(s);
          return jsonRes(res, 200, { ok: true });
        }
        const body = (await readJson(req)) as { body?: string };
        const text = (body?.body ?? "").trim();
        if (text === "") {
          await deleteReviewComment(target.nodeId);
        } else {
          await editReviewComment(target.nodeId, body.body ?? "");
        }
        await refreshReviewFor(s);
        return jsonRes(res, 200, { ok: true });
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind server"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        urlFor: (ref) => baseUrl + basePathOf(ref),
        close: () =>
          new Promise<void>((res, rej) => {
            server.closeAllConnections();
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

async function fetchReadyData(
  ref: PrRef,
  authedUser: AuthedUser | null,
): Promise<ReadyData> {
  const [pr, reviewState, issueComments, checks, commits, diff] =
    await Promise.all([
      fetchPrInfo(ref),
      loadReviewState(ref),
      fetchIssueComments(ref),
      fetchChecksRollup(ref),
      fetchPrCommits(ref),
      fetchPrDiff(ref),
    ]);
  const gitattributes = await fetchFileAtRef(ref, ".gitattributes", pr.headSha);
  return {
    pr,
    diff,
    authedUser,
    generatedMatcher: buildGeneratedMatcher(gitattributes),
    reviewState,
    issueComments,
    checks,
    commits,
  };
}

function renderIndexPage(sessions: PrSession[]): string {
  const rows = sessions
    .map((s) => {
      const status =
        s.state.kind === "ready"
          ? escapeHtml(s.state.data.pr.title)
          : s.state.kind === "error"
            ? `error: ${escapeHtml(s.state.message)}`
            : "loading…";
      return `<li><a href="${escapeHtml(s.basePath)}"><code>${escapeHtml(`${s.ref.owner}/${s.ref.repo}`)}</code> #${s.ref.number}</a> — ${status}</li>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>ghreview</title>
<style>
html, body { margin: 0; padding: 40px; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 680px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 8px; }
.sub { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
ul { list-style: none; padding: 0; }
li { padding: 8px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 6px; margin-bottom: 6px; }
li a { color: #2f81f7; text-decoration: none; }
li a:hover { text-decoration: underline; }
form { display: flex; gap: 8px; margin-top: 24px; }
input[type=text] { flex: 1; background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 8px 10px; font-family: inherit; font-size: 13px; }
input[type=text]:focus { outline: 2px solid #2f81f7; outline-offset: -1px; }
button { background: #238636; color: white; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; font-family: inherit; font-size: 13px; }
button:hover { background: #2ea043; }
code { font-family: ui-monospace, Menlo, monospace; }
.empty { color: #8b949e; font-style: italic; text-align: center; padding: 16px; }
</style>
</head><body>
<main>
  <h1>ghreview</h1>
  <div class="sub">Open a PR by URL or <code>owner/repo#number</code></div>
  <form id="go" onsubmit="return jump(event)">
    <input type="text" id="input" placeholder="https://github.com/owner/repo/pull/123  or  owner/repo#123" autofocus />
    <button type="submit">Open</button>
  </form>
  ${sessions.length === 0 ? '<div class="empty">No PRs loaded yet.</div>' : `<h2 style="font-size:13px;color:#8b949e;margin:24px 0 8px;text-transform:uppercase;letter-spacing:0.04em">Loaded</h2><ul>${rows}</ul>`}
</main>
<script>
function jump(ev){
  ev.preventDefault();
  const v = document.getElementById("input").value.trim();
  if (!v) return false;
  const m = v.match(/github\\.com[/:]([^/]+)\\/([^/]+?)(?:\\.git)?\\/pull\\/(\\d+)(?:\\/[^#]*)?(#.*)?$/)
    || v.match(/^([^/\\s]+)\\/([^#\\s]+)#(\\d+)(#.*)?$/);
  if (!m) { alert("Couldn't parse that — expected a GitHub PR URL or owner/repo#N"); return false; }
  location.href = "/" + encodeURIComponent(m[1]) + "/" + encodeURIComponent(m[2]) + "/pull/" + m[3] + (m[4] || "");
  return false;
}
</script>
</body></html>`;
}

function renderLoadingPage(state: State, basePath: string): string {
  const isError = state.kind === "error";
  const message = isError ? (state as any).message : "Loading from GitHub…";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<title>${isError ? "Error" : "Loading"} · ghreview</title>
<style>
html, body { margin: 0; padding: 0; height: 100%; background: #0d1117; color: #e6edf3; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
body { display: flex; align-items: center; justify-content: center; }
.loading { text-align: center; }
.spinner { width: 36px; height: 36px; border: 3px solid #30363d; border-top-color: #2f81f7; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
@keyframes spin { to { transform: rotate(360deg); } }
.msg { font-size: 14px; color: #8b949e; }
.err { color: #f85149; max-width: 560px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; text-align: left; background: #161b22; padding: 12px; border-radius: 6px; border: 1px solid #30363d; white-space: pre-wrap; }
</style>
</head><body>
<div class="loading">
  ${isError ? "" : '<div class="spinner"></div>'}
  <div class="msg">${isError ? "Error loading PR:" : "Loading PR from GitHub…"}</div>
  ${isError ? `<pre class="err">${escapeHtml(message)}</pre>` : ""}
</div>
<script>
(function(){
  if (${isError ? "true" : "false"}) return;
  const base = ${JSON.stringify(basePath)};
  const tick = async () => {
    try {
      const r = await fetch(base + "/api/ready");
      const d = await r.json();
      if (d.ready) location.replace(base + location.hash);
      else if (d.error) document.querySelector(".msg").textContent = "Error: " + d.error;
    } catch {}
  };
  setInterval(tick, 500);
  tick();
})();
</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jsonRes(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c.toString();
      if (buf.length > 1_000_000) {
        req.destroy();
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
