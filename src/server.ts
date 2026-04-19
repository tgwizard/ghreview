import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addPendingThread,
  createPendingReview,
  deleteReviewComment,
  disableAutoMerge,
  editReviewComment,
  fetchAutoMerge,
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

export interface ServerOptions {
  ref: PrRef;
  // Resolved when the startup fetches (PR info, diff, review state, etc.)
  // complete. Until then the server runs in "loading" mode — the browser
  // can connect and get a self-polling placeholder page so the window
  // opens immediately instead of waiting on the network.
  ready: Promise<ReadyData>;
  port?: number;
}

export interface RunningServer {
  baseUrl: string;
  prUrl: string;
  close: () => Promise<void>;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; data: ReadyData }
  | { kind: "error"; message: string };

export async function startServer(
  opts: ServerOptions,
): Promise<RunningServer> {
  const prPath = `/${encodeURIComponent(opts.ref.owner)}/${encodeURIComponent(opts.ref.repo)}/pull/${opts.ref.number}`;
  const filesPath = `${prPath}/files`;

  let state: State = { kind: "loading" };
  let cachedHtml: string | null = null;
  const fileLinesCache = new Map<string, string[] | null>();

  opts.ready
    .then((data) => {
      state = { kind: "ready", data };
      cachedHtml = null;
    })
    .catch((err) => {
      state = {
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      };
      cachedHtml = null;
    });

  const ready = (res: ServerResponse): ReadyData | null => {
    if (state.kind === "ready") return state.data;
    if (state.kind === "error") {
      jsonRes(res, 503, { error: state.message });
    } else {
      jsonRes(res, 503, { error: "still loading" });
    }
    return null;
  };

  const renderHtml = (): string => {
    if (state.kind !== "ready") return renderLoadingPage(state, prPath);
    if (cachedHtml) return cachedHtml;
    const d = state.data;
    const threadIndex = buildThreadIndex(
      d.reviewState.comments,
      d.reviewState.pendingCommentIds,
      d.reviewState.threadMetaByCommentId,
    );
    cachedHtml = renderPage(
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
    );
    return cachedHtml;
  };

  const refreshReview = async () => {
    if (state.kind !== "ready") return;
    const [next, issues, checksRollup, newCommits] = await Promise.all([
      loadReviewState(opts.ref),
      fetchIssueComments(opts.ref),
      fetchChecksRollup(opts.ref),
      fetchPrCommits(opts.ref),
    ]);
    state.data.reviewState = next;
    state.data.issueComments = issues;
    state.data.checks = checksRollup;
    state.data.commits = newCommits;
    cachedHtml = null;
  };

  const refreshAll = async () => {
    if (state.kind !== "ready") return;
    const [newPr, newDiff] = await Promise.all([
      fetchPrInfo(opts.ref),
      fetchPrDiff(opts.ref),
    ]);
    const newGitattributes = await fetchFileAtRef(
      opts.ref,
      ".gitattributes",
      newPr.headSha,
    );
    state.data.pr = newPr;
    state.data.diff = newDiff;
    state.data.generatedMatcher = buildGeneratedMatcher(newGitattributes);
    fileLinesCache.clear();
    await refreshReview();
  };

  const getFileLines = async (
    sha: string,
    filePath: string,
  ): Promise<string[] | null> => {
    const key = `${sha}:${filePath}`;
    const hit = fileLinesCache.get(key);
    if (hit !== undefined) return hit;
    const raw = await fetchFileAtRef(opts.ref, filePath, sha);
    const lines = raw === null ? null : raw.split("\n");
    fileLinesCache.set(key, lines);
    return lines;
  };

  const ensurePendingReview = async (): Promise<string> => {
    const d = state.kind === "ready" ? state.data : null;
    if (!d) throw new Error("server not ready");
    if (d.reviewState.pendingReview) return d.reviewState.pendingReview.id;
    const id = await createPendingReview(d.pr.nodeId, "");
    d.reviewState = {
      ...d.reviewState,
      pendingReview: { id, databaseId: 0, body: "" },
    };
    return id;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (path === "/" || path === "/index.html") {
        res.writeHead(302, { location: prPath });
        res.end();
        return;
      }

      if (req.method === "GET" && path === "/api/ready") {
        return jsonRes(res, 200, {
          ready: state.kind === "ready",
          error: state.kind === "error" ? state.message : undefined,
        });
      }

      if (req.method === "GET") {
        if (path === prPath || path === filesPath) {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(renderHtml());
          return;
        }
        const d = ready(res);
        if (!d) return;
        if (path === `${prPath}.diff` || path === "/raw.diff") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(d.diff);
          return;
        }
        if (path === `${prPath}.json` || path === "/pr.json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(d.pr, null, 2));
          return;
        }
        if (path === "/api/auto-merge") {
          const st = await fetchAutoMerge(opts.ref);
          return jsonRes(res, 200, st);
        }
        if (path === "/api/updates") {
          const latest = await fetchPrInfo(opts.ref);
          return jsonRes(res, 200, {
            headSha: latest.headSha,
            updatedAt: latest.updatedAt,
          });
        }

        if (path === "/api/context") {
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
          const lines = await getFileLines(sha, filePath);
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
      }

      if (req.method === "POST") {
        const d = ready(res);
        if (!d) return;
        if (path === "/api/comment") {
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
          const reviewId = await ensurePendingReview();
          await addPendingThread({
            reviewId,
            body: body.body,
            path: body.path,
            line: body.line,
            side: body.side,
          });
          await refreshReview();
          return jsonRes(res, 200, { ok: true });
        }

        if (path === "/api/submit") {
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
          const reviewId = await ensurePendingReview();
          await submitPendingReview(reviewId, body.event, body.body ?? "");
          await refreshReview();
          return jsonRes(res, 200, { ok: true });
        }

        if (path === "/api/disable-auto-merge") {
          await disableAutoMerge(d.pr.nodeId);
          const st: AutoMergeState = await fetchAutoMerge(opts.ref);
          return jsonRes(res, 200, st);
        }

        if (path === "/api/refresh") {
          await refreshAll();
          return jsonRes(res, 200, {
            headSha: d.pr.headSha,
            updatedAt: d.pr.updatedAt,
          });
        }
      }

      if (req.method === "POST" && path.startsWith("/api/thread/")) {
        const d = ready(res);
        if (!d) return;
        const m = path.match(/^\/api\/thread\/([^/]+)\/(resolve|unresolve)$/);
        if (!m) return jsonRes(res, 400, { error: "invalid thread route" });
        const nodeId = decodeURIComponent(m[1]);
        if (m[2] === "resolve") await resolveReviewThread(nodeId);
        else await unresolveReviewThread(nodeId);
        await refreshReview();
        return jsonRes(res, 200, { ok: true });
      }

      if (
        req.method === "POST" &&
        path.startsWith("/api/comment/") &&
        path.endsWith("/reply")
      ) {
        const d = ready(res);
        if (!d) return;
        const idStr = path.slice(
          "/api/comment/".length,
          -"/reply".length,
        );
        const id = Number(idStr);
        if (!Number.isInteger(id) || id <= 0) {
          return jsonRes(res, 400, { error: "invalid comment id" });
        }
        const body = (await readJson(req)) as { body?: string };
        const text = (body?.body ?? "").trim();
        if (!text) return jsonRes(res, 400, { error: "empty body" });
        await ensurePendingReview();
        await replyToReviewComment(opts.ref, id, body.body ?? "");
        await refreshReview();
        return jsonRes(res, 200, { ok: true });
      }

      if (
        (req.method === "PATCH" || req.method === "DELETE") &&
        path.startsWith("/api/comment/")
      ) {
        const d = ready(res);
        if (!d) return;
        const idStr = path.slice("/api/comment/".length);
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
          await refreshReview();
          return jsonRes(res, 200, { ok: true });
        }
        const body = (await readJson(req)) as { body?: string };
        const text = (body?.body ?? "").trim();
        if (text === "") {
          await deleteReviewComment(target.nodeId);
        } else {
          await editReviewComment(target.nodeId, body.body ?? "");
        }
        await refreshReview();
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
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind server"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        prUrl: `${baseUrl}${prPath}`,
        close: () =>
          new Promise<void>((res, rej) => {
            server.closeAllConnections();
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

function renderLoadingPage(state: State, prPath: string): string {
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
  const target = ${JSON.stringify(prPath)};
  const tick = async () => {
    try {
      const r = await fetch("/api/ready");
      const d = await r.json();
      if (d.ready) location.replace(target);
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
