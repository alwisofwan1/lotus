/**
 * The app's UI language, rebuilt: a navy dotted canvas, floating blurred node windows
 * with title bars, the NL command bar, the zoom cluster.
 *
 * These are reconstructions in Remotion, not screenshots — the video is an explainer,
 * and it says so. But it now looks like the product it is explaining, which the first
 * cut did not.
 */
import React from "react";
import { interpolate, spring } from "remotion";
import { T } from "./theme";

export const mono = '"JetBrains Mono", ui-monospace, monospace';
export const display = '"Schibsted Grotesk", system-ui, sans-serif';
export const sans = '"Instrument Sans", system-ui, sans-serif';

/** Pure, so it can be called inside `.map()` without a rules-of-hooks violation. */
export const enter = (frame: number, fps: number, delay: number, rise = 14) => {
  const s = spring({ frame: frame - delay, fps, config: { damping: 200 } });
  return {
    opacity: interpolate(s, [0, 1], [0, 1]),
    transform: `translateY(${interpolate(s, [0, 1], [rise, 0])}px)`,
  };
};

/** The window's top chrome: traffic lights, workspace tabs, fleet count. */
const TopBar: React.FC = () => (
  <div
    style={{
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 58,
      display: "flex",
      alignItems: "center",
      gap: 22,
      padding: "0 26px",
      background: "rgba(8,14,26,0.55)",
      borderBottom: `1px solid ${T.hair}`,
      backdropFilter: "blur(10px)",
    }}
  >
    <span style={{ display: "flex", gap: 9 }}>
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <span key={c} style={{ width: 13, height: 13, borderRadius: "50%", background: c }} />
      ))}
    </span>

    <span style={{ fontFamily: mono, fontSize: 15, color: T.dim, letterSpacing: "0.16em" }}>
      LOTUS
    </span>

    <span style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: 8 }}>
      {[
        { t: "payments-api", on: true },
        { t: "schema", on: false },
      ].map((tab) => (
        <span
          key={tab.t}
          style={{
            fontFamily: sans,
            fontSize: 16,
            color: tab.on ? T.ink : T.faint,
            padding: "7px 15px",
            borderRadius: 9,
            background: tab.on ? "rgba(255,255,255,0.055)" : "transparent",
            boxShadow: tab.on ? `inset 0 0 0 1px ${T.hair}` : undefined,
          }}
        >
          {tab.t}
        </span>
      ))}
      <span style={{ color: T.faint, fontSize: 15, paddingLeft: 4 }}>+</span>
    </span>

    <span
      style={{
        marginLeft: "auto",
        display: "flex",
        alignItems: "center",
        gap: 20,
        fontFamily: mono,
        fontSize: 14,
        color: T.faint,
      }}
    >
      <span style={{ color: T.running }}>● 3 cells</span>
      <span>⌘K</span>
      <span>⚙</span>
    </span>
  </div>
);

/** The whole app window: navy gradient, void dot grid, traffic lights. */
export const CanvasFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: `linear-gradient(150deg, ${T.navy0} 0%, ${T.navy1} 46%, ${T.navy2} 100%)`,
      overflow: "hidden",
    }}
  >
    {/* `void` background theme: dots, gap 24, 5% white. */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        backgroundImage: `radial-gradient(${T.dot} 1px, transparent 1px)`,
        backgroundSize: `${T.dotGap}px ${T.dotGap}px`,
      }}
    />
    {/* A cool bloom toward the top, as in the app. */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(52% 40% at 42% -6%, rgba(96,165,250,0.16), transparent 70%)",
      }}
    />

    <TopBar />

    {children}
  </div>
);

export type Status = "running" | "waiting" | "idle" | "error" | "done";

const STATUS: Record<Status, { color: string; glyph: string; word: string }> = {
  running: { color: T.running, glyph: "●", word: "running" },
  waiting: { color: T.waiting, glyph: "▲", word: "waiting on you" },
  idle: { color: T.faint, glyph: "□", word: "idle" },
  error: { color: T.error, glyph: "✕", word: "verdict fail" },
  done: { color: T.running, glyph: "✓", word: "verdict pass" },
};

export const Pill: React.FC<{ status: Status; word?: string }> = ({ status, word }) => {
  const s = STATUS[status];
  return (
    <span
      style={{
        fontFamily: mono,
        fontSize: 14,
        letterSpacing: "0.09em",
        textTransform: "uppercase",
        color: s.color,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        whiteSpace: "nowrap",
      }}
    >
      <span>{s.glyph}</span>
      {word ?? s.word}
    </span>
  );
};

/**
 * A node window. Title bar carries `icon name · runner` on the left and the real
 * window controls on the right, exactly as the app does.
 */
