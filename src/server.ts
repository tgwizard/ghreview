import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addPendingThread,
  createPendingReview,
  deleteReviewComment,
  disableAutoMerge,
  editReviewComment,
  fetchAutoMerge,
  fetchCommentsForReview,
  fetchFileAtRef,
  fetchPendingReview,
  fetchPrDiff,
  fetchPrInfo,
  fetchReviewComments,
  replyToReviewComment,
  submitPendingReview,
  type AuthedUser,
  type AutoMergeState,
  type DiffSide,
  type PendingReview,
  type PrInfo,
  type PrRef,
  type ReviewComment,
} from "./gh.js";
import { buildGeneratedMatcher, type GeneratedMatcher } from "./gitattributes.js";
import { buildThreadIndex } from "./threads.js";
import { renderPage } from "./ui.js";

export interface ServerOptions {
  ref: PrRef;
  pr: PrInfo;
  diff: string;
  authedUser: AuthedUser | null;
  generatedMatcher: GeneratedMatcher;
  initialReviewComments: ReviewComment[];
  initialPendingReview: PendingReview | null;
  port?: number;
}

export interface RunningServer {
  baseUrl: string;
  prUrl: string;
  close: () => Promise<void>;
}

export async function startServer(
  opts: ServerOptions,
): Promise<RunningServer> {
  const prPath = `/${encodeURIComponent(opts.ref.owner)}/${encodeURIComponent(opts.ref.repo)}/pull/${opts.ref.number}`;
  const filesPath = `${prPath}/files`;

  let pr = opts.pr;
  let diff = opts.diff;
  let generatedMatcher = opts.generatedMatcher;
  let comments = opts.initialReviewComments;
  let pendingReview = opts.initialPendingReview;
  let cachedHtml: string | null = null;

  const renderHtml = () => {
    if (cachedHtml) return cachedHtml;
    const pendingIds = new Set(pendingReview?.commentIds ?? []);
    const threadIndex = buildThreadIndex(comments, pendingIds);
    cachedHtml = renderPage(
      pr,
      diff,
      generatedMatcher,
      opts.authedUser,
      threadIndex,
      pendingReview,
    );
    return cachedHtml;
  };

  const refreshReview = async () => {
    const [submitted, pending] = await Promise.all([
      fetchReviewComments(opts.ref),
      fetchPendingReview(opts.ref),
    ]);
    const pendingCmts = pending
      ? await fetchCommentsForReview(opts.ref, pending.databaseId)
      : [];
    const byId = new Map<number, ReviewComment>();
    for (const c of submitted) byId.set(c.id, c);
    for (const c of pendingCmts) byId.set(c.id, c);
    comments = Array.from(byId.values());
    pendingReview = pending;
    cachedHtml = null;
  };

  // Re-fetch everything (PR info, diff, .gitattributes, review state).
  // Called when the user hits Refresh or we detect new commits upstream.
  const refreshAll = async () => {
    const [newPr, newDiff] = await Promise.all([
      fetchPrInfo(opts.ref),
      fetchPrDiff(opts.ref),
    ]);
    const newGitattributes = await fetchFileAtRef(
      opts.ref,
      ".gitattributes",
      newPr.headSha,
    );
    pr = newPr;
    diff = newDiff;
    generatedMatcher = buildGeneratedMatcher(newGitattributes);
    await refreshReview();
  };

  const ensurePendingReview = async (): Promise<string> => {
    if (pendingReview) return pendingReview.id;
    const id = await createPendingReview(pr.nodeId, "");
    pendingReview = { id, databaseId: 0, body: "", commentIds: [] };
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

      if (req.method === "GET") {
        if (path === prPath || path === filesPath) {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          res.end(renderHtml());
          return;
        }
        if (path === `${prPath}.diff` || path === "/raw.diff") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(diff);
          return;
        }
        if (path === `${prPath}.json` || path === "/pr.json") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(pr, null, 2));
          return;
        }
        if (path === "/api/updates") {
          // Live-poll GitHub for the PR's current head SHA + updated_at.
          // Client compares against what the page was rendered with.
          const latest = await fetchPrInfo(opts.ref);
          return json(res, 200, {
            headSha: latest.headSha,
            updatedAt: latest.updatedAt,
          });
        }
        if (path === "/api/auto-merge") {
          const state = await fetchAutoMerge(opts.ref);
          return json(res, 200, state);
        }
      }

      if (req.method === "POST") {
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
            return json(res, 400, { error: "invalid comment payload" });
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
          return json(res, 200, { ok: true });
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
            return json(res, 400, { error: "invalid event" });
          }
          const reviewId = await ensurePendingReview();
          await submitPendingReview(reviewId, body.event, body.body ?? "");
          await refreshReview();
          return json(res, 200, { ok: true });
        }

        if (path === "/api/disable-auto-merge") {
          await disableAutoMerge(pr.nodeId);
          const state: AutoMergeState = await fetchAutoMerge(opts.ref);
          return json(res, 200, state);
        }

        if (path === "/api/refresh") {
          await refreshAll();
          return json(res, 200, {
            headSha: pr.headSha,
            updatedAt: pr.updatedAt,
          });
        }
      }

      if (
        req.method === "POST" &&
        path.startsWith("/api/comment/") &&
        path.endsWith("/reply")
      ) {
        const idStr = path.slice(
          "/api/comment/".length,
          -"/reply".length,
        );
        const id = Number(idStr);
        if (!Number.isInteger(id) || id <= 0) {
          return json(res, 400, { error: "invalid comment id" });
        }
        const body = (await readJson(req)) as { body?: string };
        const text = (body?.body ?? "").trim();
        if (!text) return json(res, 400, { error: "empty body" });
        // Ensure pending review exists so the reply attaches to it.
        await ensurePendingReview();
        await replyToReviewComment(opts.ref, id, body.body ?? "");
        await refreshReview();
        return json(res, 200, { ok: true });
      }

      if (
        (req.method === "PATCH" || req.method === "DELETE") &&
        path.startsWith("/api/comment/")
      ) {
        const idStr = path.slice("/api/comment/".length);
        const id = Number(idStr);
        if (!Number.isInteger(id) || id <= 0) {
          return json(res, 400, { error: "invalid comment id" });
        }
        const target = comments.find((c) => c.id === id);
        if (!target || !target.nodeId) {
          return json(res, 404, { error: "comment not found" });
        }
        if (req.method === "DELETE") {
          await deleteReviewComment(target.nodeId);
          await refreshReview();
          return json(res, 200, { ok: true });
        }
        const body = (await readJson(req)) as { body?: string };
        const text = (body?.body ?? "").trim();
        if (text === "") {
          await deleteReviewComment(target.nodeId);
        } else {
          await editReviewComment(target.nodeId, body.body ?? "");
        }
        await refreshReview();
        return json(res, 200, { ok: true });
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Surface GitHub API errors to the client for debugging.
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

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c.toString();
      // Cap at ~1 MB to avoid runaway requests.
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
