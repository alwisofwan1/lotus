/**
 * Scene B — CodeCanvas: the same work, floating on a board.
 *
 * Built to look like the product's actual canvas — floating blurred node windows, the
 * NL command bar at the bottom, the zoom cluster. Including the Music node, because it
 * is real and it is the last detail anyone expects from a coding tool.
 *
 * Pipeline beats are all mechanisms in canvas.ts: N2 handoff · context bus (N3) ·
 * critic verdict closes the gate (N4) · human gate pauses the run until you approve.
 *
 * The pipeline nodes are 300×122, not the 78px they were first drawn at: at 78 the
 * status pill fell outside `overflow: hidden`, so the `approved` beat — the whole point
 * of the scene — rendered as an empty box.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import {
  Caption,
  NlBar,
  NodeWindow,
  Pill,
  Term,
  ZoomCluster,
  enter,
  mono,
  sans,
  type Line,
} from "../ui";

const B = {
  windows: 6,
  music: 30,
  typing: 90,
  wire: 175,
  pipeline: 215,
  verifying: 285,
  fail: 330,
  retry: 400,
  pass: 430,
  gate: 470,
  approve: 530,
} as const;

const BIMA: readonly Line[] = [
  { t: "›_ OpenAI Codex (v0.149.0)", c: T.dim },
  { t: "   perms: YOLO mode", c: T.waiting },
  { t: "" },
  { t: " You are Bima, a teammate on a shared", c: T.ink },
  { t: " Lotus canvas — a live agent development", c: T.ink },
  { t: " environment a human is watching in", c: T.ink },
  { t: " real time. Teammates here: Nara.", c: T.ink },
  { t: "" },
  { t: " lotus_dispatch_to_cell → Nara", c: T.info },
  { t: "  handing off the migration review", dim: true },
];

const NARA: readonly Line[] = [
  { t: "✻ Cogitated for 11m 43s", c: T.dim },
  { t: "" },
  { t: "✻ recap: dropped two dead indexes;", c: T.ink },
  { t: "  orders_pkey is load-bearing —", c: T.ink },
  { t: "  4 foreign keys. Not mine to call.", c: T.waiting },
  { t: "" },
  { t: "▶▶ bypass permissions on", c: T.faint },
];

const TYPED = "wire a review gate before it merges";

/** One geometry table, so the wires and the windows cannot drift apart. */
const L = {
  bima: { x: 96, y: 236, w: 800, h: 350 },
  nara: { x: 1040, y: 236, w: 780, h: 292 },
  music: { x: 1040, y: 556, w: 780, h: 170 },
  ctx: { x: 210, y: 790, w: 300, h: 122 },
  critic: { x: 640, y: 790, w: 280, h: 122 },
  gate: { x: 1050, y: 790, w: 320, h: 122 },
} as const;

const ROW_MID = L.ctx.y + L.ctx.h / 2;

