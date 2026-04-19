import parseDiff from "parse-diff";
import type { AuthedUser, PrInfo, ReviewComment } from "./gh.js";
import type { GeneratedMatcher } from "./gitattributes.js";
import { renderMarkdown } from "./markdown.js";
import type { Thread, ThreadIndex } from "./threads.js";

const NOOP_MATCHER: GeneratedMatcher = { isGenerated: () => false };
const EMPTY_INDEX: ThreadIndex = { all: [], getAt: () => [] };

interface RenderContext {
  prUrl: string;
  threadIndex: ThreadIndex;
}

export function renderPage(
  pr: PrInfo,
  rawDiff: string,
  generatedMatcher: GeneratedMatcher = NOOP_MATCHER,
  authedUser: AuthedUser | null = null,
  threadIndex: ThreadIndex = EMPTY_INDEX,
): string {
  const files = parseDiff(rawDiff);
  const fileInfos = files.map((f, i) => {
    const mPath = matchablePath(f);
    return {
      file: f,
      index: i,
      matchPath: mPath,
      isGenerated: generatedMatcher.isGenerated(mPath),
    };
  });
  const generatedCount = fileInfos.filter((fi) => fi.isGenerated).length;

  const threadsByFile = new Map<string, Thread[]>();
  for (const t of threadIndex.all) {
    const list = threadsByFile.get(t.path) ?? [];
    list.push(t);
    threadsByFile.set(t.path, list);
  }

  const ctx: RenderContext = { prUrl: pr.url, threadIndex };

  const fileNav = fileInfos
    .map(({ file, index, matchPath, isGenerated }) => {
      const path = displayPath(file);
      const adds = file.additions ?? 0;
      const dels = file.deletions ?? 0;
      const threadCount = threadsByFile.get(matchPath)?.length ?? 0;
      const threadBadge =
        threadCount > 0
          ? `<span class="fn-threads" title="${threadCount} thread${threadCount === 1 ? "" : "s"}">💬 ${threadCount}</span> `
          : "";
      return `<li class="${isGenerated ? "is-generated" : ""}"><a href="#file-${index}"><span class="fn-path">${escapeHtml(path)}</span><span class="fn-stats">${threadBadge}${isGenerated ? '<span class="gen-dot" title="generated">●</span> ' : ""}<span class="add">+${adds}</span> <span class="del">-${dels}</span></span></a></li>`;
    })
    .join("");

  const fileSections = fileInfos
    .map(({ file, index, matchPath, isGenerated }) =>
      renderFile(
        file,
        index,
        isGenerated,
        threadsByFile.get(matchPath) ?? [],
        ctx,
      ),
    )
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
    <div class="pr-header-right">${renderAuthChip(authedUser)}</div>
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
  threadsForFile: Thread[],
  ctx: RenderContext,
): string {
  const path = displayPath(file);
  const mPath = matchablePath(file);
  const badge = fileBadge(file);

  const placedIds = new Set<number>();
  const chunks = file.chunks
    .map((c) => renderChunk(c, mPath, placedIds, ctx))
    .join("");

  const unplaced = threadsForFile.filter((t) => !placedIds.has(t.id));
  const unplacedBlock =
    unplaced.length > 0
      ? `<div class="outdated-threads">
        <div class="outdated-threads__header">${unplaced.length} outdated thread${unplaced.length === 1 ? "" : "s"} on this file</div>
        ${unplaced.map((t) => renderThread(t, ctx)).join("")}
      </div>`
      : "";

  const diffBody =
    file.chunks.length === 0
      ? '<div class="file-empty">(no textual diff)</div>'
      : `<div class="diff">${chunks}</div>`;
  const body = `${diffBody}${unplacedBlock}`;

  const threadCount = threadsForFile.length;
  const threadBadge =
    threadCount > 0
      ? `<span class="file-thread-count" title="${threadCount} thread${threadCount === 1 ? "" : "s"}">💬 ${threadCount}</span>`
      : "";

  const header = `<div class="file-header">
    <div class="file-path">
      ${badge}
      ${isGenerated ? '<span class="badge generated">GENERATED</span>' : ""}
      <span>${escapeHtml(path)}</span>
      ${threadBadge}
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

function renderAuthChip(user: AuthedUser | null): string {
  if (!user) {
    return `<span class="auth-chip auth-chip--none" title="Not signed in to GitHub CLI">not signed in</span>`;
  }
  return `<a class="auth-chip" href="${userProfileUrl(user.login)}" target="_blank" rel="noopener" title="Signed in to gh CLI as ${escapeHtml(user.login)}">
    ${avatarImg(user.avatarUrl, "auth-avatar")}
    <span class="auth-chip__meta">
      <span class="auth-chip__label">reviewing as</span>
      <span class="auth-chip__login">${escapeHtml(user.login)}</span>
    </span>
  </a>`;
}

function avatarImg(url: string, className: string): string {
  if (!url) return `<span class="${className} ${className}--none"></span>`;
  // GitHub avatar URLs always include a query string; append s=40 for the
  // ~2x-retina pixel size our 22–28 px slots need.
  const sep = url.includes("?") ? "&" : "?";
  return `<img class="${className}" src="${escapeHtml(url + sep + "s=40")}" alt="" />`;
}

function userProfileUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`;
}

