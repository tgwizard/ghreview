import open from "open";
import {
  fetchAuthedUser,
  fetchChecksRollup,
  fetchFileAtRef,
  fetchIssueComments,
  fetchPrCommits,
  fetchPrDiff,
  fetchPrInfo,
  loadReviewState,
  parsePrUrl,
} from "./gh.js";
import { pluralize } from "./html.js";
import { buildGeneratedMatcher } from "./gitattributes.js";
import { startServer } from "./server.js";

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

declare const __GHREVIEW_VERSION__: string | undefined;

function printVersion() {
  const v =
    typeof __GHREVIEW_VERSION__ !== "undefined" ? __GHREVIEW_VERSION__ : "dev";
  process.stdout.write(`ghreview ${v}\n`);
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

  // Kick off the fetches in the background and boot the server against the
  // pending promise. The browser can open immediately and will show a
  // placeholder that auto-reloads once the data is in.
  const ready = (async () => {
    const [pr, authedUser, reviewState, issueComments, checks, commits, diff] =
      await Promise.all([
        fetchPrInfo(ref),
        fetchAuthedUser(),
        loadReviewState(ref),
        fetchIssueComments(ref),
        fetchChecksRollup(ref),
        fetchPrCommits(ref),
        fetchPrDiff(ref),
      ]);
    const gitattributes = await fetchFileAtRef(
      ref,
      ".gitattributes",
      pr.headSha,
    );
    const generatedMatcher = buildGeneratedMatcher(gitattributes);
    process.stdout.write(`\n  ${pr.title}\n`);
    process.stdout.write(
      `  +${pr.additions} −${pr.deletions} across ${pluralize(pr.changedFiles, "file")}\n`,
    );
    if (reviewState.pendingReview) {
      process.stdout.write(
        `  pending review with ${pluralize(reviewState.pendingCommentIds.size, "comment")}\n`,
      );
    }
    return {
      pr,
      diff,
      authedUser,
      generatedMatcher,
      reviewState,
      issueComments,
      checks,
      commits,
    };
  })();

  const server = await startServer({ ref, ready, port: args.port });
  // Preserve any fragment from the input URL (e.g. #issuecomment-123 or
  // #discussion_r456) so deep-link targets work when the client script
  // translates them into local scroll targets.
  const hashIdx = args.prUrl.indexOf("#");
  const hash = hashIdx >= 0 ? args.prUrl.slice(hashIdx) : "";
  const openUrl = server.prUrl + hash;
  process.stdout.write(`\nServing at ${openUrl}\n`);
  process.stdout.write(`Press Ctrl+C to stop.\n`);

  if (!args.noOpen) {
    open(openUrl).catch(() => {
      // Non-fatal; URL is still printed.
    });
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
