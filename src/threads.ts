import type { ReviewComment } from "./gh.js";

export interface Thread {
  id: number;
  root: ReviewComment;
  replies: ReviewComment[];
  path: string;
  // The line/side GitHub considers "current" for this thread. Falls back to
  // the original line/side if the thread is outdated (line === null).
  line: number | null;
  side: "LEFT" | "RIGHT";
  isOutdated: boolean;
}

export interface ThreadIndex {
  all: Thread[];
  getAt(path: string, side: "LEFT" | "RIGHT", line: number): Thread[];
}

export function buildThreadIndex(comments: ReviewComment[]): ThreadIndex {
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
    const isOutdated = root.line == null;
    // For display we keep whatever location info we have — but for anchoring,
    // only use the current line. Threads without a current line go to the
    // per-file "outdated" block (matching GitHub's Files Changed behavior).
    const line = root.line;
    const side = root.side ?? root.originalSide ?? ("RIGHT" as const);
    threads.push({
      id: root.id,
      root,
      replies,
      path: root.path,
      line: line ?? root.originalLine,
      side,
      isOutdated,
    });
  }

  threads.sort((a, b) => a.root.createdAt.localeCompare(b.root.createdAt));

  const lookup = new Map<string, Thread[]>();
  const keyOf = (path: string, side: string, line: number) =>
    `${path}\u0000${side}\u0000${line}`;
  for (const t of threads) {
    // Only anchor non-outdated threads. Outdated threads render in the
    // per-file "outdated" block; their line may no longer match anything.
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