function matchablePath(file: parseDiff.File): string {
  const to = file.to && file.to !== "/dev/null" ? file.to : "";
  const from = file.from && file.from !== "/dev/null" ? file.from : "";
  return to || from || "";
}

function renderChunk(
  chunk: parseDiff.Chunk,
  path: string,
  placedIds: Set<number>,
  ctx: RenderContext,
): string {
  const rows = chunk.changes
    .map((ch) => {
      const cls =
        ch.type === "add" ? "add" : ch.type === "del" ? "del" : "ctx";
      const oldNo =
        "ln1" in ch ? ch.ln1 : "ln" in ch && ch.type === "del" ? ch.ln : null;
      const newNo =
        "ln2" in ch ? ch.ln2 : "ln" in ch && ch.type === "add" ? ch.ln : null;
      const marker = ch.type === "add" ? "+" : ch.type === "del" ? "-" : " ";
      const content = ch.content.length > 0 ? ch.content.slice(1) : "";
      const row = `<tr class="row ${cls}"><td class="ln ln-old">${oldNo ?? ""}</td><td class="ln ln-new">${newNo ?? ""}</td><td class="marker">${marker}</td><td class="code">${escapeHtml(content)}</td></tr>`;

      const threads: Thread[] = [];
      const seen = new Set<number>();
      const pick = (side: "LEFT" | "RIGHT", line: number | null) => {
        if (line == null) return;
        for (const t of ctx.threadIndex.getAt(path, side, line)) {
          if (seen.has(t.id) || placedIds.has(t.id)) continue;
          seen.add(t.id);
          placedIds.add(t.id);
          threads.push(t);
        }
      };
      if (ch.type === "add") pick("RIGHT", newNo);
      else if (ch.type === "del") pick("LEFT", oldNo);
      else {
        pick("RIGHT", newNo);
        pick("LEFT", oldNo);
      }
      const threadRows = threads
        .map(
          (t) =>
            `<tr class="thread-row"><td colspan="4">${renderThread(t, ctx)}</td></tr>`,
        )
        .join("");

      return row + threadRows;
    })
    .join("");

  const header = escapeHtml(chunk.content);
  return `<table class="chunk"><tbody>
  <tr class="hunk-header"><td colspan="4">${header}</td></tr>
  ${rows}
</tbody></table>`;
}

function renderThread(thread: Thread, ctx: RenderContext): string {
  const comments = [thread.root, ...thread.replies];
  const commentsHtml = comments.map((c) => renderComment(c)).join("");
  const outdatedBadge = thread.isOutdated
    ? '<span class="thread-pill outdated">Outdated</span>'
    : "";
  const locationHint =
    thread.isOutdated && thread.line != null
      ? `<span class="thread-loc">was ${thread.side === "LEFT" ? "old" : "new"} line ${thread.line}</span>`
      : "";
  const replyCount = thread.replies.length;
  const replyHint =
    replyCount > 0
      ? `<span class="thread-pill">${replyCount} repl${replyCount === 1 ? "y" : "ies"}</span>`
      : "";
  // `<pr-url>/files#r<id>` lands on the diff view with the thread anchored,
  // not the conversation timeline (which is what html_url from the API gives).
  const filesUrl = `${ctx.prUrl}/files#r${thread.root.id}`;
  return `<div class="thread">
    <div class="thread-header">
      ${outdatedBadge}
      ${replyHint}
      ${locationHint}
      <a class="thread-link" href="${escapeHtml(filesUrl)}" target="_blank" rel="noopener" title="Open on GitHub Files Changed">↗</a>
    </div>
    ${commentsHtml}
  </div>`;
}

