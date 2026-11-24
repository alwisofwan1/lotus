import React from "react";
import { Composition } from "remotion";
import { loadFont as loadDisplay } from "@remotion/google-fonts/SchibstedGrotesk";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSans } from "@remotion/google-fonts/InstrumentSans";
import { LotusDemo } from "./LotusDemo";
import { FPS, TOTAL } from "./theme";

// Loaded through @remotion/google-fonts rather than a <link>: the renderer must not
// depend on network at render time, and a silent fallback would put the video in a
// different typeface than the site.
loadDisplay();
loadMono();
loadSans();

export const RemotionRoot: React.FC = () => (
  <Composition
    id="LotusDemo"
    component={LotusDemo}
    durationInFrames={TOTAL}
    fps={FPS}
    width={1920}
    height={1080}
  />
);
