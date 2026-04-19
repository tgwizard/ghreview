import hljs from "highlight.js";

// Path suffix → highlight.js language id. We only list the common ones;
// anything else falls back to plain escaped text (the `detectLanguage`
// helper also respects hljs.getLanguage so unregistered names are safe).
const EXT_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
  html: "xml",
  htm: "xml",
  xml: "xml",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  lua: "lua",
  r: "r",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  zig: "zig",
};

const BASENAME_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

export function detectLanguage(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  const bn = BASENAME_MAP[base];
  if (bn && hljs.getLanguage(bn)) return bn;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = base.slice(dot + 1);
  const lang = EXT_MAP[ext];
  return lang && hljs.getLanguage(lang) ? lang : null;
}

// Highlight a single source line. Per-line highlighting means multi-line
// constructs (long block comments, multi-line strings) may be imperfect —
// acceptable tradeoff vs the complexity of whole-chunk highlighting with
// correct HTML span splitting.
export function highlightLine(code: string, language: string | null): string {
  if (!language) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