function renderComment(c: ReviewComment): string {
  const edited =
    c.updatedAt && c.updatedAt !== c.createdAt
      ? ` <span class="comment-edited" title="edited ${escapeHtml(c.updatedAt)}">(edited)</span>`
      : "";
  return `<article class="comment">
    ${avatarImg(c.userAvatarUrl, "comment-avatar")}
    <div class="comment-body">
      <div class="comment-meta">
        <a class="comment-author" href="${userProfileUrl(c.userLogin)}" target="_blank" rel="noopener">${escapeHtml(c.userLogin)}</a>
        <span class="comment-time" title="${escapeHtml(c.createdAt)}">${formatTime(c.createdAt)}</span>
        ${edited}
      </div>
      <div class="comment-md">${renderMarkdown(c.body)}</div>
    </div>
  </article>`;
}

function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diffMs = now - d.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toISOString().slice(0, 10);
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
.pr-title-row h1 { margin: 0; font-size: 18px; font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-header-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.auth-chip { display: inline-flex; align-items: center; gap: 8px; padding: 3px 10px 3px 3px; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 12px; text-decoration: none; }
.auth-chip:hover { background: var(--bg-hover); text-decoration: none; border-color: var(--accent); }
.auth-chip--none { padding: 4px 10px; background: transparent; color: var(--text-dim); cursor: default; }
.auth-avatar { width: 22px; height: 22px; border-radius: 50%; display: block; }
.auth-chip__meta { display: flex; flex-direction: column; line-height: 1.1; }
.auth-chip__label { color: var(--text-dim); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.auth-chip__login { font-weight: 600; }
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
.fn-threads { color: var(--accent); margin-right: 6px; }
.file-thread-count { color: var(--accent); font-size: 12px; margin-left: 4px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
.outdated-threads { border-top: 1px solid var(--border); background: var(--bg-elev); padding: 10px 14px; }
.outdated-threads__header { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; }
.thread-row td { padding: 8px 12px 8px 60px; background: var(--bg); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.thread { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px; padding: 0; margin: 4px 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
.thread-header { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--border); background: var(--bg-hover); border-radius: 6px 6px 0 0; font-size: 12px; }
.thread-pill { background: var(--bg); border: 1px solid var(--border); color: var(--text-dim); padding: 1px 8px; border-radius: 999px; font-size: 11px; }
.thread-pill.outdated { background: rgba(210, 153, 34, 0.15); color: #d29922; border-color: rgba(210, 153, 34, 0.4); }
.thread-loc { color: var(--text-dim); font-size: 11px; }
.thread-link { margin-left: auto; color: var(--text-dim); text-decoration: none; font-size: 14px; }
.thread-link:hover { color: var(--accent); }
.comment { display: grid; grid-template-columns: 28px 1fr; gap: 10px; padding: 10px 12px; border-top: 1px solid var(--border); }
.comment:first-of-type { border-top: none; }
.comment-avatar { width: 28px; height: 28px; border-radius: 50%; display: block; }
.comment-avatar--none { background: var(--bg-hover); }
.comment-body { min-width: 0; }
.comment-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; font-size: 12px; }
.comment-author { color: var(--text); font-weight: 600; }
.comment-time { color: var(--text-dim); font-size: 11px; }
.comment-edited { color: var(--text-dim); font-size: 11px; font-style: italic; }
.comment-md { font-size: 13px; line-height: 1.5; color: var(--text); word-wrap: break-word; }
.comment-md p { margin: 0 0 8px; }
.comment-md p:last-child { margin-bottom: 0; }
.comment-md code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: var(--bg); padding: 1px 5px; border-radius: 3px; }
.comment-md pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; overflow-x: auto; margin: 8px 0; }
.comment-md pre code { background: transparent; padding: 0; font-size: 12px; line-height: 1.45; }
.comment-md blockquote { margin: 0 0 8px; padding-left: 12px; border-left: 3px solid var(--border); color: var(--text-dim); }
.comment-md ul, .comment-md ol { margin: 0 0 8px; padding-left: 22px; }
.comment-md img { max-width: 100%; border-radius: 4px; }
.comment-md a { color: var(--accent); }
.comment-md table { border-collapse: collapse; margin: 8px 0; }
.comment-md th, .comment-md td { border: 1px solid var(--border); padding: 4px 8px; }
.comment-md hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
.comment-md h1, .comment-md h2, .comment-md h3, .comment-md h4 { margin: 8px 0 4px; font-weight: 600; }
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
