export type PtyBackendKind = "sessiond" | "node-pty";

export interface PtyBackendChoiceInput {
  mode: "client" | "standalone";
  env: { LOTUS_PTY?: string | undefined };
}

export interface PtyBackendChoice {
  kind: PtyBackendKind;
}

/// A standalone host keeps its sessions in `lotus-sessiond` so they survive a restart (ADR-0067);
/// a client-mode embed stays on node-pty until phase 6.
export function selectPtyBackendKind(input: PtyBackendChoiceInput): PtyBackendChoice {
  const forced = input.env.LOTUS_PTY?.trim();
  if (forced === "node-pty" || forced === "sessiond") return { kind: forced };
  return { kind: input.mode === "standalone" ? "sessiond" : "node-pty" };
}
