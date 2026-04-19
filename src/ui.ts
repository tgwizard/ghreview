import parseDiff from "parse-diff";
import type { PrInfo } from "./gh.js";
import type { GeneratedMatcher } from "./gitattributes.js";

const NOOP_MATCHER: GeneratedMatcher = { isGenerated: () => false };

export function renderPage(
  pr: PrInfo,
  rawDiff: string,
  generatedMatcher: GeneratedMatcher = NOOP_MATCHER,
): string {
  const files = parseDiff(rawDiff);
  const generatedFlags = files.map((f) =>
    generatedMatcher.isGenerated(matchablePath(f)),
  );
  const generatedCount = generatedFlags.filter(Boolean).length;

  const fileNav = files
    .map((f, i) => {
      const path = displayPath(f);
      const adds = f.additions ?? 0;
      const dels = f.deletions ?? 0;
      const isGen = generatedFlags[i];
      return `<li class="${isGen ? "is-generated" : ""}"><a href="#file-${i}"><span class="fn-path">${escapeHtml(path)}</span><span class="fn-stats">${isGen ? '<span class="gen-dot" title="generated">●</span> ' : ""}<span class="add">+${adds}</span> <span class="del">-${dels}</span></span></a></li>`;
    })
    .join("");

  const fileSections = files
    .map((f, i) => renderFile(f, i, generatedFlags[i]))
    .join("");

  const generatedBanner =
    generatedCount > 0
      ? `<div class="gen-banner">${generatedCount} generated file${generatedCount === 1 ? "" : "s"} hidden by default (based on <code>.gitattributes</code>). Click a file header to expand.</div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(`#${pr.number} ${pr.title}`)} · ghreview</title>
<style>${STYLES}</style>
</head>
<body>
<header class="pr-header">
  <div class="pr-title-row">
    <span class="pr-state ${pr.state} ${pr.isDraft ? "draft" : ""}">${pr.isDraft ? "Draft" : capitalize(pr.state)}</span>
    <h1><a href="${escapeHtml(pr.url)}" target="_blank" rel="noopener">#${pr.number}</a> ${escapeHtml(pr.title)}</h1>
  </div>
  <div class="pr-meta">
    <span><strong>${escapeHtml(pr.author)}</strong> wants to merge</span>
    <code>${escapeHtml(pr.headRef)}</code>
    <span>→</span>
    <code>${escapeHtml(pr.baseRef)}</code>
    <span class="sep">·</span>
    <span>${pr.changedFiles} files</span>
    <span class="add">+${pr.additions}</span>
    <span class="del">−${pr.deletions}</span>
  </div>
</header>
<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-header">Files changed (${files.length})</div>
    <ul class="file-nav">${fileNav}</ul>
  </aside>
  <main class="content">
    ${generatedBanner}
    ${fileSections || '<div class="empty">No file changes in this PR.</div>'}
  </main>
</div>
</body>
</html>`;
}

function renderFile(
  file: parseDiff.File,
  index: number,
  isGenerated: boolean,
): string {
  const path = displayPath(file);
  const badge = fileBadge(file);
  const chunks = file.chunks.map((c) => renderChunk(c)).join("");
  const body =
    file.chunks.length === 0
      ? '<div class="file-empty">(no textual diff)</div>'
      : `<div class="diff">${chunks}</div>`;

  const header = `<div class="file-header">
    <div class="file-path">
      ${badge}
      ${isGenerated ? '<span class="badge generated">GENERATED</span>' : ""}
      <span>${escapeHtml(path)}</span>
    </div>
    <div class="file-stats">
      ${isGenerated ? '<span class="hint">click to expand</span>' : ""}
      <span class="add">+${file.additions ?? 0}</span>
      <span class="del">−${file.deletions ?? 0}</span>
    </div>
  </div>`;

  if (isGenerated) {
    return `<section class="file is-generated" id="file-${index}">
  <details>
    <summary>${header}</summary>
    ${body}
  </details>
</section>`;
  }

  return `<section class="file" id="file-${index}">
  ${header}
  ${body}
</section>`;
}

function matchablePath(file: parseDiff.File): string {
  const to = file.to && file.to !== "/dev/null" ? file.to : "";
  const from = file.from && file.from !== "/dev/null" ? file.from : "";
  return to || from || "";
}

function renderChunk(chunk: parseDiff.Chunk): string {
  const rows = chunk.changes
    .map((ch) => {
      const cls =
        ch.type === "add" ? "add" : ch.type === "del" ? "del" : "ctx";
      const oldNo = "ln1" in ch ? ch.ln1 : "ln" in ch && ch.type === "del" ? ch.ln : "";
      const newNo = "ln2" in ch ? ch.ln2 : "ln" in ch && ch.type === "add" ? ch.ln : "";
      const marker = ch.type === "add" ? "+" : ch.type === "del" ? "-" : " ";
      // parse-diff includes the leading +/-/space in `content`; strip it.
      const content = ch.content.length > 0 ? ch.content.slice(1) : "";
      return `<tr class="row ${cls}"><td class="ln ln-old">${oldNo ?? ""}</td><td class="ln ln-new">${newNo ?? ""}</td><td class="marker">${marker}</td><td class="code">${escapeHtml(content)}</td></tr>`;
    })
    .join("");

  const header = escapeHtml(chunk.content);
  return `<table class="chunk"><tbody>
  <tr class="hunk-header"><td colspan="4">${header}</td></tr>
  ${rows}
</tbody></table>`;
}

function displayPath(file: parseDiff.File): string {
  const from = file.from && file.from !== "/dev/null" ? file.from : "";
  const to = file.to && file.to !== "/dev/null" ? file.to : "";
  if (from && to && from !== to) return `${from} → ${to}`;
  return to || from || "(unknown)";
}

function fileBadge(file: parseDiff.File): string {
  if (file.new) return `<span class="badge added">ADDED</span>`;
  if (file.deleted) return `<span class="badge deleted">DELETED</span>`;
  if (file.from && file.to && file.from !== file.to)
    return `<span class="badge renamed">RENAMED</span>`;
  return `<span class="badge modified">MODIFIED</span>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const STYLES = `
:root {
  --bg: #0d1117;
  --bg-elev: #161b22;
  --bg-hover: #1f2630;
  --border: #30363d;
  --text: #e6edf3;
  --text-dim: #8b949e;
  --accent: #2f81f7;
  --add-bg: rgba(46, 160, 67, 0.15);
  --add-gutter: rgba(46, 160, 67, 0.4);
  --del-bg: rgba(248, 81, 73, 0.15);
  --del-gutter: rgba(248, 81, 73, 0.4);
  --add-fg: #3fb950;
  --del-fg: #f85149;
  --hunk-bg: #1a2333;
  --hunk-fg: #79c0ff;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; font-size: 14px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; background: var(--bg-elev); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
.pr-header { padding: 16px 24px; border-bottom: 1px solid var(--border); background: var(--bg-elev); position: sticky; top: 0; z-index: 10; }
.pr-title-row { display: flex; align-items: center; gap: 12px; }
.pr-title-row h1 { margin: 0; font-size: 18px; font-weight: 500; }
.pr-title-row h1 a { color: var(--text-dim); margin-right: 8px; font-weight: 400; }
.pr-state { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #238636; color: white; }
.pr-state.closed { background: #8957e5; }
.pr-state.draft { background: #6e7681; }
.pr-meta { margin-top: 8px; display: flex; gap: 8px; color: var(--text-dim); font-size: 13px; align-items: center; flex-wrap: wrap; }
.pr-meta .sep { color: var(--border); }
.add { color: var(--add-fg); }
.del { color: var(--del-fg); }
.layout { display: grid; grid-template-columns: 300px 1fr; min-height: calc(100vh - 80px); }
.sidebar { border-right: 1px solid var(--border); background: var(--bg-elev); overflow-y: auto; position: sticky; top: 80px; height: calc(100vh - 80px); }
.sidebar-header { padding: 12px 16px; font-weight: 600; border-bottom: 1px solid var(--border); color: var(--text-dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.file-nav { list-style: none; margin: 0; padding: 0; }
.file-nav li a { display: flex; justify-content: space-between; gap: 8px; padding: 6px 16px; color: var(--text); font-size: 12px; border-left: 2px solid transparent; }
.file-nav li a:hover { background: var(--bg-hover); text-decoration: none; border-left-color: var(--accent); }
.fn-path { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.fn-stats { flex-shrink: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.content { padding: 16px 24px; max-width: 100%; overflow-x: hidden; }
.file { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 24px; overflow: hidden; background: var(--bg-elev); }
.file-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--bg-elev); position: sticky; top: 80px; z-index: 5; }
.file-path { display: flex; gap: 10px; align-items: center; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.file-stats { font-family: ui-monospace, Menlo, monospace; font-size: 12px; display: flex; gap: 8px; }
.badge { font-size: 10px; font-weight: 700; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 4px; }
.badge.added { background: rgba(46, 160, 67, 0.2); color: var(--add-fg); }
.badge.deleted { background: rgba(248, 81, 73, 0.2); color: var(--del-fg); }
.badge.renamed { background: rgba(47, 129, 247, 0.2); color: var(--accent); }
.badge.modified { background: var(--bg-hover); color: var(--text-dim); }
.badge.generated { background: rgba(139, 148, 158, 0.2); color: var(--text-dim); }
.file.is-generated .file-header { background: var(--bg-hover); }
.file.is-generated summary { list-style: none; cursor: pointer; }
.file.is-generated summary::-webkit-details-marker { display: none; }
.file.is-generated summary .file-header { border-bottom: none; }
.file.is-generated details[open] summary .file-header { border-bottom: 1px solid var(--border); }
.file.is-generated .hint { color: var(--text-dim); font-style: italic; font-size: 11px; }
.file.is-generated details[open] .hint::after { content: " (expanded)"; }
.gen-banner { background: var(--bg-elev); border: 1px solid var(--border); border-left: 3px solid var(--text-dim); padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; color: var(--text-dim); font-size: 13px; }
.gen-banner code { font-size: 11px; }
.file-nav li.is-generated a { color: var(--text-dim); }
.gen-dot { color: var(--text-dim); }
.file-empty { padding: 20px; color: var(--text-dim); text-align: center; font-style: italic; }
.diff { background: var(--bg); overflow-x: auto; }
.chunk { border-collapse: collapse; width: 100%; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; }
.chunk + .chunk { border-top: 1px solid var(--border); }
.hunk-header td { background: var(--hunk-bg); color: var(--hunk-fg); padding: 4px 12px; font-size: 12px; }
.row td { padding: 0; vertical-align: top; }
.row.add { background: var(--add-bg); }
.row.del { background: var(--del-bg); }
.row .ln { width: 1%; min-width: 50px; padding: 0 10px; text-align: right; color: var(--text-dim); user-select: none; border-right: 1px solid var(--border); white-space: nowrap; }
.row.add .ln { background: var(--add-gutter); color: var(--text); }
.row.del .ln { background: var(--del-gutter); color: var(--text); }
.row .marker { width: 14px; padding: 0 4px; color: var(--text-dim); text-align: center; user-select: none; }
.row.add .marker { color: var(--add-fg); }
.row.del .marker { color: var(--del-fg); }
.row .code { padding: 0 8px; white-space: pre; overflow-wrap: normal; word-break: normal; }
.empty { padding: 40px; text-align: center; color: var(--text-dim); }
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { display: none; }
}
`;
