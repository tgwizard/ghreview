#!/usr/bin/env node
import open from "open";
import {
  fetchAuthedUser,
  fetchFileAtRef,
  fetchPrDiff,
  fetchPrInfo,
  fetchReviewComments,
  parsePrUrl,
} from "./gh.js";
import { buildGeneratedMatcher } from "./gitattributes.js";
import { startServer } from "./server.js";
import { buildThreadIndex } from "./threads.js";

interface Args {
  prUrl: string;
  port?: number;
  noOpen: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { noOpen: false };
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
  if (positional.length === 0) {
    printHelp();
    process.exit(1);
  }
  if (positional.length > 1) {
    throw new Error(`Too many arguments. Expected one PR URL.`);
  }
  return {
    prUrl: positional[0],
    port: args.port,
    noOpen: args.noOpen ?? false,
  };
}

function printHelp() {
  process.stdout.write(
    `ghreview — review large GitHub PRs in a local web UI.

Usage:
  ghreview <pr-url> [options]

Arguments:
  <pr-url>       GitHub PR URL, e.g. https://github.com/owner/repo/pull/123

Options:
  -p, --port <n>   Port to bind (default: random free port)
      --no-open    Don't open the browser automatically
  -h, --help       Show this help
  -v, --version    Show version

Requires the GitHub CLI (gh) installed and authenticated.
`,
  );
}

function printVersion() {
  process.stdout.write("ghreview 0.0.1\n");
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

  const ref = parsePrUrl(args.prUrl);
  process.stdout.write(
    `Fetching ${ref.owner}/${ref.repo}#${ref.number} via gh…\n`,
  );

  // Only .gitattributes needs pr.headSha — everything else runs in parallel.
  const [pr, authedUser, reviewComments, diff] = await Promise.all([
    fetchPrInfo(ref),
    fetchAuthedUser(),
    fetchReviewComments(ref),
    fetchPrDiff(ref),
  ]);
  const gitattributes = await fetchFileAtRef(
    ref,
    ".gitattributes",
    pr.headSha,
  );
  const generatedMatcher = buildGeneratedMatcher(gitattributes);
  const threadIndex = buildThreadIndex(reviewComments);

  const server = await startServer({
    ref,
    pr,
    diff,
    authedUser,
    generatedMatcher,
    threadIndex,
    port: args.port,
  });
  process.stdout.write(`\n  ${pr.title}\n`);
  process.stdout.write(
    `  +${pr.additions} −${pr.deletions} across ${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"}\n`,
  );
  process.stdout.write(
    `  ${threadIndex.all.length} review thread${threadIndex.all.length === 1 ? "" : "s"}\n`,
  );
  process.stdout.write(`\nServing at ${server.prUrl}\n`);
  process.stdout.write(`Press Ctrl+C to stop.\n`);

  if (!args.noOpen) {
    try {
      await open(server.prUrl);
    } catch {
      // Non-fatal; URL is still printed.
    }
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      // Second signal: bail out hard.
      process.exit(130);
    }
    shuttingDown = true;
    // Hard-exit fallback in case something else pins the event loop.
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

main().catch((err) => {
  process.stderr.write(
    `\nError: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
