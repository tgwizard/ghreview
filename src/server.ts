import http from "node:http";
import type { AuthedUser, PrInfo, PrRef } from "./gh.js";
import type { GeneratedMatcher } from "./gitattributes.js";
import type { ThreadIndex } from "./threads.js";
import { renderPage } from "./ui.js";

export interface ServerOptions {
  ref: PrRef;
  pr: PrInfo;
  diff: string;
  authedUser: AuthedUser | null;
  generatedMatcher: GeneratedMatcher;
  threadIndex: ThreadIndex;
  port?: number;
}

export interface RunningServer {
  baseUrl: string;
  prUrl: string;
  close: () => Promise<void>;
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const prPath = `/${encodeURIComponent(opts.ref.owner)}/${encodeURIComponent(opts.ref.repo)}/pull/${opts.ref.number}`;
  const filesPath = `${prPath}/files`;

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end("Method not allowed");
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(302, { location: prPath });
        res.end();
        return;
      }

      if (url.pathname === prPath || url.pathname === filesPath) {
        const html = renderPage(
          opts.pr,
          opts.diff,
          opts.generatedMatcher,
          opts.authedUser,
          opts.threadIndex,
        );
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(html);
        return;
      }

      if (url.pathname === `${prPath}.diff` || url.pathname === "/raw.diff") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(opts.diff);
        return;
      }

      if (url.pathname === `${prPath}.json` || url.pathname === "/pr.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(opts.pr, null, 2));
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`Internal error: ${message}`);
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
            // Drop live keep-alive connections so close() actually returns.
            server.closeAllConnections();
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
