import open from "open";
import { parsePrUrl } from "./gh.js";
import { IDENTITY_PATH, startServer } from "./server.js";

const DEFAULT_PORT = 7766;

interface Args {
  prUrl: string | null;
  port: number;
  noOpen: boolean;
}

function parseArgs(argv: string[]): Args {
  let port = DEFAULT_PORT;
  const envPort = process.env.GHREVIEW_PORT;
  if (envPort) {
    const n = Number(envPort);
    if (Number.isInteger(n) && n > 0 && n <= 65535) port = n;
  }
  const args: Partial<Args> = { noOpen: false, port };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a === "--version" || a === "-v") {
      printVersion();
      process.exit(0);
    } else if (a === "--no-open") {
      args.noOpen = true;
    } else if (a === "--port" || a === "-p") {
      const next = argv[++i];
      if (!next) throw new Error("--port requires a value");
      const n = Number(next);
      if (!Number.isInteger(n) || n < 0 || n > 65535)
        throw new Error(`Invalid port: ${next}`);
      args.port = n;
    } else if (a.startsWith("--port=")) {
      const n = Number(a.slice("--port=".length));
      if (!Number.isInteger(n) || n < 0 || n > 65535)
        throw new Error(`Invalid port: ${a}`);
      args.port = n;
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) {
    throw new Error(`Too many arguments. Expected one PR URL or none.`);
  }
  return {
    prUrl: positional[0] ?? null,
    port: args.port ?? DEFAULT_PORT,
    noOpen: args.noOpen ?? false,
  };
}

function printHelp() {
  process.stdout.write(
    `ghreview — review large GitHub PRs in a local web UI.

Usage:
  ghreview [pr-url] [options]

The first invocation starts a local server that can serve any PR on demand.
Subsequent invocations detect the running server and just open the browser
against it, so you can leave ghreview running in one terminal tab and invoke
ghreview repeatedly from others without restarting.

Arguments:
  [pr-url]         GitHub PR URL, e.g. https://github.com/owner/repo/pull/123.
                   Omit to launch the empty index page.

Options:
  -p, --port <n>   Port to bind (default: 7766; GHREVIEW_PORT overrides)
      --no-open    Don't open the browser automatically
  -h, --help       Show this help
  -v, --version    Show version

Requires the GitHub CLI (gh) installed and authenticated.
`,
  );
}

declare const __GHREVIEW_VERSION__: string | undefined;

function printVersion() {
  const v =
    typeof __GHREVIEW_VERSION__ !== "undefined" ? __GHREVIEW_VERSION__ : "dev";
  process.stdout.write(`ghreview ${v}\n`);
}

async function pingRunning(port: number): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 400);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${IDENTITY_PATH}`, {
      signal: ac.signal,
    });
    if (!r.ok) return false;
    const data = (await r.json()) as { product?: string };
    return data?.product === "ghreview";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function targetUrl(port: number, input: string): string {
  // Keep the user's original fragment so #issuecomment-... etc. still work.
  const hashIdx = input.indexOf("#");
  const hash = hashIdx >= 0 ? input.slice(hashIdx) : "";
  const ref = parsePrUrl(input);
  const path = `/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pull/${ref.number}`;
  return `http://127.0.0.1:${port}${path}${hash}`;
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }

  // If an existing ghreview is already serving on the port, hand off to it
  // instead of fighting for the bind.
  if (await pingRunning(args.port)) {
    if (args.prUrl) {
      const url = targetUrl(args.port, args.prUrl);
      process.stdout.write(
        `An existing ghreview is running at http://127.0.0.1:${args.port}\nOpening ${url}\n`,
      );
      if (!args.noOpen) open(url).catch(() => {});
    } else {
      const url = `http://127.0.0.1:${args.port}/`;
      process.stdout.write(
        `An existing ghreview is running at ${url}\n`,
      );
      if (!args.noOpen) open(url).catch(() => {});
    }
    return;
  }

  const preload = args.prUrl ? parsePrUrl(args.prUrl) : undefined;
  const server = await startServer({ port: args.port, preload });

  const hash = args.prUrl ? extractHash(args.prUrl) : "";
  const openUrl = preload
    ? server.urlFor(preload) + hash
    : server.baseUrl + "/";

  process.stdout.write(`Serving at ${server.baseUrl}\n`);
  if (preload) {
    process.stdout.write(`  → ${openUrl}\n`);
  } else {
    process.stdout.write(`  (no PR preloaded — visit the URL to pick one)\n`);
  }
  process.stdout.write(`Press Ctrl+C to stop.\n`);

  if (!args.noOpen) {
    open(openUrl).catch(() => {});
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) process.exit(130);
    shuttingDown = true;
    const timer = setTimeout(() => process.exit(130), 1500);
    timer.unref();
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function extractHash(input: string): string {
  const i = input.indexOf("#");
  return i >= 0 ? input.slice(i) : "";
}

main().catch((err) => {
  process.stderr.write(
    `\nError: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
