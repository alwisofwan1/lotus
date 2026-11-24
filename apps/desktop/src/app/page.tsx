/**
 * The unified workspace shell is mounted by `AppShell`, not by this route.
 *
 * Same arrangement as `/terminal`: the shell has to survive a trip to CodeCanvas with its
 * terminals still attached, and a page component is unmounted the moment the route changes. So
 * this file only marks that the route exists — see `AppShell` for who renders it and for the rule
 * that keeps it from being mounted alongside CodeSpace.
 */
export default function WorkspaceShellRoute() {
  return null;
}
