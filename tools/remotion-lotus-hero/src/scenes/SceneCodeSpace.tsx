/**
 * Scene A — CodeSpace: the dense, tiled workspace.
 *
 * Two named agents, because that is how the product reads: `Bima · Codex` and
 * `Nara · Claude Code`. The Bridge cell on the left is the orchestrator, and the beat
 * that matters is its CONTEXT row — it already holds what you are looking at, and it
 * shows you before it sends.
 *
 * Window heights are set against the line count, not eyeballed: an earlier cut clipped
 * Nara's last two lines, which were the punchline the caption was pointing at.
 *
 * Two lines were corrected on 2026-08-24, after `apps/web` grew tests that catch this
 * class and found the same two defects in its own copy. This file has no test watching
 * it, so the README's instruction — re-check against those assertions before
 * re-publishing — is the only guard:
 *
 *   · `/fleet dispatch` → `/dispatch-to`. The first was never a command; the Bridge
 *     registry (`bridge/composer/commands-registry.ts`) declares `dispatch-to`.
 *   · "worktree per cell" → "isolation armed". ADR-0015 makes per-agent worktrees
 *     opt-in at team launch and explicitly rejected auto-create, so the old line
 *     showed a default that does not exist.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import { Caption, NodeWindow, Pill, Term, ZoomCluster, enter, mono, type Line } from "../ui";

const BRIDGE: readonly Line[] = [
  { t: "› /dispatch-to  extract the retry policy", c: T.ink },
  { t: "" },
  { t: "  planning …", dim: true },
  { t: "  read  payments/charge.ts  ·  412 lines", dim: true },
  { t: "  read  payments/refund.ts  ·  188 lines", dim: true },
  { t: "" },
  { t: "  3 cells selected · isolation armed", c: T.dim },
  { t: "    Bima        codex        payments/*", dim: true },
  { t: "    Nara        claude-code  schema.sql", dim: true },
  { t: "    docs-sweep  claude-code  docs/adr/*", dim: true },
  { t: "" },
  { t: "  handing off to Bima, Nara, docs-sweep", c: T.info },
  { t: "  watching 3 cells · nothing merged yet", dim: true },
];

const BIMA: readonly Line[] = [
  { t: ">_ OpenAI Codex (v0.149.0)", c: T.dim },
  { t: "   model:  gpt-5.6-sol medium", dim: true },
  { t: "   dir:    ~/workspace/experiments/Lotus", dim: true },
  { t: "   perms:  YOLO mode", c: T.waiting },
  { t: "" },
  { t: " Edit payments/charge.ts", c: T.ink },
  { t: "  + extracted retryPolicy()", c: T.running },
  { t: "  + 14 call sites rewritten", c: T.running },
];

const NARA: readonly Line[] = [
  { t: "✻ Cogitated for 2m 08s", c: T.dim },
  { t: "" },
  { t: " Read schema.sql — 3 candidate indexes.", c: T.ink },
  { t: "  orders_status_idx  superseded, dropped", dim: true },
  { t: "  orders_email_idx   unused 90d, dropped", dim: true },
  { t: "  orders_pkey        4 foreign keys —", c: T.ink },
  { t: "                     not mine to call.", c: T.waiting },
];

const CHIPS = ["charge.ts", "unsaved", "~/work/payments-api", "3 cells"] as const;

const B = { bridge: 8, chips: 74, cells: 150, output: 200, waiting: 300 } as const;

export const SceneCodeSpace: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = (d: number, rise = 14) => enter(frame, fps, d, rise);
  const step = (from: number, per = 9) => Math.max(0, Math.floor((frame - from) / per));

  return (
    <>
      {frame < B.waiting ? (
        <Caption enterStyle={at(B.chips + 16)}>
          CodeSpace is the dense view. The Bridge already holds the file you have open,
          whether it is unsaved, and every cell in the fleet — and shows you that payload
          before it sends.
        </Caption>
      ) : (
        <Caption enterStyle={at(B.waiting)}>
          One agent stops and asks. Nothing was dispatched behind your back.
        </Caption>
      )}

      {/* Tiled, not floating: this is the pane view. */}
      <NodeWindow
        icon="◇"
        name="Bridge"
        runner="orchestrator"
        style={{ ...at(B.bridge), position: "absolute", left: 96, top: 236, width: 870, height: 660 }}
      >
        <Term lines={BRIDGE} shown={step(B.bridge + 14, 11)} />
        <div
          style={{
            ...at(B.chips),
            margin: "auto 18px 16px",
            paddingTop: 16,
            borderTop: `1px solid ${T.hair}`,
            display: "flex",
            gap: 9,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <span style={{ fontFamily: mono, fontSize: 12, letterSpacing: "0.14em", color: T.faint }}>
            CONTEXT
          </span>
          {CHIPS.map((c, i) => (
            <span
              key={c}
              style={{
                ...at(B.chips + i * 10),
                fontFamily: mono,
                fontSize: 14,
                color: c === "unsaved" ? T.waiting : T.dim,
                padding: "6px 12px",
                borderRadius: 999,
                boxShadow: `inset 0 0 0 1px ${T.hair2}`,
              }}
            >
              {c}
            </span>
          ))}
        </div>
      </NodeWindow>

      <NodeWindow
        icon="⊙"
        name="Bima"
        runner="Codex"
        style={{ ...at(B.cells), position: "absolute", left: 990, top: 236, width: 830, height: 322 }}
      >
        <Term lines={BIMA} shown={step(B.output, 8)} />
        <div style={{ marginTop: "auto", padding: "0 18px 14px" }}>
          <Pill status="running" />
        </div>
      </NodeWindow>

      <NodeWindow
        icon="✳"
        name="Nara"
        runner="Claude Code"
        accent={frame >= B.waiting ? T.waiting : undefined}
        style={{ ...at(B.cells + 14), position: "absolute", left: 990, top: 576, width: 830, height: 322 }}
      >
        <Term lines={NARA} shown={step(B.output + 26, 8)} />
        <div style={{ marginTop: "auto", padding: "0 18px 14px" }}>
          <Pill status={frame >= B.waiting ? "waiting" : "running"} />
        </div>
      </NodeWindow>

      <ZoomCluster style={{ ...at(B.bridge), position: "absolute", right: 96, bottom: 44 }} />
    </>
  );
};
