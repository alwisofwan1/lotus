export interface StartupContext {
  mode: "client" | "standalone";
  /** From `LOTUS_FCM_SERVICE_ACCOUNT`; undefined means this host cannot wake a phone. */
  fcmServiceAccountPath: string | undefined;
}

/// What the operator must be told at boot, in their words rather than the variable's.
///
/// Scoped to `standalone` on purpose: a client-mode host runs beside a desktop its operator is
/// looking at, while a VPS has nobody watching — which is why a host that cannot wake a phone
/// there looks exactly like a host where nothing is happening.
export function startupWarnings(ctx: StartupContext): string[] {
  const warnings: string[] = [];
  if (ctx.mode === "standalone" && ctx.fcmServiceAccountPath === undefined) {
    warnings.push(
      "No push credentials (LOTUS_FCM_SERVICE_ACCOUNT): this host cannot wake a phone, so an "
      + "agent waiting for approval will never be announced. Work still runs; you will simply "
      + "not be told it is blocked.",
    );
  }
  return warnings;
}
