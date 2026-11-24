/*
 * The editor's language for a file. The ids are Shiki grammar names: Shiki tokenizes the editor
 * (`monaco-theme.ts`), so an id without a grammar would show as plain text.
 */

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "shell",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  gql: "graphql",
  go: "go",
  graphql: "graphql",
  h: "cpp",
  hpp: "cpp",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "jsonc",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  markdown: "markdown",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  mk: "make",
  mts: "typescript",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  svelte: "svelte",
  svg: "xml",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  txt: "plaintext",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

/** Whole names that say more than their extension (or have none). Lower case. */
const LANGUAGE_BY_FILE_NAME: Record<string, string> = {
  ".bash_profile": "shell",
  ".bashrc": "shell",
  ".profile": "shell",
  ".zprofile": "shell",
  ".zshrc": "shell",
  dockerfile: "dockerfile",
  gemfile: "ruby",
  gnumakefile: "make",
  makefile: "make",
  rakefile: "ruby",
};

/** As VS Code: these JSON files allow comments. */
const JSONC_FILE_NAMES = new Set(["tsconfig.json", "jsconfig.json", ".eslintrc.json", "devcontainer.json"]);

const LANGUAGE_LABELS: Record<string, string> = {
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  dockerfile: "Dockerfile",
  dotenv: "Dotenv",
  go: "Go",
  graphql: "GraphQL",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  jsonc: "JSON with Comments",
  jsx: "JavaScript JSX",
  kotlin: "Kotlin",
  less: "Less",
  lua: "Lua",
  make: "Makefile",
  markdown: "Markdown",
  mdx: "MDX",
  php: "PHP",
  plaintext: "Plain Text",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  shell: "Shell",
  sql: "SQL",
  svelte: "Svelte",
  swift: "Swift",
  toml: "TOML",
  tsx: "TypeScript JSX",
  typescript: "TypeScript",
  vue: "Vue",
  xml: "XML",
  yaml: "YAML",
};

/** Every language the editor can pick, for the highlighter to load. */
export const EDITOR_HIGHLIGHT_LANGUAGES: readonly string[] = Object.keys(LANGUAGE_LABELS).filter((id) => id !== "plaintext");

export function resolveEditorLanguage(filePath: string | null): string {
  if (!filePath) return "plaintext";
  const fileName = (filePath.split(/[\\/]/).pop() ?? filePath).toLowerCase();
  if (JSONC_FILE_NAMES.has(fileName)) return "jsonc";
  if (fileName === ".env" || fileName.startsWith(".env.")) return "dotenv";
  const byName = LANGUAGE_BY_FILE_NAME[fileName];
  if (byName) return byName;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  return LANGUAGE_BY_EXTENSION[fileName.slice(dot + 1)] ?? "plaintext";
}

/** The name the status bar shows, as VS Code names it. */
export function editorLanguageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? language;
}
