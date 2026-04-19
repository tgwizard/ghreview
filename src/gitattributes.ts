// Minimal .gitattributes parser focused on linguist-generated.
//
// Supports enough of the gitattributes pattern grammar to handle the common
// cases in the wild: simple globs (`*.min.js`), directory patterns
// (`dist/**`, `vendor/*`), and anchored patterns (`/generated/**`). Later rules
// override earlier ones (matching git's behavior), and negation via
// `-linguist-generated` is honored.

export interface GeneratedMatcher {
  isGenerated: (path: string) => boolean;
}

interface Rule {
  regex: RegExp;
  value: boolean;
}

export function buildGeneratedMatcher(
  gitattributesContent: string | null,
): GeneratedMatcher {
  if (!gitattributesContent) return { isGenerated: () => false };

  const rules: Rule[] = [];
  for (const rawLine of gitattributesContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pattern = parts[0];
    const attrs = parts.slice(1);
    const value = linguistGeneratedValue(attrs);
    if (value === undefined) continue;
    const regex = patternToRegex(pattern);
    if (!regex) continue;
    rules.push({ regex, value });
  }

  return {
    isGenerated(path: string) {
      let result = false;
      for (const rule of rules) {
        if (rule.regex.test(path)) result = rule.value;
      }
      return result;
    },
  };
}

function linguistGeneratedValue(attrs: string[]): boolean | undefined {
  let result: boolean | undefined;
  for (const attr of attrs) {
    if (attr === "linguist-generated") result = true;
    else if (attr === "linguist-generated=true") result = true;
    else if (attr === "linguist-generated=false") result = false;
    else if (attr === "-linguist-generated") result = false;
  }
  return result;
}

// Converts a gitattributes pattern to a regex that matches a forward-slash
// POSIX-style path. Gitattributes patterns are similar to gitignore:
//   - Leading `/` anchors to the repo root.
//   - `**` matches any number of path segments (including zero).
//   - `*` matches anything except `/`.
//   - `?` matches any single character except `/`.
// If the pattern has no `/`, it can match at any directory depth.
function patternToRegex(pattern: string): RegExp | null {
  if (!pattern) return null;

  let anchored = false;
  let p = pattern;
  if (p.startsWith("/")) {
    anchored = true;
    p = p.slice(1);
  } else if (!p.includes("/")) {
    // Bare name — match at any depth.
    anchored = false;
  } else {
    // Has a slash but no leading `/` — git still anchors to root.
    anchored = true;
  }

  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**` — match across path segments.
        re += ".*";
        i++;
        // Absorb a following `/` so `**/foo` matches `foo` too.
        if (p[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }

  const head = anchored ? "^" : "(?:^|.*/)";
  return new RegExp(head + re + "$");
}
