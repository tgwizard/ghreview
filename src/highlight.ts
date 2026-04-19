import hljs from "highlight.js/lib/core";
import { escapeHtml } from "./html.js";
// Only register the languages we actually map; the full bundle ships ~190.
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import haskell from "highlight.js/lib/languages/haskell";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("elixir", elixir);
hljs.registerLanguage("erlang", erlang);
hljs.registerLanguage("go", go);
hljs.registerLanguage("graphql", graphql);
hljs.registerLanguage("haskell", haskell);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("less", less);
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("makefile", makefile);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("r", r);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scala", scala);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

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

// Per-line highlighting means long block comments / multi-line strings
// may be imperfect at line boundaries — acceptable vs the complexity of
// stitching HTML spans across diff rows.
export function highlightLine(code: string, language: string | null): string {
  if (!language) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
