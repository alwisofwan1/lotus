/** Closes on the claim, over the same canvas ground. CTA is the waitlist — there is no download. */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import { display, enter, mono, sans, Pill } from "../ui";

export const Closing: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const at = (d: number) => enter(frame, fps, d);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        padding: "0 150px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 36,
      }}
    >
      <div
        style={{
          ...at(0),
          fontFamily: display,
          fontWeight: 600,
          fontSize: 92,
          letterSpacing: "-0.04em",
          lineHeight: 1.02,
          color: T.ink,
        }}
      >
        Draw how your agents work together.
        <span style={{ color: T.dim }}> Lotus runs it.</span>
      </div>

      <div style={{ ...at(14), display: "flex", gap: 34, alignItems: "center" }}>
        <Pill status="running" word="hand off" />
        <span style={{ fontFamily: mono, color: T.faint, fontSize: 18 }}>→</span>
        <Pill status="done" word="verify" />
        <span style={{ fontFamily: mono, color: T.faint, fontSize: 18 }}>→</span>
        <Pill status="waiting" />
      </div>

      <div style={{ ...at(28), display: "flex", alignItems: "center", gap: 24 }}>
        <span
          style={{
            fontFamily: sans,
            fontSize: 30,
            fontWeight: 500,
            color: T.navy2,
            background: T.ink,
            padding: "15px 32px",
            borderRadius: 999,
          }}
        >
          Request access
        </span>
        <span style={{ fontFamily: mono, fontSize: 26, color: T.dim }}>lotus-web.pages.dev</span>
      </div>
    </div>
  );
};
