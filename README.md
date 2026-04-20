# ghreview

A local web UI for reviewing large GitHub pull requests. Spins up a small HTTP server, renders the unified diff in a browser-friendly layout, and shells out to the GitHub CLI for API access.

## Requirements

- Node.js 20+
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated (`gh auth login`)

## Usage

Quick look at one PR:

```sh
npx @tgwizard/ghreview https://github.com/owner/repo/pull/123
```

This starts a local server on port 7766 (override with `--port` or `GHREVIEW_PORT`), fetches PR data via `gh`, and opens the rendered review page in your browser.

### Long-running mode

The server is **multi-PR** and lazy-loads. Leave one instance running in a terminal tab and every subsequent invocation hands off to it without rebinding:

```sh
# Terminal 1 — run once, leave open:
npx @tgwizard/ghreview

# Any other terminal, anytime:
npx @tgwizard/ghreview https://github.com/owner/repo/pull/123
npx @tgwizard/ghreview https://github.com/owner/repo/pull/456
```

The second and third invocations detect the running server (via a sentinel `/__ghreview__` endpoint), just open the browser at the right URL, and exit immediately. New PRs lazy-load on first visit — the tab shows a spinner for the 1–3 s fetch, then the rendered page.

The landing page at [http://127.0.0.1:7766/](http://127.0.0.1:7766/) lists every loaded PR and accepts either a full GitHub URL or a `owner/repo#123` shortcut.

### Bookmarklet

Drag this into your bookmarks bar to open any GitHub PR tab in your local ghreview instead:

```js
javascript:(()=>{const m=location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);if(!m)return alert('Not a GitHub PR page');location.href='http://127.0.0.1:7766/'+m[1]+'/'+m[2]+'/pull/'+m[3]+location.hash;})();
```

Name it something like **"Open in ghreview"**. Click it on any `github.com/…/pull/…` page — it forwards the fragment too, so `#issuecomment-456` or `#discussion_r789` survives the trip and scrolls to the right place.

### Options

```
-p, --port <n>   Port to bind (default: 7766; GHREVIEW_PORT overrides)
    --no-open    Don't open the browser automatically
-h, --help       Show help
-v, --version    Show version
```

### Generated files

Files are collapsed by default when:

- the repo's `.gitattributes` marks them `linguist-generated` / `linguist-generated=true`, **or**
- they match a built-in lock-file list: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock(b)`, `Cargo.lock`, `Gemfile.lock`, `Pipfile.lock`, `poetry.lock`, `uv.lock`, `composer.lock`, `go.sum`, `Podfile.lock`, `packages.lock.json`, `mix.lock`, `flake.lock`, `pubspec.lock`, `Package.resolved`, `npm-shrinkwrap.json`.

A repo's `.gitattributes` can still override either with `-linguist-generated` / `linguist-generated=false`.

### Endpoints

Once running, the server exposes:

- `/` — landing page listing loaded PRs
- `/<owner>/<repo>/pull/<N>` — rendered review UI (lazy-loads on first hit)
- `/<owner>/<repo>/pull/<N>/files` — same (GitHub-style alias)
- `/<owner>/<repo>/pull/<N>.json` — PR metadata as JSON
- `/<owner>/<repo>/pull/<N>.diff` — raw unified diff
- `/__ghreview__` — identity ping (used by the hand-off)

## Try it

Public PRs you can point ghreview at:

| PR | Size | What it exercises |
| --- | --- | --- |
| [`cli/cli#1`](https://github.com/cli/cli/pull/1) | +82, 1 file | Tiny sanity check |
| [`cli/cli#13204`](https://github.com/cli/cli/pull/13204) | +895 / −48, 19 files | Multi-file nav, badges |
| [`kubernetes/kubernetes#126901`](https://github.com/kubernetes/kubernetes/pull/126901) | +1 / −1, 1 file | Generated-file collapse (matches `**/types_swagger_doc_generated.go`) |
| [`kubernetes/kubernetes#132663`](https://github.com/kubernetes/kubernetes/pull/132663) | +19,503 / −3,298, 927 files | Stress test — nearly a thousand files |
| [`kubernetes/kubernetes#138350`](https://github.com/kubernetes/kubernetes/pull/138350) | +38,092, 186 files | Huge single-PR diff |

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
