/**
 * The composition. Scene order is an argument, not a tour:
 *   title      the claim
 *   CodeSpace  the dense view — Bridge, context chips, two named agents
 *   CodeCanvas the payload — the same work as a board that runs
 *   closing    the claim again, plus where to go
 *
 * What this is: a stylised reconstruction of the product's own interface, in the
 * product's own palette. What it is not: a screen recording, and it never pretends to
 * be one. The first cut avoided window chrome entirely, reasoning that chrome would
 * make an animation feel like a fake screencast — that was wrong, and it produced a
 * generic architecture diagram that looked nothing like Lotus. The rule is "never
 * claim what is not real", not "never depict the real UI".
 */
import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { TIMELINE } from "./theme";
import { CanvasFrame } from "./ui";
import { TitleCard } from "./scenes/TitleCard";
import { SceneCodeSpace } from "./scenes/SceneCodeSpace";
import { SceneCodeCanvas } from "./scenes/SceneCodeCanvas";
import { Closing } from "./scenes/Closing";

export const LotusDemo: React.FC = () => (
  <AbsoluteFill>
    <CanvasFrame>
      <Sequence {...TIMELINE.title}>
        <TitleCard />
      </Sequence>
      <Sequence {...TIMELINE.codespace}>
        <SceneCodeSpace />
      </Sequence>
      <Sequence {...TIMELINE.codecanvas}>
        <SceneCodeCanvas />
      </Sequence>
      <Sequence {...TIMELINE.closing}>
        <Closing />
      </Sequence>
    </CanvasFrame>
  </AbsoluteFill>
);