export const SceneCodeCanvas: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = (d: number, rise = 14) => enter(frame, fps, d, rise);
  const step = (from: number, per = 8) => Math.max(0, Math.floor((frame - from) / per));

  const typed = Math.max(0, Math.min(TYPED.length, Math.floor(((frame - B.typing) / fps) * 22)));

  const failing = frame >= B.fail && frame < B.retry;
  const passing = frame >= B.pass;
  const gateWaiting = frame >= B.gate && frame < B.approve;
  const approved = frame >= B.approve;

  const caption = () => {
    if (frame < B.wire)
      return (
        <Caption enterStyle={at(B.windows + 20)}>
          CodeCanvas is the same project as a board. Agents are windows you arrange — and
          they hand work to each other by name.
        </Caption>
      );
    if (failing)
      return (
        <Caption enterStyle={at(B.fail)}>
          A critic reads what they produced and returns a verdict. This one failed, so the
          gate closes and nothing moves downstream.
        </Caption>
      );
    if (gateWaiting)
      return (
        <Caption enterStyle={at(B.gate)}>
          The last thing between the work and you is a human gate. The run stops here until
          you answer.
        </Caption>
      );
    if (approved)
      return (
        <Caption enterStyle={at(B.approve)}>
          You approve, and the run continues. You drew this board — Lotus ran it.
        </Caption>
      );
    return (
      <Caption enterStyle={at(B.wire)}>
        Say what you want wired. Arranging the board is matched locally, so it costs no
        model tokens.
      </Caption>
    );
  };

  return (
    <>
      {caption()}

      {/* Wires, under the windows. */}
      <svg style={{ position: "absolute", inset: 0 }} width={1920} height={1080}>
        <g opacity={at(B.wire).opacity}>
          <path
            d={`M${L.bima.x + L.bima.w},390 L${L.nara.x},390`}
            stroke={T.info}
            strokeWidth={2}
            fill="none"
          />
          <circle cx={L.nara.x} cy={390} r={4} fill={T.info} />
          <text x={L.bima.x + L.bima.w + 52} y={378} fontFamily={mono} fontSize={14} fill={T.faint}>
            N2
          </text>
        </g>
        <g opacity={at(B.pipeline + 10).opacity}>
          {/* Bima's output falls into the shared context bus. */}
          <path
            d={`M${L.bima.x + 260},${L.bima.y + L.bima.h} C${L.bima.x + 260},700 ${L.ctx.x + 150},700 ${L.ctx.x + 150},${L.ctx.y}`}
            stroke={T.faint}
            strokeWidth={1.6}
            fill="none"
          />
          <path
            d={`M${L.ctx.x + L.ctx.w},${ROW_MID} L${L.critic.x},${ROW_MID}`}
            stroke={T.faint}
            strokeWidth={1.6}
            strokeDasharray="3 3"
            fill="none"
          />
          <text x={L.ctx.x + L.ctx.w + 44} y={ROW_MID - 14} fontFamily={mono} fontSize={14} fill={T.faint}>
            N3
          </text>
          <path
            d={`M${L.critic.x + L.critic.w},${ROW_MID} L${L.gate.x},${ROW_MID}`}
            stroke={failing ? T.error : passing ? T.running : T.faint}
            strokeWidth={2}
            strokeDasharray={failing ? "5 7" : undefined}
            fill="none"
          />
          <text
            x={L.critic.x + L.critic.w + 44}
            y={ROW_MID - 14}
            fontFamily={mono}
            fontSize={14}
            fill={T.faint}
          >
            N4
          </text>
        </g>
      </svg>

      <NodeWindow
        icon="⊙"
        name="Bima"
        runner="Codex"
        style={{ ...at(B.windows), position: "absolute", ...box(L.bima) }}
      >
        <Term lines={BIMA} shown={step(B.windows + 12, 7)} />
      </NodeWindow>

      <NodeWindow
        icon="✳"
        name="Nara"
        runner="Claude Code"
        accent={frame >= B.wire ? T.info : undefined}
        style={{ ...at(B.windows + 12), position: "absolute", ...box(L.nara) }}
      >
        <Term lines={NARA} shown={step(B.windows + 24, 7)} />
      </NodeWindow>

      {/* The Music node. Real, and nobody expects it in a coding tool. */}
      <NodeWindow
        icon="♪"
        name="Music"
        runner="YouTube"
        style={{ ...at(B.music), position: "absolute", ...box(L.music) }}
      >
        <div style={{ padding: "18px 20px", display: "grid", gap: 14 }}>
          <span style={{ fontFamily: sans, fontSize: 19, color: T.ink }}>
            Lotus FM — music for thinking and building
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ color: T.waiting, fontSize: 15 }}>▶</span>
            <div style={{ flex: 1, height: 3, background: T.hair2, borderRadius: 2 }}>
              <div style={{ width: "26%", height: 3, background: T.dim, borderRadius: 2 }} />
            </div>
            <span style={{ fontFamily: mono, fontSize: 14, color: T.faint }}>0:24 / 1:33:21</span>
          </div>
        </div>
      </NodeWindow>

      {/* The pipeline that sentence wired. */}
      <NodeWindow
        icon="⧉"
        name="context"
        style={{ ...at(B.pipeline), position: "absolute", ...box(L.ctx) }}
      >
        <Row>
          <Pill status="running" word="3 artifacts" />
        </Row>
      </NodeWindow>

      <NodeWindow
        icon="◈"
        name="critic"
        accent={failing ? T.error : passing ? T.running : undefined}
        style={{ ...at(B.pipeline + 8), position: "absolute", ...box(L.critic) }}
      >
        <Row>
          {failing ? (
            <Pill status="error" />
          ) : passing ? (
            <Pill status="done" />
          ) : frame >= B.verifying ? (
            <Pill status="running" word="verifying" />
          ) : (
            <Pill status="idle" />
          )}
        </Row>
      </NodeWindow>

      <NodeWindow
        icon="⏸"
        name="human gate"
        accent={approved ? T.running : gateWaiting ? T.waiting : undefined}
        style={{ ...at(B.pipeline + 16), position: "absolute", ...box(L.gate) }}
      >
        <Row>
          {approved ? (
            <Pill status="done" word="approved" />
          ) : gateWaiting ? (
            <Pill status="waiting" />
          ) : (
            <Pill status="idle" />
          )}
        </Row>
      </NodeWindow>

      <NlBar
        text={frame >= B.typing ? TYPED.slice(0, typed) : ""}
        caret={frame >= B.typing && typed < TYPED.length}
        style={{ ...at(B.typing - 20), position: "absolute", left: 580, bottom: 44 }}
      />
      <ZoomCluster style={{ ...at(B.windows), position: "absolute", right: 96, bottom: 44 }} />
    </>
  );
};

function box(b: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  return { left: b.x, top: b.y, width: b.w, height: b.h };
}

const Row: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ padding: "16px 18px", display: "flex", alignItems: "center" }}>{children}</div>
);
