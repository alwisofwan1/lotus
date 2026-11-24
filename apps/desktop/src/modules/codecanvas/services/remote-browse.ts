/**
 * Walking a directory tree on another machine, as pure path arithmetic.
 *
 * The listing itself comes from Rust (`list_dir_entries_ssh`, one round trip per directory). What
 * lives here is everything that must be right *before* and *after* that call: where "up" goes, what
 * the breadcrumb says, and which row is worth a repo badge — the parts a test can hold still.
 */

export interface BrowseCrumb {
  label: string;
  /** Absolute path this crumb navigates to. */
  path: string;
}

/** Trailing slashes removed, `/` preserved. The shape every other function here assumes. */
export function normalizeBrowsePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  const stripped = trimmed.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

/**
 * The directory above this one, or null at the root.
 *
 * Null rather than "/" at the top so the caller can hide the `..` row instead of drawing one that
 * does nothing — an affordance that lies is worse than an absent one.
 */
export function parentBrowsePath(path: string): string | null {
  const normalized = normalizeBrowsePath(path);
  if (normalized === "/") return null;
  const cut = normalized.lastIndexOf("/");
  if (cut <= 0) return "/";
  return normalized.slice(0, cut);
}

/** `/srv/devbox/api` → root, srv, devbox, api — each one navigable. */
export function browseCrumbs(path: string): BrowseCrumb[] {
  const normalized = normalizeBrowsePath(path);
  const crumbs: BrowseCrumb[] = [{ label: "/", path: "/" }];
  if (normalized === "/") return crumbs;

  let walked = "";
  for (const segment of normalized.split("/").filter(Boolean)) {
    walked += `/${segment}`;
    crumbs.push({ label: segment, path: walked });
  }
  return crumbs;
}

/** Join a parent and a child name without doubling or dropping the separator. */
export function joinBrowsePath(parent: string, name: string): string {
  const base = normalizeBrowsePath(parent);
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

/**
 * Where a browse starts on a machine we have never opened.
 *
 * `/` is a poor first screen — a VPS root is a wall of system directories — so a known home is
 * preferred when the target names a user. This is a guess by construction, which is why the browser
 * must stay able to walk up from it rather than treating it as a floor.
 */
export function initialBrowsePath(target: { user?: string }): string {
  const user = target.user?.trim();
  if (!user) return "/";
  return user === "root" ? "/root" : `/home/${user}`;
}
