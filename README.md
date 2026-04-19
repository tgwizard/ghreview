# ghreview

A local web UI for reviewing large GitHub pull requests. Spins up a small HTTP server, renders the unified diff in a browser-friendly layout, and shells out to the GitHub CLI for API access.

## Requirements

- Node.js 20+
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated (`gh auth login`)

## Usage

```sh
npx @tgwizard/ghreview https://github.com/owner/repo/pull/123
```

This fetches the PR metadata and unified diff via `gh`, starts a local web server on a random free port (at a path matching GitHub's — e.g. `http://127.0.0.1:PORT/owner/repo/pull/123`), and opens the rendered review page in your default browser.

Files marked `linguist-generated=true` in the repo's `.gitattributes` (at the PR head) are collapsed by default, like GitHub's Files Changed view.

### Options

```
-p, --port <n>   Port to bind (default: random free port)
    --no-open    Don't open the browser automatically
-h, --help       Show help
-v, --version    Show version
```

### Endpoints

Once running, the server exposes:

- `/` → redirects to the PR path
- `/<owner>/<repo>/pull/<N>` — the rendered review UI
- `/<owner>/<repo>/pull/<N>/files` — same (GitHub-style alias)
- `/<owner>/<repo>/pull/<N>.json` — PR metadata as JSON
- `/<owner>/<repo>/pull/<N>.diff` — raw unified diff

## Try it

Public PRs you can point ghreview at:

| PR | Size | What it exercises |
| --- | --- | --- |
| [`cli/cli#1`](https://github.com/cli/cli/pull/1) | +82, 1 file | Tiny sanity check |
| [`cli/cli#13204`](https://github.com/cli/cli/pull/13204) | +895 / −48, 19 files | Multi-file nav, badges |
| [`kubernetes/kubernetes#126901`](https://github.com/kubernetes/kubernetes/pull/126901) | +1 / −1, 1 file | Generated-file collapse (matches `**/types_swagger_doc_generated.go`) |
| [`kubernetes/kubernetes#132663`](https://github.com/kubernetes/kubernetes/pull/132663) | +19,503 / −3,298, 927 files | Stress test — nearly a thousand files |
| [`kubernetes/kubernetes#138350`](https://github.com/kubernetes/kubernetes/pull/138350) | +38,092, 186 files | Huge single-PR diff |

## Status

**v0** — renders the unified diff with file navigation, add/delete line counts, and per-file status badges. Generated files (per `.gitattributes`) collapse by default. Read-only.

### Roadmap

- v1: show existing inline review threads
- v1: write pending inline comments, submit a review (comment / approve / request changes)
- v2: expand nearby context lines, syntax highlighting
- v2: show PR auto-merge status, safety prompts for approval

## Supply-chain security

`npx @tgwizard/ghreview` runs code on your machine, so the install path is hardened against attacks on the package graph.

- **Zero runtime dependencies.** `package.json` declares `"dependencies": {}`. The build step (`esbuild`) inlines every runtime library into a single `dist/cli.js`. No dependency resolution happens at install time, so a compromised new version of `marked` / `sanitize-html` / `highlight.js` / etc. can never ship to you between releases.
- **Reproducible builds.** `devDependencies` are pinned to exact versions, no `^` ranges.
- **Published with provenance.** Releases go out via a GitHub Actions workflow (`.github/workflows/publish.yml`) using `npm publish --provenance`. Each version has a cryptographic attestation linking it to the source commit and the workflow run that built it.

Verify an installed copy:

```sh
npm audit signatures
```

If the provenance check fails, don't run the binary.

For the strictest posture, pin the exact version: `npx @tgwizard/ghreview@X.Y.Z <pr-url>`.

## Development

```sh
npm install
npm run dev -- https://github.com/owner/repo/pull/123
npm run build       # bundles to dist/cli.js
npm run typecheck   # tsc --noEmit
```

## License

MIT
