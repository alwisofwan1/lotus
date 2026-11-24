interface PixelIconProps {
  size?: number;
  className?: string;
}

// Helper: render a 16x16 pixel grid from a 2D color map
function PixelGrid({ pixels, size = 32, className }: { pixels: (string | null)[][]; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      className={className}
    >
      {pixels.map((row, y) =>
        row.map((color, x) =>
          color ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={color} /> : null
        )
      )}
    </svg>
  );
}

// Shorthand colors
const V1 = "#c4b5fd"; // violet light
const V2 = "#a78bfa"; // violet mid
const V3 = "#7c3aed"; // violet dark
const VE = "#1e1b4b"; // violet eye

const B1 = "#93c5fd"; // blue light
const B2 = "#60a5fa"; // blue mid
const B3 = "#2563eb"; // blue dark
const BE = "#1e3a5f"; // blue eye

const T1 = "#5eead4"; // teal light
const T2 = "#2dd4bf"; // teal mid
const T3 = "#0d9488"; // teal dark
const TE = "#134e4a"; // teal eye

const E1 = "#6ee7b7"; // emerald light
const E2 = "#34d399"; // emerald mid
const E3 = "#059669"; // emerald dark
const EE = "#064e3b"; // emerald eye

const S1 = "#7dd3fc"; // sky light
const S2 = "#38bdf8"; // sky mid
const S3 = "#0284c7"; // sky dark
const SE = "#0c4a6e"; // sky eye

const O1 = "#fdba74"; // orange light
const O2 = "#fb923c"; // orange mid
const O3 = "#ea580c"; // orange dark
const OE = "#431407"; // orange eye

const C1 = "#67e8f9"; // cyan light
const C2 = "#22d3ee"; // cyan mid
const C3 = "#0891b2"; // cyan dark
const CE = "#164e63"; // cyan eye

const _ = null;       // transparent

