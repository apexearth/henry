// Syntax highlighting for file peeks. highlight.js core plus languages loaded on demand, so
// the terminal bundle stays small and a Rust file never pulls in Haskell. The whole file is
// highlighted once, then the HTML is split per line (spans re-opened across line breaks) so
// FileView keeps its own line numbers and hit line.
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";

type Loader = () => Promise<{ default: LanguageFn }>;

const loaders: Record<string, Loader> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  dart: () => import("highlight.js/lib/languages/dart"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  elixir: () => import("highlight.js/lib/languages/elixir"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  nginx: () => import("highlight.js/lib/languages/nginx"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const byExt: Record<string, string> = {
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", mm: "objectivec", m: "objectivec",
  cs: "csharp",
  css: "css", scss: "scss", sass: "scss", less: "scss",
  dart: "dart",
  diff: "diff", patch: "diff",
  ex: "elixir", exs: "elixir",
  go: "go",
  graphql: "graphql", gql: "graphql",
  hs: "haskell",
  ini: "ini", cfg: "ini", conf: "ini", toml: "ini", properties: "ini", env: "bash",
  java: "java",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  json: "json", jsonc: "json", json5: "json", lock: "json",
  kt: "kotlin", kts: "kotlin",
  lua: "lua",
  mk: "makefile",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  pl: "perl", pm: "perl",
  php: "php",
  proto: "protobuf",
  py: "python", pyi: "python",
  r: "r",
  rb: "ruby", rake: "ruby", gemspec: "ruby",
  rs: "rust",
  scala: "scala", sc: "scala",
  sql: "sql",
  swift: "swift",
  xml: "xml", html: "xml", htm: "xml", svg: "xml", vue: "xml", svelte: "xml", plist: "xml",
  yml: "yaml", yaml: "yaml",
};

const byName: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile", gnumakefile: "makefile", gemfile: "ruby", rakefile: "ruby",
  ".bashrc": "bash", ".zshrc": "bash", ".zshenv": "bash", ".profile": "bash", ".bash_profile": "bash",
  ".gitignore": "bash", ".gitattributes": "bash", ".editorconfig": "ini", ".npmrc": "ini",
  "nginx.conf": "nginx", "bun.lock": "json",
};

/** hljs language for a path, or undefined for plain text. */
export function languageFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (byName[name]) return byName[name];
  if (name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? byExt[name.slice(dot + 1)] : undefined;
}

/** Past this, highlighting the whole file would visibly stall the panel; plain text instead. */
const HIGHLIGHT_CAP = 256 * 1024;

const loaded = new Map<string, Promise<boolean>>();

function ensure(lang: string): Promise<boolean> {
  let p = loaded.get(lang);
  if (!p) {
    const load = loaders[lang];
    p = load
      ? load().then((m) => { hljs.registerLanguage(lang, m.default); return true; }, () => false)
      : Promise.resolve(false);
    loaded.set(lang, p);
  }
  return p;
}

const TAG = /<span class="[^"]*">|<\/span>/g;

/** Split highlighted HTML into lines, closing open spans at each break and re-opening them on the next. */
export function splitHighlighted(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  for (const raw of html.split("\n")) {
    const prefix = open.join("");
    for (const m of raw.matchAll(TAG)) {
      if (m[0] === "</span>") open.pop();
      else open.push(m[0]);
    }
    out.push(prefix + raw + "</span>".repeat(open.length));
  }
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Per-line HTML for `content`, or null when the file is plain text, too big, or the language is missing. */
export async function highlightLines(path: string, content: string): Promise<string[] | null> {
  const lang = languageFor(path);
  if (!lang || content.length > HIGHLIGHT_CAP) return null;
  if (!(await ensure(lang))) return null;
  try {
    return splitHighlighted(hljs.highlight(content, { language: lang, ignoreIllegals: true }).value);
  } catch {
    return null;
  }
}
