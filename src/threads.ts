import type { DiffSide, ReviewComment, ThreadMetadata } from "./gh.js";

export interface Thread {
  id: number;
  // GraphQL node id of the review thread — needed to call the
  // resolve/unresolve mutations. May be null for brand-new pending threads
  // that haven't shown up in the GraphQL index yet.
  nodeId: string | null;
  root: ReviewComment;
  replies: ReviewComment[];
  path: string;
  // Current line if the thread is live, original line if outdated, null if
  // neither was reported.
  line: number | null;
  side: DiffSide;
  isOutdated: boolean;
  isResolved: boolean;
  // True if any comment in this thread is in the viewer's pending review.
  hasPending: boolean;
}

export interface ThreadIndex {
  all: Thread[];
  getAt(path: string, side: DiffSide, line: number): Thread[];
}

export function buildThreadIndex(
  comments: ReviewComment[],
  pendingCommentIds: Set<number> = new Set(),
  threadMetadata: Map<number, ThreadMetadata> = new Map(),
): ThreadIndex {
  const byId = new Map<number, ReviewComment>();
  for (const c of comments) byId.set(c.id, c);

  const rootIdOf = new Map<number, number>();
  const findRootId = (id: number): number => {
    const cached = rootIdOf.get(id);
    if (cached != null) return cached;
    let cursor = byId.get(id);
    let last = id;
    const seen = new Set<number>();
    while (cursor && cursor.inReplyToId != null) {
      if (seen.has(cursor.id)) break;
      seen.add(cursor.id);
      last = cursor.inReplyToId;
      cursor = byId.get(cursor.inReplyToId);
    }
    rootIdOf.set(id, last);
    return last;
  };

  const grouped = new Map<number, ReviewComment[]>();
  for (const c of comments) {
    const root = findRootId(c.id);
    let list = grouped.get(root);
    if (!list) {
      list = [];
      grouped.set(root, list);
    }
    list.push(c);
  }

  const threads: Thread[] = [];
  for (const [rootId, members] of grouped) {
    members.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const root = byId.get(rootId) ?? members[0];
    const replies = members.filter((m) => m.id !== root.id);
    const hasPending = members.some((m) => pendingCommentIds.has(m.id));
    // Any member's metadata entry describes the whole thread.
    const meta =
      members
        .map((m) => threadMetadata.get(m.id))
        .find((m): m is ThreadMetadata => !!m) ?? null;
    threads.push({
      id: root.id,
      nodeId: meta?.nodeId ?? null,
      root,
      replies,
      path: root.path,
      line: root.line ?? root.originalLine,
      side: root.side ?? root.originalSide ?? "RIGHT",
      // GraphQL's reviewThread.isOutdated is authoritative. The REST
      // heuristic (root.line == null) misses the mark for pending
      // comments, which can legitimately have line=null but aren't
      // "outdated" in the GitHub sense.
      isOutdated: meta ? meta.isOutdated : root.line == null,
      isResolved: meta?.isResolved ?? false,
      hasPending,
    });
  }

  threads.sort((a, b) => a.root.createdAt.localeCompare(b.root.createdAt));

  // Outdated threads aren't indexed here; their stored line may no longer
  // match anything in the current diff, so the renderer puts them in a
  // per-file "outdated" block instead.
  const lookup = new Map<string, Thread[]>();
  const keyOf = (path: string, side: DiffSide, line: number) =>
    `${path}\u0000${side}\u0000${line}`;
  for (const t of threads) {
    if (t.isOutdated || t.line == null) continue;
    const k = keyOf(t.path, t.side, t.line);
    let list = lookup.get(k);
    if (!list) {
      list = [];
      lookup.set(k, list);
    }
    list.push(t);
  }

  return {
    all: threads,
    getAt(path, side, line) {
      return lookup.get(keyOf(path, side, line)) ?? [];
    },
  };
}
