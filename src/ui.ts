import parseDiff from "parse-diff";
import type {
  AuthedUser,
  DiffSide,
  IssueComment,
  PendingReview,
  PrInfo,
  ReviewComment,
} from "./gh.js";
import type { GeneratedMatcher } from "./gitattributes.js";
import { detectLanguage, highlightLine } from "./highlight.js";
import { escapeHtml, pluralize } from "./html.js";
import { renderMarkdown } from "./markdown.js";
import type { Thread, ThreadIndex } from "./threads.js";

const NOOP_MATCHER: GeneratedMatcher = { isGenerated: () => false };
const EMPTY_INDEX: ThreadIndex = { all: [], getAt: () => [] };

interface RenderContext {
  prUrl: string;
  threadIndex: ThreadIndex;
  pendingCommentIds: Set<number>;
}

interface FileInfo {
  file: parseDiff.File;
  index: number;
  matchPath: string;
  isGenerated: boolean;
}

type TreeNode = TreeFile | TreeDir;
interface TreeFile {
  kind: "file";
  name: string;
  info: FileInfo;
}
interface TreeDir {
  kind: "dir";
  name: string;
  children: TreeNode[];
}

export function renderPage(
  pr: PrInfo,
  rawDiff: string,
  generatedMatcher: GeneratedMatcher = NOOP_MATCHER,
  authedUser: AuthedUser | null = null,
  threadIndex: ThreadIndex = EMPTY_INDEX,
  pendingReview: PendingReview | null = null,
  pendingCommentIds: Set<number> = new Set(),
  issueComments: IssueComment[] = [],
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

  const threadsByFile = new Map<string, Thread[]>();
  for (const t of threadIndex.all) {
    const list = threadsByFile.get(t.path) ?? [];
    list.push(t);
    threadsByFile.set(t.path, list);
  }

  const pendingCount = pendingCommentIds.size;
  const ctx: RenderContext = {
    prUrl: pr.url,
    threadIndex,
    pendingCommentIds,
  };

  const fileTree = renderFileTree(
    buildFileTree(fileInfos),
    threadsByFile,
  );

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

  // pr.url is `https://github.com/<owner>/<repo>/pull/<n>` — derive the
  // repo slug + repo homepage URL so both the browser tab title and the
  // page heading can surface them.
  const repoMatch = pr.url.match(/^(https?:\/\/[^/]+\/([^/]+\/[^/]+))\/pull\//);
  const repoUrl = repoMatch?.[1] ?? "";
  const repoSlug = repoMatch?.[2] ?? "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(`${repoSlug}#${pr.number} ${pr.title}`)} · ghreview</title>
<style>${STYLES}</style>
</head>
<body>
<header class="pr-header">
  <div class="pr-title-row">
    <span class="pr-state ${pr.state} ${pr.isDraft ? "draft" : ""}">${pr.isDraft ? "Draft" : capitalize(pr.state)}</span>
    <h1>
      ${repoSlug ? `<a class="pr-repo" href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener">${escapeHtml(repoSlug)}</a>` : ""}
      <a class="pr-number" href="${escapeHtml(pr.url)}" target="_blank" rel="noopener">#${pr.number}</a>
      <span class="pr-title-text">${escapeHtml(pr.title)}</span>
    </h1>
    <div class="pr-header-right">
      <button type="button" class="btn refresh-btn" data-action="refresh" title="Re-fetch the PR state from GitHub" data-initial-head-sha="${escapeHtml(pr.headSha)}" data-initial-updated-at="${escapeHtml(pr.updatedAt)}">
        <span class="refresh-icon" aria-hidden="true">⟳</span>
        <span class="refresh-label">Refresh</span>
      </button>
      <button type="button" class="btn primary" data-action="open-submit" title="Open the submit review modal">
        Submit review${pendingCount > 0 ? ` <span class="btn-count">${pendingCount}</span>` : ""}
      </button>
      ${renderAuthChip(authedUser)}
    </div>
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
<nav class="tabs" role="tablist">
  <button type="button" class="tab" role="tab" data-tab="conversation">
    Conversation${issueComments.length > 0 ? ` <span class="tab-count">${issueComments.length}</span>` : ""}
  </button>
  <button type="button" class="tab active" role="tab" data-tab="files">
    Files <span class="tab-count">${files.length}</span>
  </button>
</nav>
<section class="tab-panel" data-panel="conversation" hidden>
  ${renderConversationPanel(pr, issueComments)}
</section>
<section class="tab-panel" data-panel="files">
  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-header">Files changed (${files.length})</div>
      <nav class="file-tree">${fileTree}</nav>
      <div class="sidebar-resize-handle" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" tabindex="0"></div>
    </aside>
    <main class="content">
      ${fileSections || '<div class="empty">No file changes in this PR.</div>'}
    </main>
  </div>
</section>
${renderSubmitModal(pendingReview, pendingCount, collectPendingComments(threadIndex, pendingCommentIds))}
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

interface PendingCommentPlacement {
  comment: ReviewComment;
  path: string;
  line: number | null;
  isOutdated: boolean;
}

function collectPendingComments(
  threadIndex: ThreadIndex,
  pendingCommentIds: Set<number>,
): PendingCommentPlacement[] {
  const out: PendingCommentPlacement[] = [];
  for (const t of threadIndex.all) {
    const emit = (c: ReviewComment) => {
      if (!pendingCommentIds.has(c.id)) return;
      out.push({
        comment: c,
        path: t.path,
        line: t.line,
        isOutdated: t.isOutdated,
      });
    };
    emit(t.root);
    for (const r of t.replies) emit(r);
  }
  out.sort((a, b) => {
    const byPath = a.path.localeCompare(b.path);
    if (byPath !== 0) return byPath;
    return (a.line ?? 0) - (b.line ?? 0);
  });
  return out;
}

function renderPendingCommentList(items: PendingCommentPlacement[]): string {
  if (items.length === 0) {
    return `<div class="modal-pending-empty">No pending comments yet. Hover a diff line and click the + to leave one.</div>`;
  }
  return `<ul class="modal-pending-list">${items
    .map((it) => {
      const loc = it.line != null ? `line ${it.line}` : "outdated";
      const outdatedTag = it.isOutdated
        ? ' <span class="thread-pill outdated">Outdated</span>'
        : "";
      const snippet = truncate(it.comment.body || "", 160);
      return `<li class="modal-pending-item">
        <div class="modal-pending-item-header">
          <code class="modal-pending-path" title="${escapeHtml(it.path)}">${escapeHtml(it.path)}</code>
          <span class="modal-pending-loc">${loc}</span>${outdatedTag}
          <button type="button" class="comment-link-btn" data-action="go-to-comment" data-comment-id="${it.comment.id}">Go to →</button>
        </div>
        <div class="modal-pending-body">${escapeHtml(snippet)}</div>
      </li>`;
    })
    .join("")}</ul>`;
}

function truncate(s: string, max: number): string {
  const cleaned = s.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}

function renderSubmitModal(
  pendingReview: PendingReview | null,
  pendingCount: number,
  pendingItems: PendingCommentPlacement[],
): string {
  const initialBody = pendingReview?.body ?? "";
  return `<div class="modal" id="submit-modal" hidden>
  <div class="modal-backdrop" data-action="close-modal"></div>
  <div class="modal-panel" role="dialog" aria-labelledby="submit-modal-title">
    <div class="modal-header">
      <h2 id="submit-modal-title">Submit review</h2>
      <button type="button" class="modal-close" data-action="close-modal" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="modal-status">
        <span class="modal-pending-count">${pluralize(pendingCount, "pending comment")}</span>
      </div>
      ${renderPendingCommentList(pendingItems)}
      <label class="modal-label" for="submit-review-body">Overall review</label>
      <textarea id="submit-review-body" class="modal-textarea" rows="5" placeholder="Leave a short summary (optional)">${escapeHtml(initialBody)}</textarea>
      <fieldset class="modal-fieldset">
        <legend class="modal-label">Action</legend>
        <label class="modal-radio"><input type="radio" name="submit-event" value="COMMENT" checked /> Comment <span class="modal-radio-hint">No approval signal.</span></label>
        <label class="modal-radio"><input type="radio" name="submit-event" value="APPROVE" /> Approve <span class="modal-radio-hint">Agree to merge.</span></label>
        <label class="modal-radio"><input type="radio" name="submit-event" value="REQUEST_CHANGES" /> Request changes <span class="modal-radio-hint">Blocks merge until resolved.</span></label>
      </fieldset>
      <div class="auto-merge-panel" id="auto-merge-panel">
        <div class="auto-merge-status">Checking auto-merge…</div>
      </div>
      <div class="modal-error" id="submit-error" hidden></div>
    </div>
    <div class="modal-footer">
      <button type="button" class="btn" data-action="close-modal">Cancel</button>
      <button type="button" class="btn primary" data-action="submit-review">Submit</button>
    </div>
  </div>
</div>`;
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
  const language = detectLanguage(mPath);
  // Expansion fetches the new-side file, so it needs a valid file.to.
  // Deleted files have file.to = /dev/null — skip those. Added files keep
  // expansion enabled: GitHub caps /pulls/N/files patches at 3MB, so a big
  // new file may have more content beyond what the diff shows.
  const expandPath = file.to && file.to !== "/dev/null" ? file.to : "";
  const canExpand = Boolean(expandPath);
  const chunks = file.chunks
    .map((c, i) => {
      const prev = i > 0 ? file.chunks[i - 1] : null;
      const expandUp = canExpand
        ? renderExpandRow("up", c, prev, expandPath)
        : "";
      return expandUp + renderChunk(c, mPath, placedIds, ctx, language);
    })
    .join("");
  const expandDown =
    canExpand && file.chunks.length > 0
      ? renderExpandRow(
          "down",
          file.chunks[file.chunks.length - 1],
          null,
          expandPath,
        )
      : "";

  const unplaced = threadsForFile.filter((t) => !placedIds.has(t.id));
  const unplacedBlock =
    unplaced.length > 0
      ? `<div class="outdated-threads">
        <div class="outdated-threads__header">${pluralize(unplaced.length, "outdated thread")} on this file</div>
        ${unplaced.map((t) => renderThread(t, ctx)).join("")}
      </div>`
      : "";

  const diffBody =
    file.chunks.length === 0
      ? '<div class="file-empty">(no textual diff)</div>'
      : `<div class="diff">${chunks}${expandDown}</div>`;
  const body = `${unplacedBlock}${diffBody}`;

  const threadCount = threadsForFile.length;
  const threadBadge =
    threadCount > 0
      ? `<span class="file-thread-count" title="${pluralize(threadCount, "thread")}">💬 ${threadCount}</span>`
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

function renderConversationPanel(
  pr: PrInfo,
  comments: IssueComment[],
): string {
  const descBody = pr.body?.trim()
    ? renderMarkdown(pr.body)
    : `<p class="conversation-empty">No description.</p>`;
  const description = `<article class="conv-item conv-description">
    <div class="comment-meta">
      <a class="comment-author" href="${userProfileUrl(pr.author)}" target="_blank" rel="noopener">${escapeHtml(pr.author)}</a>
      <span class="conv-item-kind">opened this pull request</span>
    </div>
    <div class="comment-md">${descBody}</div>
  </article>`;

  const items = comments
    .map((c) => {
      const edited =
        c.updatedAt && c.updatedAt !== c.createdAt
          ? ` <span class="comment-edited" title="edited ${escapeHtml(c.updatedAt)}">(edited)</span>`
          : "";
      return `<article class="conv-item">
        ${avatarImg(c.userAvatarUrl, "comment-avatar")}
        <div class="conv-item-body">
          <div class="comment-meta">
            <a class="comment-author" href="${userProfileUrl(c.userLogin)}" target="_blank" rel="noopener">${escapeHtml(c.userLogin)}</a>
            <span class="comment-time" title="${escapeHtml(c.createdAt)}">${formatTime(c.createdAt)}</span>${edited}
            <a class="thread-link" href="${escapeHtml(c.htmlUrl)}" target="_blank" rel="noopener" title="Open on GitHub">↗</a>
          </div>
          <div class="comment-md">${renderMarkdown(c.body)}</div>
        </div>
      </article>`;
    })
    .join("");

  return `<div class="conversation">
    ${description}
    ${items}
    ${comments.length === 0 ? '<p class="conversation-empty">No comments yet.</p>' : ""}
  </div>`;
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

function buildFileTree(infos: FileInfo[]): TreeNode[] {
  type DirInt = { kind: "dir"; children: Map<string, DirInt | FileInt> };
  type FileInt = { kind: "file"; info: FileInfo };
  const root: DirInt = { kind: "dir", children: new Map() };

  for (const info of infos) {
    const segments = (info.matchPath || "(unknown)")
      .split("/")
      .filter(Boolean);
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const existing = cursor.children.get(seg);
      let next: DirInt;
      if (existing && existing.kind === "dir") {
        next = existing;
      } else {
        next = { kind: "dir", children: new Map() };
        cursor.children.set(seg, next);
      }
      cursor = next;
    }
    const leaf = segments[segments.length - 1] ?? "(unknown)";
    cursor.children.set(leaf, { kind: "file", info });
  }

  const materialize = (dir: DirInt): TreeNode[] => {
    const nodes: TreeNode[] = [];
    for (const [name, child] of dir.children) {
      if (child.kind === "file") {
        nodes.push({ kind: "file", name, info: child.info });
        continue;
      }
      const sub = materialize(child);
      // Collapse a directory whose only child is another directory; the
      // combined segment ("src/foo/bar") keeps the tree compact for PRs
      // that only touch a deep subtree.
      if (sub.length === 1 && sub[0].kind === "dir") {
        nodes.push({
          kind: "dir",
          name: `${name}/${sub[0].name}`,
          children: sub[0].children,
        });
      } else {
        nodes.push({ kind: "dir", name, children: sub });
      }
    }
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  };

  return materialize(root);
}

function renderFileTree(
  nodes: TreeNode[],
  threadsByFile: Map<string, Thread[]>,
): string {
  return `<ul class="tree">${nodes.map((n) => renderTreeNode(n, threadsByFile)).join("")}</ul>`;
}

function renderTreeNode(
  node: TreeNode,
  threadsByFile: Map<string, Thread[]>,
): string {
  if (node.kind === "file") return renderTreeFile(node, threadsByFile);

  const agg = aggregateDir(node, threadsByFile);
  const stats = `<span class="tree-dir-stats">${agg.files}${agg.threads > 0 ? ` · 💬 ${agg.threads}` : ""}</span>`;
  const inner = node.children
    .map((c) => renderTreeNode(c, threadsByFile))
    .join("");
  return `<li class="tree-dir">
    <details open>
      <summary><span class="tree-dir-name">${escapeHtml(node.name)}</span>${stats}</summary>
      <ul>${inner}</ul>
    </details>
  </li>`;
}

function renderTreeFile(
  node: TreeFile,
  threadsByFile: Map<string, Thread[]>,
): string {
  const { info } = node;
  const adds = info.file.additions ?? 0;
  const dels = info.file.deletions ?? 0;
  const threadCount = threadsByFile.get(info.matchPath)?.length ?? 0;
  const threadBadge =
    threadCount > 0
      ? `<span class="fn-threads" title="${pluralize(threadCount, "thread")}">💬 ${threadCount}</span> `
      : "";
  const renameHint =
    info.file.from &&
    info.file.to &&
    info.file.from !== info.file.to &&
    info.file.from !== "/dev/null" &&
    info.file.to !== "/dev/null"
      ? ` <span class="tree-rename" title="renamed from ${escapeHtml(info.file.from)}">↳</span>`
      : "";
  return `<li class="tree-file ${info.isGenerated ? "is-generated" : ""}">
    <a href="#file-${info.index}" title="${escapeHtml(info.matchPath)}">
      <span class="tree-file-name">${escapeHtml(node.name)}${renameHint}</span>
      <span class="fn-stats">${threadBadge}${info.isGenerated ? '<span class="gen-dot" title="generated">●</span> ' : ""}<span class="add">+${adds}</span> <span class="del">-${dels}</span></span>
    </a>
  </li>`;
}

function aggregateDir(
  node: TreeDir,
  threadsByFile: Map<string, Thread[]>,
): { files: number; threads: number } {
  let files = 0;
  let threads = 0;
  const walk = (n: TreeNode) => {
    if (n.kind === "file") {
      files++;
      threads += threadsByFile.get(n.info.matchPath)?.length ?? 0;
      return;
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return { files, threads };
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

// Shared renderer for context-only rows — used for the unchanged lines
// loaded on-demand by the "expand context" buttons. Shape must match the
// ctx rows emitted by renderChunk so downstream client behavior (add
// comment, scroll-to, thread anchoring) works identically.
export function renderContextRow(
  newLine: number,
  oldLine: number,
  content: string,
  path: string,
  language: string | null,
): string {
  const codeHtml = highlightLine(content, language);
  return `<tr class="row ctx expanded" data-path="${escapeHtml(path)}" data-side="RIGHT" data-line="${newLine}"><td class="ln ln-old">${oldLine}</td><td class="ln ln-new">${newLine}</td><td class="marker"> <button type="button" class="add-comment-btn" data-action="add-comment" aria-label="Comment on line ${newLine}">+</button></td><td class="code hljs">${codeHtml}</td></tr>`;
}

function renderExpandRow(
  direction: "up" | "down",
  chunk: parseDiff.Chunk,
  prevChunk: parseDiff.Chunk | null,
  path: string,
): string {
  if (direction === "up") {
    const endNew = chunk.newStart - 1;
    const prevEnd = prevChunk
      ? prevChunk.newStart + prevChunk.newLines - 1
      : 0;
    const capStart = prevEnd + 1;
    if (endNew < capStart) return ""; // No gap above this hunk.
    const delta = chunk.newStart - chunk.oldStart;
    return `<table class="chunk expand-chunk"><tbody><tr class="expand-row" data-action="expand-context" data-direction="up" data-path="${escapeHtml(path)}" data-side="RIGHT" data-delta="${delta}" data-end-new="${endNew}" data-cap-start="${capStart}"><td colspan="4"><span class="expand-label">↑ Load 100 more lines</span></td></tr></tbody></table>`;
  }
  const startNew = chunk.newStart + chunk.newLines;
  const endOldExclusive = chunk.oldStart + chunk.oldLines;
  const delta = startNew - endOldExclusive;
  return `<table class="chunk expand-chunk"><tbody><tr class="expand-row" data-action="expand-context" data-direction="down" data-path="${escapeHtml(path)}" data-side="RIGHT" data-delta="${delta}" data-start-new="${startNew}"><td colspan="4"><span class="expand-label">↓ Load 100 more lines</span></td></tr></tbody></table>`;
}

function renderChunk(
  chunk: parseDiff.Chunk,
  path: string,
  placedIds: Set<number>,
  ctx: RenderContext,
  language: string | null,
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
      // Side: RIGHT for add/ctx (newest file), LEFT for del. Matches GitHub.
      const commentSide: DiffSide = ch.type === "del" ? "LEFT" : "RIGHT";
      const commentLine = commentSide === "LEFT" ? oldNo : newNo;
      const commentable = commentLine != null;
      const addBtn = commentable
        ? `<button type="button" class="add-comment-btn" data-action="add-comment" aria-label="Comment on line ${commentLine}">+</button>`
        : "";
      const dataAttrs = commentable
        ? ` data-path="${escapeHtml(path)}" data-side="${commentSide}" data-line="${commentLine}"`
        : "";
      const codeHtml = highlightLine(content, language);
      const row = `<tr class="row ${cls}"${dataAttrs}><td class="ln ln-old">${oldNo ?? ""}</td><td class="ln ln-new">${newNo ?? ""}</td><td class="marker">${marker}${addBtn}</td><td class="code hljs">${codeHtml}</td></tr>`;

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
  const commentsHtml = comments.map((c) => renderComment(c, ctx)).join("");
  const outdatedBadge = thread.isOutdated
    ? '<span class="thread-pill outdated">Outdated</span>'
    : "";
  const pendingBadge = thread.hasPending
    ? '<span class="thread-pill pending">Pending</span>'
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
  const filesUrl = `${ctx.prUrl}/files#r${thread.id}`;
  return `<div class="thread${thread.hasPending ? " has-pending" : ""}" data-thread-root-id="${thread.id}">
    <div class="thread-header">
      ${pendingBadge}
      ${outdatedBadge}
      ${replyHint}
      ${locationHint}
      <a class="thread-link" href="${escapeHtml(filesUrl)}" target="_blank" rel="noopener" title="Open on GitHub Files Changed">↗</a>
    </div>
    ${commentsHtml}
    <div class="thread-reply-footer">
      <button type="button" class="comment-link-btn" data-action="reply-thread">Reply</button>
    </div>
  </div>`;
}

function renderComment(c: ReviewComment, ctx: RenderContext): string {
  const isPending = ctx.pendingCommentIds.has(c.id);
  const edited =
    c.updatedAt && c.updatedAt !== c.createdAt
      ? ` <span class="comment-edited" title="edited ${escapeHtml(c.updatedAt)}">(edited)</span>`
      : "";
  const pendingPill = isPending
    ? ' <span class="comment-pending-pill">Pending</span>'
    : "";
  const actions = isPending
    ? `<div class="comment-actions">
         <button type="button" class="comment-link-btn" data-action="edit-comment">Edit</button>
         <button type="button" class="comment-link-btn danger" data-action="delete-comment">Delete</button>
       </div>`
    : "";
  return `<article class="comment${isPending ? " is-pending" : ""}" id="comment-${c.id}" data-comment-id="${c.id}" data-raw-body="${escapeHtml(c.body)}">
    ${avatarImg(c.userAvatarUrl, "comment-avatar")}
    <div class="comment-body">
      <div class="comment-meta">
        <a class="comment-author" href="${userProfileUrl(c.userLogin)}" target="_blank" rel="noopener">${escapeHtml(c.userLogin)}</a>
        <span class="comment-time" title="${escapeHtml(c.createdAt)}">${formatTime(c.createdAt)}</span>${pendingPill}
        ${edited}
      </div>
      <div class="comment-md">${renderMarkdown(c.body)}</div>
      ${actions}
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
.pr-header { padding: 14px 20px 10px; border-bottom: 1px solid var(--border); background: var(--bg-elev); position: sticky; top: 0; z-index: 10; }
.pr-title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.pr-title-row h1 { margin: 0; font-size: 18px; font-weight: 500; flex: 1 1 320px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: baseline; gap: 6px; }
.pr-repo { color: var(--text-dim); font-weight: 400; font-size: 14px; }
.pr-repo:hover { color: var(--accent); }
.pr-number { color: var(--text-dim); font-weight: 400; }
.pr-title-text { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.pr-header-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin-left: auto; }
@media (max-width: 1100px) {
  .auth-chip__meta { display: none; }
  .auth-chip { padding: 2px; }
}
.auth-chip { display: inline-flex; align-items: center; gap: 8px; padding: 3px 10px 3px 3px; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 12px; text-decoration: none; }
.auth-chip:hover { background: var(--bg-hover); text-decoration: none; border-color: var(--accent); }
.auth-chip--none { padding: 4px 10px; background: transparent; color: var(--text-dim); cursor: default; }
.auth-avatar { width: 22px; height: 22px; border-radius: 50%; display: block; }
.auth-chip__meta { display: flex; flex-direction: column; line-height: 1.1; }
.auth-chip__label { color: var(--text-dim); font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.auth-chip__login { font-weight: 600; }
.pr-title-row h1 a { color: var(--text-dim); font-weight: 400; }
.pr-state { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; background: #238636; color: white; }
.pr-state.closed { background: #8957e5; }
.pr-state.draft { background: #6e7681; }
.pr-meta { margin-top: 8px; display: flex; gap: 8px; color: var(--text-dim); font-size: 13px; align-items: center; flex-wrap: wrap; }
.pr-meta .sep { color: var(--border); }
.add { color: var(--add-fg); }
.del { color: var(--del-fg); }
/* Tabs */
.tabs { display: flex; gap: 4px; padding: 0 20px; border-bottom: 1px solid var(--border); background: var(--bg-elev); position: sticky; top: 80px; z-index: 9; }
.tab { background: none; border: none; color: var(--text-dim); padding: 10px 14px; font-size: 13px; font-family: inherit; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; display: inline-flex; align-items: center; gap: 6px; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.tab-count { background: var(--bg); border: 1px solid var(--border); color: var(--text-dim); padding: 0 6px; border-radius: 999px; font-size: 11px; font-weight: 500; }
.tab.active .tab-count { background: var(--bg-hover); color: var(--text); }
.tab-panel[hidden] { display: none; }

/* Conversation tab */
.conversation { max-width: 820px; margin: 16px auto 48px; padding: 0 24px; }
.conv-item { display: grid; grid-template-columns: 40px 1fr; gap: 12px; margin-bottom: 16px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.conv-item.conv-description { grid-template-columns: 1fr; }
.conv-item .comment-avatar { width: 36px; height: 36px; }
.conv-item-body { min-width: 0; }
.conv-item-kind { color: var(--text-dim); font-size: 12px; }
.conv-item .comment-meta { margin-bottom: 6px; }
.conv-item .thread-link { margin-left: auto; }
.conversation-empty { color: var(--text-dim); font-style: italic; text-align: center; }

.layout { display: grid; grid-template-columns: var(--sidebar-width, 300px) 1fr; min-height: calc(100vh - 80px); }
.sidebar { border-right: 1px solid var(--border); background: var(--bg-elev); overflow-y: auto; position: sticky; top: 118px; height: calc(100vh - 118px); }
.sidebar-resize-handle { position: absolute; top: 0; right: -3px; width: 6px; height: 100%; cursor: col-resize; z-index: 20; }
.sidebar-resize-handle:hover, .sidebar-resize-handle.dragging { background: var(--accent); opacity: 0.35; }
body.sidebar-resizing { user-select: none; cursor: col-resize; }
body.sidebar-resizing * { cursor: col-resize !important; }
.sidebar-header { padding: 12px 16px; font-weight: 600; border-bottom: 1px solid var(--border); color: var(--text-dim); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
.file-tree { padding: 6px 0; }
.file-tree ul { list-style: none; margin: 0; padding: 0; }
.file-tree ul ul { padding-left: 10px; border-left: 1px solid var(--border); margin-left: 14px; }
.tree-dir > details > summary { display: flex; align-items: center; gap: 6px; padding: 3px 12px 3px 6px; cursor: pointer; font-size: 12px; color: var(--text-dim); border-radius: 3px; list-style: none; }
.tree-dir > details > summary::-webkit-details-marker { display: none; }
.tree-dir > details > summary::before { content: "▸"; display: inline-block; width: 10px; color: var(--text-dim); font-size: 10px; transition: transform 0.08s; }
.tree-dir > details[open] > summary::before { transform: rotate(90deg); }
.tree-dir > details > summary:hover { background: var(--bg-hover); color: var(--text); }
.tree-dir-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.tree-dir-stats { flex-shrink: 0; font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: var(--text-dim); }
.tree-file a { display: flex; align-items: center; gap: 8px; padding: 3px 12px 3px 22px; color: var(--text); font-size: 12px; border-left: 2px solid transparent; }
.tree-file a:hover { background: var(--bg-hover); text-decoration: none; border-left-color: var(--accent); }
.tree-file.is-generated a { color: var(--text-dim); }
.tree-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
.tree-rename { color: var(--accent); font-size: 10px; margin-left: 2px; }
.fn-stats { flex-shrink: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
/* Must stay overflow: visible — any overflow value creates a scroll
   context that breaks position:sticky on inner .file-header elements.
   Horizontal scrolling of wide diffs is already handled inside .diff. */
.content { padding: 16px 24px; min-width: 0; }
.file { border: 1px solid var(--border); border-radius: 6px; margin-bottom: 24px; background: var(--bg-elev); }
.file > *:first-child { border-top-left-radius: 6px; border-top-right-radius: 6px; }
.file > *:last-child { border-bottom-left-radius: 6px; border-bottom-right-radius: 6px; }
.file .diff { border-bottom-left-radius: 6px; border-bottom-right-radius: 6px; }
.file-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--bg-elev); position: sticky; top: 118px; z-index: 5; }
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
.gen-dot { color: var(--text-dim); }
.fn-threads { color: var(--accent); margin-right: 6px; }
.file-thread-count { color: var(--accent); font-size: 12px; margin-left: 4px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
.outdated-threads { border-bottom: 1px solid var(--border); background: var(--bg-elev); padding: 10px 14px; }
.outdated-threads__header { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; }
.thread-row td { padding: 8px 12px 8px 60px; background: var(--bg); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); position: sticky; left: 0; }
.thread { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px; padding: 0; margin: 4px 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; max-width: min(560px, calc(100vw - var(--sidebar-width, 300px) - 120px)); }
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
.expand-chunk { border-top: 1px solid var(--border); }
.expand-row td { background: var(--bg-elev); color: var(--text-dim); text-align: center; padding: 4px 0; cursor: pointer; user-select: none; font-size: 11px; border-bottom: 1px solid var(--border); }
.expand-row:hover td { background: var(--bg-hover); color: var(--accent); }
.expand-row.loading td { cursor: default; color: var(--text-dim); }
.expand-row.loading .expand-label::after { content: "…"; }
.row.ctx.expanded { background: rgba(255,255,255,0.02); }
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

/* highlight.js tokens (GitHub-dark inspired) */
.hljs { background: transparent; }
.hljs-comment, .hljs-quote { color: #8b949e; font-style: italic; }
.hljs-keyword, .hljs-type, .hljs-selector-tag, .hljs-doctag { color: #ff7b72; }
.hljs-string, .hljs-regexp, .hljs-addition, .hljs-attribute, .hljs-meta-string { color: #a5d6ff; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable { color: #79c0ff; }
.hljs-title, .hljs-title.function_, .hljs-title.class_ { color: #d2a8ff; }
.hljs-built_in, .hljs-builtin-name, .hljs-symbol, .hljs-bullet { color: #ffa657; }
.hljs-name, .hljs-tag, .hljs-selector-id, .hljs-selector-class { color: #7ee787; }
.hljs-attr, .hljs-params { color: #79c0ff; }
.hljs-meta, .hljs-meta-keyword { color: #8b949e; }
.hljs-deletion { color: #ffa198; }
.hljs-link { color: #a5d6ff; text-decoration: underline; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: bold; }
/* Keep add/del backgrounds dominant on highlighted rows. */
.row.add .hljs, .row.del .hljs { background: transparent; }
.empty { padding: 40px; text-align: center; color: var(--text-dim); }

/* Add-comment affordance — sits in the +/- gutter column */
.row .marker { position: relative; }
.add-comment-btn { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 18px; height: 18px; padding: 0; line-height: 16px; border-radius: 3px; background: var(--accent); color: white; border: none; font-weight: 700; font-size: 12px; cursor: pointer; opacity: 0; transition: opacity 0.08s; }
.row:hover .add-comment-btn, .row:focus-within .add-comment-btn { opacity: 1; }
.add-comment-btn:hover { filter: brightness(1.1); }

.comment-form-row td { padding: 10px 14px 10px 60px; background: var(--bg); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); position: sticky; left: 0; }
.comment-form { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px; padding: 10px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; max-width: min(560px, calc(100vw - var(--sidebar-width, 300px) - 120px)); box-sizing: border-box; }
@media (max-width: 900px) { .comment-form, .thread { max-width: calc(100vw - 80px); } }
.comment-form textarea { width: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 8px; font-family: inherit; font-size: 13px; resize: vertical; min-height: 80px; }
.comment-form textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
.comment-form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.comment-form-error { color: var(--del-fg); font-size: 12px; margin-top: 6px; display: none; }
.comment-form-error.visible { display: block; }

/* Pending pills */
.thread-pill.pending { background: rgba(210, 153, 34, 0.15); color: #d29922; border-color: rgba(210, 153, 34, 0.4); }
.thread.has-pending { border-color: #d29922; }
.comment.is-pending { background: rgba(210, 153, 34, 0.06); }
.comment-pending-pill { background: rgba(210, 153, 34, 0.15); color: #d29922; border: 1px solid rgba(210, 153, 34, 0.4); padding: 0 6px; border-radius: 999px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.comment-actions { display: flex; gap: 12px; margin-top: 6px; }
.comment-link-btn { background: none; border: none; color: var(--text-dim); font-size: 11px; padding: 0; cursor: pointer; font-family: inherit; }
.comment-link-btn:hover { color: var(--text); text-decoration: underline; }
.comment-link-btn.danger:hover { color: var(--del-fg); }
.comment-actions .confirm-text { font-size: 11px; color: var(--text-dim); }
.comment-actions .confirm-sep { color: var(--border); font-size: 11px; }
.comment-actions .confirm-yes { color: var(--del-fg); font-weight: 600; }
.comment-actions .confirm-yes:hover { color: var(--del-fg); filter: brightness(1.2); }
.comment-actions .confirm-no { color: var(--text); font-weight: 600; }
.comment-edit-form { margin-top: 4px; }
.comment-edit-form textarea { width: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 8px; font-family: inherit; font-size: 13px; resize: vertical; min-height: 60px; }
.comment-edit-form textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
.comment-edit-form-actions { display: flex; gap: 8px; margin-top: 6px; }
.thread-reply-footer { border-top: 1px solid var(--border); padding: 6px 12px; }
.thread-reply-form { padding: 10px 12px; border-top: 1px solid var(--border); }
.thread-reply-form textarea { width: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 8px; font-family: inherit; font-size: 13px; resize: vertical; min-height: 60px; }
.thread-reply-form textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
.thread-reply-form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 6px; }

/* Buttons */
.btn { background: var(--bg-hover); color: var(--text); border: 1px solid var(--border); padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-family: inherit; }
.btn:hover { border-color: var(--accent); }
.btn.primary { background: #238636; color: white; border-color: transparent; font-weight: 600; }
.btn.primary:hover { background: #2ea043; }
.btn.danger { background: #da3633; color: white; border-color: transparent; }
.btn.danger:hover { background: #f85149; }
.btn-count { background: rgba(255, 255, 255, 0.2); padding: 1px 6px; border-radius: 999px; margin-left: 4px; font-size: 11px; }
.refresh-btn { display: inline-flex; align-items: center; gap: 6px; position: relative; }
.refresh-btn .refresh-icon { display: inline-block; transition: transform 0.4s; }
.refresh-btn.spinning .refresh-icon { animation: refresh-spin 0.8s linear infinite; }
@keyframes refresh-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.refresh-btn.has-updates { border-color: #d29922; background: rgba(210, 153, 34, 0.15); color: #d29922; }
.refresh-btn.has-updates::after { content: ""; position: absolute; top: 2px; right: 2px; width: 7px; height: 7px; background: #d29922; border-radius: 50%; box-shadow: 0 0 0 2px var(--bg-elev); }
.refresh-btn.has-updates .refresh-label::after { content: " · new"; font-weight: 600; }

/* Submit-review modal */
.modal { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal[hidden] { display: none; }
.modal-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); }
.modal-panel { position: relative; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; width: 560px; max-width: calc(100vw - 40px); max-height: calc(100vh - 40px); display: flex; flex-direction: column; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4); }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.modal-header h2 { margin: 0; font-size: 15px; font-weight: 600; }
.modal-close { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 20px; line-height: 1; padding: 0; }
.modal-close:hover { color: var(--text); }
.modal-body { padding: 16px 18px; overflow-y: auto; }
.modal-status { margin-bottom: 10px; font-size: 12px; color: var(--text-dim); }
.modal-pending-count { background: var(--bg); border: 1px solid var(--border); padding: 2px 8px; border-radius: 999px; }
.modal-pending-list { list-style: none; margin: 0 0 16px; padding: 0; max-height: 260px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
.modal-pending-item { padding: 8px 10px; border-top: 1px solid var(--border); }
.modal-pending-item:first-child { border-top: none; }
.modal-pending-item-header { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-dim); margin-bottom: 4px; }
.modal-pending-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; background: var(--bg-elev); padding: 1px 6px; border-radius: 3px; }
.modal-pending-loc { flex-shrink: 0; font-family: ui-monospace, Menlo, monospace; }
.modal-pending-body { font-size: 12px; color: var(--text); line-height: 1.4; white-space: pre-wrap; }
.modal-pending-empty { color: var(--text-dim); font-size: 12px; text-align: center; padding: 12px 0 16px; }
@keyframes flash-highlight { 0% { box-shadow: 0 0 0 2px var(--accent); } 100% { box-shadow: 0 0 0 2px transparent; } }
.comment.flash-highlight { animation: flash-highlight 1.6s ease-out; }
.modal-label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
.modal-textarea { width: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 10px; font-family: inherit; font-size: 13px; resize: vertical; }
.modal-textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
.modal-fieldset { border: none; padding: 0; margin: 16px 0 0; }
.modal-radio { display: flex; align-items: baseline; gap: 8px; padding: 6px 0; font-size: 13px; cursor: pointer; }
.modal-radio input { margin: 0; }
.modal-radio-hint { color: var(--text-dim); font-size: 12px; }
.auto-merge-panel { margin-top: 16px; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; font-size: 13px; }
.auto-merge-status { display: flex; align-items: center; gap: 10px; color: var(--text-dim); }
.auto-merge-enabled { color: #d29922; }
.auto-merge-disabled { color: var(--add-fg); }
.modal-error { margin-top: 10px; color: var(--del-fg); font-size: 12px; }
.modal-footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }

@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar { display: none; }
}
`;

const CLIENT_SCRIPT = `
(function(){
  const $ = (s, r) => (r||document).querySelector(s);

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
      return data;
    });
  }

  // --- Add-comment form ---
  function openCommentForm(row) {
    // Avoid stacking multiple forms for the same row.
    const next = row.nextElementSibling;
    if (next && next.classList.contains("comment-form-row")) {
      next.querySelector("textarea").focus();
      return;
    }
    const tr = document.createElement("tr");
    tr.className = "comment-form-row";
    tr.innerHTML =
      '<td colspan="4"><form class="comment-form">' +
        '<textarea placeholder="Leave a comment" required></textarea>' +
        '<div class="comment-form-error"></div>' +
        '<div class="comment-form-actions">' +
          '<button type="button" class="btn" data-action="cancel-comment">Cancel</button>' +
          '<button type="submit" class="btn primary">Add comment</button>' +
        '</div>' +
      '</form></td>';
    row.parentNode.insertBefore(tr, row.nextSibling);
    const form = tr.querySelector("form");
    const ta = tr.querySelector("textarea");
    ta.focus();

    ta.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        form.requestSubmit();
      }
    });

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const body = ta.value.trim();
      const errEl = tr.querySelector(".comment-form-error");
      errEl.classList.remove("visible");
      if (!body) return;
      const submitBtn = form.querySelector(".btn.primary");
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
      try {
        await postJson("/api/comment", {
          path: row.dataset.path,
          line: Number(row.dataset.line),
          side: row.dataset.side,
          body,
        });
        sessionStorage.setItem("ghreview:scrollY", String(window.scrollY));
        location.reload();
      } catch (err) {
        errEl.textContent = String((err && err.message) || err);
        errEl.classList.add("visible");
        submitBtn.disabled = false;
        submitBtn.textContent = "Add comment";
      }
    });

    tr.addEventListener("click", (ev) => {
      const t = ev.target;
      if (t && t.dataset && t.dataset.action === "cancel-comment") {
        tr.remove();
      }
    });
  }

  document.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    // data-action can sit on the TR (expand rows) or on nested elements
    // (buttons). Walk up so clicking any descendant still fires.
    const t = target.closest("[data-action]");
    if (!t) return;
    const act = t.getAttribute("data-action");
    if (act === "add-comment") {
      const row = t.closest("tr.row");
      if (row) openCommentForm(row);
    } else if (act === "open-submit") {
      openSubmitModal();
    } else if (act === "close-modal") {
      closeSubmitModal();
    } else if (act === "submit-review") {
      submitReview();
    } else if (act === "disable-auto-merge") {
      disableAutoMerge();
    } else if (act === "edit-comment") {
      const article = t.closest("article.comment");
      if (article) openEditForm(article);
    } else if (act === "delete-comment") {
      const article = t.closest("article.comment");
      if (article) deleteComment(article);
    } else if (act === "reply-thread") {
      const thread = t.closest(".thread");
      if (thread) openReplyForm(thread);
    } else if (act === "go-to-comment") {
      const id = t.getAttribute("data-comment-id");
      if (id) goToComment(id);
    } else if (act === "refresh") {
      doRefresh();
    } else if (act === "expand-context") {
      const row = t.closest("tr.expand-row");
      if (row) expandContext(row);
    }
  });

  async function expandContext(row) {
    if (row.classList.contains("loading")) return;
    const direction = row.dataset.direction;
    const path = row.dataset.path;
    const side = row.dataset.side;
    const delta = Number(row.dataset.delta);
    let start, end;
    if (direction === "up") {
      const cap = Number(row.dataset.capStart);
      end = Number(row.dataset.endNew);
      start = Math.max(cap, end - 99);
      if (start > end) { row.remove(); return; }
    } else {
      start = Number(row.dataset.startNew);
      end = start + 99;
    }
    row.classList.add("loading");
    try {
      const qs = new URLSearchParams({
        path, side, start: String(start), end: String(end), delta: String(delta),
      });
      const r = await fetch("/api/context?" + qs.toString());
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
      if (data.html) {
        if (direction === "up") {
          // New rows go BELOW the expand button so the oldest loaded line
          // is adjacent to the hunk header.
          row.insertAdjacentHTML("afterend", data.html);
        } else {
          row.insertAdjacentHTML("beforebegin", data.html);
        }
      }
      if (direction === "up") {
        const cap = Number(row.dataset.capStart);
        const nextEnd = data.firstLine - 1;
        if (nextEnd < cap) row.remove();
        else row.dataset.endNew = String(nextEnd);
      } else {
        if (data.eof) row.remove();
        else row.dataset.startNew = String(data.lastLine + 1);
      }
    } catch (err) {
      console.error("expand-context failed:", err);
    } finally {
      row.classList.remove("loading");
    }
  }

  // --- Refresh + freshness polling ---
  const refreshBtn = document.querySelector(".refresh-btn");
  const initialHeadSha = refreshBtn
    ? refreshBtn.getAttribute("data-initial-head-sha") || ""
    : "";
  const initialUpdatedAt = refreshBtn
    ? refreshBtn.getAttribute("data-initial-updated-at") || ""
    : "";

  async function doRefresh() {
    if (!refreshBtn) return;
    if (refreshBtn.classList.contains("spinning")) return;
    refreshBtn.classList.add("spinning");
    try {
      await postJson("/api/refresh", {});
      sessionStorage.setItem("ghreview:scrollY", String(window.scrollY));
      location.reload();
    } catch (err) {
      refreshBtn.classList.remove("spinning");
      alert("Refresh failed: " + String((err && err.message) || err));
    }
  }

  async function checkForUpdates() {
    if (!refreshBtn) return;
    try {
      const r = await fetch("/api/updates");
      if (!r.ok) return;
      const data = await r.json();
      const stale =
        (data.headSha && data.headSha !== initialHeadSha) ||
        (data.updatedAt && data.updatedAt !== initialUpdatedAt);
      refreshBtn.classList.toggle("has-updates", !!stale);
      if (stale) {
        refreshBtn.title =
          "The PR has new activity upstream — click to refresh";
      }
    } catch {
      // Silent; we'll retry on the next tick.
    }
  }
  if (refreshBtn) {
    setTimeout(checkForUpdates, 2000);
    setInterval(checkForUpdates, 15000);
  }

  function goToComment(id) {
    closeSubmitModal();
    const el = document.getElementById("comment-" + id);
    if (!el) return;
    let parent = el.parentElement;
    while (parent) {
      if (parent.tagName === "DETAILS" && !parent.open) parent.open = true;
      parent = parent.parentElement;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Kick a reflow to restart the animation if goToComment fires twice.
    el.classList.remove("flash-highlight");
    void el.offsetWidth;
    el.classList.add("flash-highlight");
  }

  function openReplyForm(thread) {
    const footer = thread.querySelector(".thread-reply-footer");
    if (!footer || footer.dataset.replying === "1") {
      const existing = thread.querySelector(".thread-reply-form textarea");
      if (existing) existing.focus();
      return;
    }
    footer.dataset.replying = "1";
    const rootId = thread.dataset.threadRootId;
    const button = footer.querySelector(".comment-link-btn");
    if (button) button.style.display = "none";
    const form = document.createElement("form");
    form.className = "thread-reply-form";
    form.innerHTML =
      '<textarea placeholder="Reply" required></textarea>' +
      '<div class="comment-form-error"></div>' +
      '<div class="thread-reply-form-actions">' +
        '<button type="button" class="btn" data-action="cancel-reply">Cancel</button>' +
        '<button type="submit" class="btn primary">Reply</button>' +
      '</div>';
    thread.appendChild(form);
    const ta = form.querySelector("textarea");
    const errEl = form.querySelector(".comment-form-error");
    ta.focus();

    ta.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("click", (ev) => {
      if (ev.target && ev.target.dataset && ev.target.dataset.action === "cancel-reply") {
        form.remove();
        delete footer.dataset.replying;
        if (button) button.style.display = "";
      }
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const body = ta.value.trim();
      errEl.classList.remove("visible");
      if (!body) return;
      const submitBtn = form.querySelector(".btn.primary");
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
      try {
        await postJson("/api/comment/" + encodeURIComponent(rootId) + "/reply", {
          body,
        });
        sessionStorage.setItem("ghreview:scrollY", String(window.scrollY));
        location.reload();
      } catch (err) {
        errEl.textContent = String((err && err.message) || err);
        errEl.classList.add("visible");
        submitBtn.disabled = false;
        submitBtn.textContent = "Reply";
      }
    });
  }

  function openEditForm(article) {
    const md = article.querySelector(".comment-md");
    const actions = article.querySelector(".comment-actions");
    if (!md || md.dataset.editing === "1") return;
    md.dataset.editing = "1";
    const raw = article.dataset.rawBody || "";
    const originalMd = md.innerHTML;
    md.innerHTML =
      '<form class="comment-edit-form">' +
        '<textarea></textarea>' +
        '<div class="comment-form-error"></div>' +
        '<div class="comment-edit-form-actions">' +
          '<button type="button" class="btn" data-action="cancel-edit">Cancel</button>' +
          '<button type="submit" class="btn primary">Save</button>' +
        '</div>' +
      '</form>';
    const ta = md.querySelector("textarea");
    ta.value = raw;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    if (actions) actions.style.display = "none";

    const form = md.querySelector("form");
    const errEl = md.querySelector(".comment-form-error");
    ta.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        form.requestSubmit();
      }
    });
    form.addEventListener("click", (ev) => {
      if (ev.target && ev.target.dataset && ev.target.dataset.action === "cancel-edit") {
        md.innerHTML = originalMd;
        delete md.dataset.editing;
        if (actions) actions.style.display = "";
      }
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const id = article.dataset.commentId;
      const submitBtn = form.querySelector(".btn.primary");
      submitBtn.disabled = true;
      submitBtn.textContent = "Saving…";
      errEl.classList.remove("visible");
      try {
        await fetch("/api/comment/" + encodeURIComponent(id), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: ta.value }),
        }).then(async (r) => {
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
        });
        sessionStorage.setItem("ghreview:scrollY", String(window.scrollY));
        location.reload();
      } catch (err) {
        errEl.textContent = String((err && err.message) || err);
        errEl.classList.add("visible");
        submitBtn.disabled = false;
        submitBtn.textContent = "Save";
      }
    });
  }

  function deleteComment(article) {
    const actions = article.querySelector(".comment-actions");
    if (!actions || actions.dataset.confirming === "1") return;
    actions.dataset.confirming = "1";
    const prev = actions.innerHTML;
    // "Are you sure?" is placed FIRST so it sits where the Delete button
    // was — the cursor lands on safe text, not on Yes/No.
    actions.innerHTML =
      '<span class="confirm-text">Are you sure?</span>' +
      '<button type="button" class="comment-link-btn confirm-yes" data-role="confirm-yes">Yes</button>' +
      '<span class="confirm-sep">|</span>' +
      '<button type="button" class="comment-link-btn confirm-no" data-role="confirm-no">No</button>';

    const cleanup = () => {
      actions.innerHTML = prev;
      delete actions.dataset.confirming;
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") cleanup();
    };
    document.addEventListener("keydown", onKey);

    actions.addEventListener("click", async (ev) => {
      const t = ev.target;
      if (!(t instanceof Element)) return;
      const role = t.getAttribute("data-role");
      if (role === "confirm-no") {
        cleanup();
        return;
      }
      if (role !== "confirm-yes") return;
      const id = article.dataset.commentId;
      t.textContent = "Deleting…";
      t.disabled = true;
      try {
        const r = await fetch("/api/comment/" + encodeURIComponent(id), {
          method: "DELETE",
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
        sessionStorage.setItem("ghreview:scrollY", String(window.scrollY));
        location.reload();
      } catch (err) {
        t.textContent = "Yes";
        t.disabled = false;
        alert("Delete failed: " + String((err && err.message) || err));
      }
    });
  }

  // Restore scroll after page reload.
  const savedScroll = sessionStorage.getItem("ghreview:scrollY");
  if (savedScroll) {
    sessionStorage.removeItem("ghreview:scrollY");
    window.scrollTo(0, Number(savedScroll));
  }

  // --- Tabs ---
  function activateTab(name) {
    const valid = name === "conversation" || name === "files";
    const tab = valid ? name : "files";
    document.querySelectorAll(".tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.hidden = p.dataset.panel !== tab;
    });
  }
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.tab;
      // Clear file-anchor hashes when switching; only keep tab hash for
      // Conversation (so URL is shareable).
      const nextHash = name === "conversation" ? "#conversation" : "";
      history.replaceState(null, "", location.pathname + location.search + nextHash);
      activateTab(name);
    });
  });
  // Always land on Files by default, but honor #conversation if shared.
  activateTab(location.hash === "#conversation" ? "conversation" : "files");

  // --- Sidebar resize ---
  (function initSidebarResize(){
    const MIN = 200, MAX = 900;
    const saved = Number(localStorage.getItem("ghreview:sidebarWidth"));
    if (saved >= MIN && saved <= MAX) {
      document.documentElement.style.setProperty("--sidebar-width", saved + "px");
    }
    const handle = $(".sidebar-resize-handle");
    if (!handle) return;
    let startX = 0, startWidth = 0;

    function onMove(e) {
      const dx = e.clientX - startX;
      const w = Math.min(MAX, Math.max(MIN, startWidth + dx));
      document.documentElement.style.setProperty("--sidebar-width", w + "px");
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("sidebar-resizing");
      handle.classList.remove("dragging");
      const w = getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width").trim();
      const num = parseInt(w, 10);
      if (num >= MIN && num <= MAX) {
        localStorage.setItem("ghreview:sidebarWidth", String(num));
      }
    }

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const sidebar = document.querySelector(".sidebar");
      startX = e.clientX;
      startWidth = sidebar ? sidebar.getBoundingClientRect().width : 300;
      document.body.classList.add("sidebar-resizing");
      handle.classList.add("dragging");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // Keyboard support for accessibility.
    handle.addEventListener("keydown", (e) => {
      const current = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width") || "300",
        10,
      );
      let next = current;
      if (e.key === "ArrowLeft") next = current - 20;
      else if (e.key === "ArrowRight") next = current + 20;
      else return;
      e.preventDefault();
      next = Math.min(MAX, Math.max(MIN, next));
      document.documentElement.style.setProperty("--sidebar-width", next + "px");
      localStorage.setItem("ghreview:sidebarWidth", String(next));
    });

    // Double-click resets to default.
    handle.addEventListener("dblclick", () => {
      document.documentElement.style.removeProperty("--sidebar-width");
      localStorage.removeItem("ghreview:sidebarWidth");
    });
  })();

  // --- Submit modal + auto-merge ---
  const modal = $("#submit-modal");
  const amPanel = $("#auto-merge-panel");
  const errEl = $("#submit-error");

  function openSubmitModal() {
    errEl.hidden = true;
    modal.hidden = false;
    const ta = $("#submit-review-body");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    renderAutoMerge({ loading: true });
    fetchAutoMerge();
  }

  function closeSubmitModal() {
    modal.hidden = true;
  }

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !modal.hidden) closeSubmitModal();
    if (
      !modal.hidden &&
      (ev.metaKey || ev.ctrlKey) &&
      ev.key === "Enter"
    ) {
      ev.preventDefault();
      submitReview();
    }
  });

  function renderAutoMerge(state) {
    if (state.loading) {
      amPanel.innerHTML =
        '<div class="auto-merge-status">Checking auto-merge…</div>';
      return;
    }
    if (state.error) {
      amPanel.innerHTML =
        '<div class="auto-merge-status">Could not fetch auto-merge: ' +
        escape(state.error) +
        "</div>";
      return;
    }
    if (!state.enabled) {
      amPanel.innerHTML =
        '<div class="auto-merge-status auto-merge-disabled">Auto-merge is OFF on this PR.</div>';
      return;
    }
    const who = state.enabledByLogin ? " by @" + escape(state.enabledByLogin) : "";
    amPanel.innerHTML =
      '<div class="auto-merge-status auto-merge-enabled">' +
        '⚠ Auto-merge is ON (' + (state.method || "?").toLowerCase() + ')' + who +
      "</div>" +
      '<div style="margin-top:8px;"><button type="button" class="btn danger" data-action="disable-auto-merge">Disable auto-merge</button></div>';
  }

  function fetchAutoMerge() {
    fetch("/api/auto-merge")
      .then((r) => r.json())
      .then((data) => renderAutoMerge(data))
      .catch((err) =>
        renderAutoMerge({ error: (err && err.message) || String(err) }),
      );
  }

  function disableAutoMerge() {
    const btn = amPanel.querySelector(".btn.danger");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Disabling…";
    }
    postJson("/api/disable-auto-merge", {})
      .then((state) => renderAutoMerge(state))
      .catch((err) =>
        renderAutoMerge({ error: (err && err.message) || String(err) }),
      );
  }

  function submitReview() {
    const body = $("#submit-review-body").value;
    const event = document.querySelector('input[name="submit-event"]:checked').value;
    errEl.hidden = true;
    const btn = modal.querySelector('[data-action="submit-review"]');
    btn.disabled = true;
    btn.textContent = "Submitting…";
    postJson("/api/submit", { event, body })
      .then(() => {
        sessionStorage.setItem("ghreview:scrollY", String(window.scrollY));
        location.reload();
      })
      .catch((err) => {
        errEl.textContent = String((err && err.message) || err);
        errEl.hidden = false;
        btn.disabled = false;
        btn.textContent = "Submit";
      });
  }

  function escape(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
`;
