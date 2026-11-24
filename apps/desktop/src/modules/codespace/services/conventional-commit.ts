import type { CodespaceGitFileStatus } from "@/lib/tauri-api";

export const CONVENTIONAL_COMMIT_TYPES = [
  { type: "feat", description: "A new feature" },
  { type: "fix", description: "A bug fix" },
  { type: "docs", description: "Documentation only" },
  { type: "refactor", description: "Code change that neither fixes a bug nor adds a feature" },
  { type: "test", description: "Adding or correcting tests" },
  { type: "chore", description: "Tooling, config, or housekeeping" },
  { type: "style", description: "Formatting, white-space, semicolons" },
  { type: "perf", description: "Performance improvement" },
  { type: "build", description: "Build system or dependencies" },
  { type: "ci", description: "CI configuration" },
  { type: "revert", description: "Revert a previous commit" },
] as const;

export type ConventionalCommitType = (typeof CONVENTIONAL_COMMIT_TYPES)[number]["type"];

const HEADER_REGEX = /^([a-z]+)(\([^)]+\))?(!)?:\s*(.*)$/;

/**
 * Apply (set or replace) a conventional commit `type` prefix on the first
 * line of `message`, preserving any existing `(scope)`, breaking-change `!`,
 * description text, and trailing body. Idempotent: clicking the same chip
 * twice is a no-op.
 */
export function applyConventionalType(message: string, type: ConventionalCommitType): string {
  const newlineIndex = message.indexOf("\n");
  const firstLine = newlineIndex === -1 ? message : message.slice(0, newlineIndex);
  const rest = newlineIndex === -1 ? "" : message.slice(newlineIndex);
  const match = firstLine.match(HEADER_REGEX);
  if (match) {
    const scope = match[2] ?? "";
    const bang = match[3] ?? "";
    const body = match[4] ?? "";
    return `${type}${scope}${bang}: ${body}${rest}`;
  }
  return `${type}: ${firstLine.trim()}${rest}`;
}

/** Pull the type token (if any) out of a commit-message header. */
export function extractCommitType(message: string): ConventionalCommitType | null {
  const firstLine = message.split("\n", 1)[0] ?? "";
  const match = firstLine.match(HEADER_REGEX);
  if (!match) return null;
  const candidate = match[1] as ConventionalCommitType;
  return CONVENTIONAL_COMMIT_TYPES.some((entry) => entry.type === candidate) ? candidate : null;
}

interface HeuristicInput {
  rootDir: string;
  statuses: CodespaceGitFileStatus[];
}

interface HeuristicSuggestion {
  type: ConventionalCommitType;
  scope: string | null;
  /** Pre-built `<type>(<scope>): ` string ready to drop into the textarea. */
  template: string;
}

/**
 * Heuristic conventional-commit suggestion based on staged file paths and
 * change kinds. Pure, deterministic, offline. Result is a header prefix the
 * user finishes by hand; we deliberately do not invent the description.
 */
export function suggestConventionalCommitHeuristic({ statuses }: HeuristicInput): HeuristicSuggestion | null {
  const staged = statuses.filter((status) => Boolean(status.staged));
  if (staged.length === 0) return null;

  const paths = staged.map((status) => status.relativePath.replace(/\\/g, "/"));
  const type = inferType(paths, staged);
  const scope = inferScope(paths);
  const template = scope ? `${type}(${scope}): ` : `${type}: `;
  return { type, scope, template };
}

function inferType(paths: string[], staged: CodespaceGitFileStatus[]): ConventionalCommitType {
  const allMatch = (predicate: (p: string) => boolean) => paths.every(predicate);
  const anyMatch = (predicate: (p: string) => boolean) => paths.some(predicate);

  if (allMatch(isCiPath)) return "ci";
  if (allMatch(isDocsPath)) return "docs";
  if (allMatch(isTestPath)) return "test";
  if (allMatch(isStylePath)) return "style";
  if (allMatch(isBuildPath)) return "build";

  const stagedKinds = staged.map((status) => status.staged);
  const allAdded = stagedKinds.every((kind) => kind === "added" || kind === "untracked");
  const allDeleted = stagedKinds.every((kind) => kind === "deleted");
  if (allAdded) return "feat";
  if (allDeleted) return "chore";

  // Mixed signals — bias toward refactor when nothing screams "fix" or "feat".
  if (anyMatch(isTestPath) && paths.length === staged.filter((s) => isTestPath(s.relativePath)).length) {
    return "test";
  }
  return "refactor";
}

function inferScope(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const segments = paths.map((path) => path.split("/").filter(Boolean));
  const firstNonGenericSegment = segments[0]?.find((segment) => !GENERIC_TOP_DIRS.has(segment));
  // Use the deepest common module-ish segment shared across all paths.
  const candidate = segments
    .map((parts) => parts.find((segment) => !GENERIC_TOP_DIRS.has(segment)) ?? null)
    .filter((value): value is string => Boolean(value));
  if (candidate.length === 0) return firstNonGenericSegment ?? null;
  const allSame = candidate.every((value) => value === candidate[0]);
  if (!allSame) return null;
  const scope = candidate[0];
  if (!scope) return null;
  return scope.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 24);
}

const GENERIC_TOP_DIRS = new Set([
  "src",
  "app",
  "apps",
  "packages",
  "lib",
  "libs",
  "modules",
  "components",
  "scripts",
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
]);

function isDocsPath(path: string): boolean {
  if (/\.(md|mdx|rst|adoc|txt)$/i.test(path)) return true;
  return /(?:^|\/)(?:docs?|documentation)\//i.test(path);
}

function isTestPath(path: string): boolean {
  if (/\.(test|spec)\.[jt]sx?$/i.test(path)) return true;
  return /(?:^|\/)(?:__tests__|tests?|spec|specs)\//i.test(path);
}

function isCiPath(path: string): boolean {
  return /(?:^|\/)\.(?:github|gitlab|circleci|drone)\//i.test(path)
    || /(?:^|\/)(?:Jenkinsfile|\.travis\.yml|\.gitlab-ci\.yml|\.drone\.yml)$/i.test(path);
}

function isStylePath(path: string): boolean {
  return /\.(css|scss|sass|less|stylus)$/i.test(path);
}

function isBuildPath(path: string): boolean {
  return /(?:^|\/)(?:package\.json|bun\.lock|bun\.lockb|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|Cargo\.toml|Cargo\.lock|tsconfig(?:\.[a-z]+)?\.json|vite\.config\.[jt]s|next\.config\.[jt]s|tauri\.conf\.json|Dockerfile)$/i.test(path);
}