export const NodeWindow: React.FC<{
  icon: string;
  name: string;
  runner?: string;
  accent?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ icon, name, runner, accent, style, children }) => (
  <div
    style={{
      background: T.panel,
      backdropFilter: "blur(12px) saturate(1.08)",
      borderRadius: 13,
      boxShadow: accent
        ? `inset 0 0 0 1px ${accent}, 0 18px 44px -18px rgba(0,0,0,0.7)`
        : `inset 0 0 0 1px ${T.hair}, 0 18px 44px -18px rgba(0,0,0,0.7)`,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      ...style,
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "12px 14px",
        background: T.bar,
        borderBottom: `1px solid ${T.hair}`,
        fontFamily: mono,
        fontSize: 15,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color: accent ?? T.dim, fontSize: 13, flexShrink: 0 }}>{icon}</span>
      <span style={{ color: T.ink, flexShrink: 0 }}>{name}</span>
      {runner ? (
        <>
          <span style={{ color: T.faint, flexShrink: 0 }}>·</span>
          <span style={{ color: T.dim, overflow: "hidden", textOverflow: "ellipsis" }}>{runner}</span>
        </>
      ) : null}
      <span
        style={{
          marginLeft: "auto",
          paddingLeft: 14,
          flexShrink: 0,
          display: "flex",
          gap: 12,
          color: T.faint,
          fontSize: 12,
        }}
      >
        <span>⤢</span>
        <span>⇱</span>
        <span>✕</span>
      </span>
    </div>
    {/* Column, so a scene can push a status row to the bottom with `marginTop: auto`. */}
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{children}</div>
  </div>
);

/** Terminal body. Lines are plain data so scenes stay readable. */
export type Line = { t: string; c?: string; dim?: boolean };

export const Term: React.FC<{ lines: readonly Line[]; shown: number }> = ({ lines, shown }) => (
  <div style={{ padding: "14px 16px", display: "grid", gap: 5 }}>
    {lines.slice(0, shown).map((l, i) => (
      <span
        key={i}
        style={{
          fontFamily: mono,
          fontSize: 15,
          lineHeight: 1.55,
          color: l.c ?? (l.dim ? T.faint : T.dim),
          whiteSpace: "pre",
        }}
      >
        {l.t || " "}
      </span>
    ))}
  </div>
);

/** The NL command bar, bottom centre, with the mic and the runner selector. */
export const NlBar: React.FC<{ text: string; caret?: boolean; style?: React.CSSProperties }> = ({
  text,
  caret,
  style,
}) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 14,
      width: 760,
      padding: "14px 18px",
      borderRadius: 14,
      background: "rgba(12,20,34,0.78)",
      backdropFilter: "blur(12px)",
      boxShadow: `inset 0 0 0 1px ${T.hair2}, 0 20px 50px -22px rgba(0,0,0,0.8)`,
      ...style,
    }}
  >
    <span style={{ fontFamily: sans, fontSize: 19, color: text ? T.ink : T.faint, flex: 1 }}>
      {text || "tell Bima to run the tests"}
      {caret ? <span style={{ color: T.info }}>▌</span> : null}
    </span>
    <span style={{ color: T.dim, fontSize: 17 }}>🎙</span>
    <span style={{ fontFamily: sans, fontSize: 16, color: T.dim }}>Lotus ⌄</span>
    <span style={{ color: T.faint, fontSize: 15 }}>⊞</span>
    <span style={{ color: T.faint, fontSize: 15 }}>⚙</span>
  </div>
);

export const ZoomCluster: React.FC<{ style?: React.CSSProperties }> = ({ style }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 16,
      padding: "10px 16px",
      borderRadius: 12,
      background: "rgba(12,20,34,0.7)",
      backdropFilter: "blur(10px)",
      boxShadow: `inset 0 0 0 1px ${T.hair}`,
      fontFamily: mono,
      fontSize: 14,
      color: T.dim,
      ...style,
    }}
  >
    <span>⤢</span>
    <span>−</span>
    <span style={{ color: T.ink }}>100%</span>
    <span>+</span>
    <span>◎</span>
  </div>
);

/** Caption. Sits over the canvas on a scrim so it stays readable. */
export const Caption: React.FC<{ children: React.ReactNode; enterStyle: React.CSSProperties }> = ({
  children,
  enterStyle,
}) => (
  <div
    style={{
      ...enterStyle,
      position: "absolute",
      left: 110,
      right: 110,
      // Top, not bottom: the bottom belongs to the NL command bar, which is one of
      // the most recognisable things on the real canvas. Below the top bar, not over it.
      top: 118,
      fontFamily: sans,
      fontSize: 31,
      lineHeight: 1.42,
      color: T.ink,
      textShadow: "0 2px 22px rgba(0,0,0,0.85)",
      maxWidth: 1230,
    }}
  >
    {children}
  </div>
);
