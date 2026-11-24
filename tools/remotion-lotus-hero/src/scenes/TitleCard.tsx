/** Opens on the claim, verbatim from apps/web copy.ts, over the real canvas ground. */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { T } from "../theme";
import { display, enter, mono } from "../ui";

export const TitleCard: React.FC = () => {
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
        gap: 28,
      }}
    >
      <div style={{ ...at(0), display: "flex", alignItems: "center", gap: 13 }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: T.waiting }} />
        <span
          style={{
            fontFamily: mono,
            fontSize: 16,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: T.dim,
          }}
        >
          Limited beta · macOS
        </span>
      </div>

      <div style={{ fontFamily: display, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1.02 }}>
        <div style={{ ...at(8), fontSize: 98, color: T.ink }}>
          Draw how your agents work together.
        </div>
        <div style={{ ...at(20), fontSize: 98, color: T.dim }}>Lotus runs it.</div>
      </div>
    </div>
  );
};