// Claude: blob creature with tentacles (like reference image)
function ClaudeIcon({ size, className }: PixelIconProps) {
  const px = [
    [_, _, _, _, _, V3, V3, V3, V3, V3, V3, _, _, _, _, _],
    [_, _, _, V3, V3, V2, V2, V2, V2, V2, V2, V3, V3, _, _, _],
    [_, _, V3, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V3, _, _],
    [_, V3, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V3, _],
    [_, V3, V2, V2, V1, V1, V2, V2, V2, V2, V1, V1, V2, V2, V3, _],
    [V3, V2, V2, V2, VE, VE, V2, V2, V2, V2, VE, VE, V2, V2, V2, V3],
    [V3, V2, V2, V2, VE, VE, V2, V2, V2, V2, VE, VE, V2, V2, V2, V3],
    [V3, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V3],
    [V3, V2, V2, V2, V2, V2, V2, V3, V3, V2, V2, V2, V2, V2, V2, V3],
    [_, V3, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V3, _],
    [_, V3, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V2, V3, _],
    [_, _, V3, V2, V3, V2, V2, V3, V3, V2, V2, V3, V2, V3, _, _],
    [_, _, _, V3, _, V3, V2, V3, V3, V2, V3, _, V3, _, _, _],
    [_, _, _, _, _, V3, V3, _, _, V3, V3, _, _, _, _, _],
    [_, _, _, _, _, V3, _, _, _, _, V3, _, _, _, _, _],
    [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
  ];
  return <PixelGrid pixels={px} size={size} className={className} />;
}

// Codex: book/codex creature
function CodexIcon({ size, className }: PixelIconProps) {
  const px = [
    [_, _, _, _, B3, B3, B3, B3, B3, B3, B3, B3, _, _, _, _],
    [_, _, _, B3, B2, B2, B2, B3, B2, B2, B2, B2, B3, _, _, _],
    [_, _, B3, B2, B2, B2, B2, B3, B2, B2, B2, B2, B2, B3, _, _],
    [_, _, B3, B2, B1, B1, B2, B3, B2, B1, B1, B2, B2, B3, _, _],
    [_, _, B3, B2, BE, BE, B2, B3, B2, BE, BE, B2, B2, B3, _, _],
    [_, _, B3, B2, BE, BE, B2, B3, B2, BE, BE, B2, B2, B3, _, _],
    [_, _, B3, B2, B2, B2, B2, B3, B2, B2, B2, B2, B2, B3, _, _],
    [_, _, B3, B2, B2, B2, B2, B2, B2, B2, B2, B2, B2, B3, _, _],
    [_, _, B3, B2, B2, B2, B2, B3, B2, B2, B2, B2, B2, B3, _, _],
    [_, _, B3, B2, B2, B2, B2, B3, B2, B2, B2, B2, B2, B3, _, _],
    [_, _, B3, B2, B2, B2, B2, B3, B2, B2, B2, B2, B2, B3, _, _],
    [_, _, B3, B3, B2, B2, B3, B3, B3, B2, B2, B3, B3, B3, _, _],
    [_, _, _, B3, B3, B3, B3, _, _, B3, B3, B3, B3, _, _, _],
    [_, _, _, _, B3, _, _, _, _, _, _, B3, _, _, _, _],
    [_, _, _, _, B3, _, _, _, _, _, _, B3, _, _, _, _],
    [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
  ];
  return <PixelGrid pixels={px} size={size} className={className} />;
}

// Gemini: twin-headed creature
function GeminiIcon({ size, className }: PixelIconProps) {
  const px = [
    [_, _, T3, T3, T3, _, _, _, _, _, _, T3, T3, T3, _, _],
    [_, T3, T2, T2, T2, T3, _, _, _, _, T3, T2, T2, T2, T3, _],
    [_, T3, T2, T1, T2, T3, _, _, _, _, T3, T2, T1, T2, T3, _],
    [_, T3, T2, TE, T2, T3, _, _, _, _, T3, T2, TE, T2, T3, _],
    [_, T3, T2, T2, T2, T3, _, _, _, _, T3, T2, T2, T2, T3, _],
    [_, _, T3, T2, T3, _, _, _, _, _, _, T3, T2, T3, _, _],
    [_, _, _, T3, T3, _, _, _, _, _, _, T3, T3, _, _, _],
    [_, _, _, _, T3, T3, T3, T3, T3, T3, T3, _, _, _, _, _],
    [_, _, _, _, _, T3, T2, T2, T2, T3, _, _, _, _, _, _],
    [_, _, _, _, _, T3, T2, T2, T2, T3, _, _, _, _, _, _],
    [_, _, _, _, T3, T2, T2, T2, T2, T2, T3, _, _, _, _, _],
    [_, _, _, _, T3, T2, T2, T2, T2, T2, T3, _, _, _, _, _],
    [_, _, _, _, T3, T2, T3, T3, T3, T2, T3, _, _, _, _, _],
    [_, _, _, _, T3, T3, _, _, _, T3, T3, _, _, _, _, _],
    [_, _, _, _, T3, _, _, _, _, _, T3, _, _, _, _, _],
    [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
  ];
  return <PixelGrid pixels={px} size={size} className={className} />;
}

// OpenCode: bracket <> creature
function OpenCodeIcon({ size, className }: PixelIconProps) {
  const px = [
    [_, _, _, _, _, _, E3, E3, E3, E3, _, _, _, _, _, _],
    [_, _, _, _, _, E3, E2, E2, E2, E2, E3, _, _, _, _, _],
    [_, _, _, _, E3, E2, E2, E2, E2, E2, E2, E3, _, _, _, _],
    [_, _, E3, E3, E2, E1, E1, E2, E2, E1, E1, E2, E3, E3, _, _],
    [_, E3, E2, E3, E2, EE, EE, E2, E2, EE, EE, E2, E3, E2, E3, _],
    [E3, E2, E2, _, E3, EE, EE, E2, E2, EE, EE, E3, _, E2, E2, E3],
    [E3, E2, _, _, _, E3, E2, E2, E2, E2, E3, _, _, _, E2, E3],
    [E3, E2, _, _, _, E3, E2, E3, E3, E2, E3, _, _, _, E2, E3],
    [E3, E2, _, _, _, E3, E2, E2, E2, E2, E3, _, _, _, E2, E3],
    [E3, E2, E2, _, E3, E2, E2, E2, E2, E2, E2, E3, _, E2, E2, E3],
    [_, E3, E2, E3, E2, E2, E2, E2, E2, E2, E2, E2, E3, E2, E3, _],
    [_, _, E3, E3, E2, E2, E2, E2, E2, E2, E2, E2, E3, E3, _, _],
    [_, _, _, _, E3, E2, E3, E3, E3, E3, E2, E3, _, _, _, _],
    [_, _, _, _, E3, E3, _, _, _, _, E3, E3, _, _, _, _],
    [_, _, _, _, E3, _, _, _, _, _, _, E3, _, _, _, _],
    [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
  ];
  return <PixelGrid pixels={px} size={size} className={className} />;
}

// Cursor: arrow pointer creature
function CursorIcon({ size, className }: PixelIconProps) {
  const px = [
    [_, S3, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
    [_, S3, S3, _, _, _, _, _, _, _, _, _, _, _, _, _],
    [_, S3, S2, S3, _, _, _, _, _, _, _, _, _, _, _, _],
    [_, S3, S2, S2, S3, _, _, _, _, _, _, _, _, _, _, _],
    [_, S3, S2, S2, S2, S3, _, _, _, _, _, _, _, _, _, _],
    [_, S3, S2, S1, S2, S2, S3, _, _, _, _, _, _, _, _, _],
    [_, S3, S2, S1, SE, S2, S2, S3, _, _, _, _, _, _, _, _],
    [_, S3, S2, S1, SE, S2, S2, S2, S3, _, _, _, _, _, _, _],
    [_, S3, S2, S2, S2, S2, S2, S2, S2, S3, _, _, _, _, _, _],
    [_, S3, S2, S2, S2, S2, S3, S3, S3, S3, S3, _, _, _, _, _],
    [_, S3, S2, S2, S3, S2, S2, S3, _, _, _, _, _, _, _, _],
    [_, S3, S3, S3, _, S3, S2, S2, S3, _, _, _, _, _, _, _],
    [_, _, _, _, _, _, S3, S2, S2, S3, _, _, _, _, _, _],
    [_, _, _, _, _, _, _, S3, S2, S2, S3, _, _, _, _, _],
    [_, _, _, _, _, _, _, _, S3, S3, S3, _, _, _, _, _],
    [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
  ];
  return <PixelGrid pixels={px} size={size} className={className} />;
}

// Droid: robot with dome head and antenna
function DroidIcon({ size, className }: PixelIconProps) {
  const px = [
    [_, _, _, _, _, _, _, O3, O3, _, _, _, _, _, _, _],
    [_, _, _, _, _, _, _, O3, O3, _, _, _, _, _, _, _],
    [_, _, _, _, _, O3, O3, O3, O3, O3, O3, _, _, _, _, _],
    [_, _, _, _, O3, O2, O2, O2, O2, O2, O2, O3, _, _, _, _],
    [_, _, _, O3, O2, O2, O2, O2, O2, O2, O2, O2, O3, _, _, _],
    [_, _, _, O3, O2, O1, O1, O2, O2, O1, O1, O2, O3, _, _, _],
    [_, _, _, O3, O2, OE, OE, O2, O2, OE, OE, O2, O3, _, _, _],
    [_, _, _, O3, O2, OE, OE, O2, O2, OE, OE, O2, O3, _, _, _],
    [_, _, _, O3, O2, O2, O2, O2, O2, O2, O2, O2, O3, _, _, _],
    [_, _, _, _, O3, O3, O3, O3, O3, O3, O3, O3, _, _, _, _],
    [_, _, _, _, _, O3, O2, O2, O2, O2, O3, _, _, _, _, _],
    [_, _, _, O3, O3, O3, O2, O2, O2, O2, O3, O3, O3, _, _, _],
    [_, _, _, O3, _, O3, O2, O2, O2, O2, O3, _, O3, _, _, _],
    [_, _, _, O3, _, O3, O3, O3, O3, O3, O3, _, O3, _, _, _],
    [_, _, _, _, _, _, O3, _, _, O3, _, _, _, _, _, _],
    [_, _, _, _, _, _, O3, _, _, O3, _, _, _, _, _, _],
  ];
  return <PixelGrid pixels={px} size={size} className={className} />;
}

// Copilot: pilot with helmet and wings
function CopilotIcon({ size, className }: PixelIconProps) {
  const px = [
    [_, _, _, _, _, C3, C3, C3, C3, C3, C3, _, _, _, _, _],
    [_, _, _, _, C3, C2, C2, C2, C2, C2, C2, C3, _, _, _, _],
    [_, _, _, C3, C2, C2, C2, C2, C2, C2, C2, C2, C3, _, _, _],
    [_, _, _, C3, C3, C3, C3, C3, C3, C3, C3, C3, C3, _, _, _],
    [_, _, _, C3, C1, CE, CE, C2, C2, CE, CE, C1, C3, _, _, _],
    [_, _, _, C3, C2, CE, CE, C2, C2, CE, CE, C2, C3, _, _, _],
    [_, _, _, _, C3, C2, C2, C2, C2, C2, C2, C3, _, _, _, _],
    [_, _, _, _, C3, C2, C2, C3, C3, C2, C2, C3, _, _, _, _],
    [_, C3, C3, _, _, C3, C3, C3, C3, C3, C3, _, _, C3, C3, _],
    [C3, C2, C2, C3, C3, C2, C2, C2, C2, C2, C2, C3, C3, C2, C2, C3],
    [C3, C2, C1, C2, C3, C2, C2, C2, C2, C2, C2, C3, C2, C1, C2, C3],
    [C3, C2, C2, C3, C3, C2, C2, C2, C2, C2, C2, C3, C3, C2, C2, C3],
    [_, C3, C3, _, C3, C2, C2, C2, C2, C2, C2, C3, _, C3, C3, _],
    [_, _, _, _, C3, C3, C2, C3, C3, C2, C3, C3, _, _, _, _],
    [_, _, _, _, _, C3, C3, _, _, C3, C3, _, _, _, _, _],
    [_, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _],
  ];
  return <PixelGrid pixels={px} size={size} className={className} />;
}

const ICON_MAP: Record<string, (props: PixelIconProps) => React.ReactElement> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  gemini: GeminiIcon,
  opencode: OpenCodeIcon,
  cursor: CursorIcon,
  droid: DroidIcon,
  copilot: CopilotIcon,
};

export function AgentPixelIcon({
  agentId,
  size = 32,
  className,
}: {
  agentId: string;
  size?: number;
  className?: string;
}) {
  const Icon = ICON_MAP[agentId];
  if (!Icon) return null;
  return <Icon size={size} className={className} />;
}
