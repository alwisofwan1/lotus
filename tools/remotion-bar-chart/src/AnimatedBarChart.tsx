import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type BarDatum = {
  label: string;
  value: number;
  color: string;
};

export type AnimatedBarChartProps = {
  title: string;
  subtitle: string;
  bars: BarDatum[];
};

const clampProgress = (value: number) => {
  return Math.max(0, Math.min(1, value));
};

export const AnimatedBarChart = ({
  title,
  subtitle,
  bars,
}: AnimatedBarChartProps) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const maxValue = Math.max(...bars.map((bar) => bar.value), 1);

  const titleOpacity = interpolate(frame, [0, fps * 0.6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  const gridOpacity = interpolate(frame, [fps * 0.4, fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: "#f8fafc",
        color: "#111827",
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: "92px 120px 104px",
      }}
    >
      <div
        style={{
          opacity: titleOpacity,
          transform: `translateY(${interpolate(titleOpacity, [0, 1], [24, 0])}px)`,
        }}
      >
        <div
          style={{
            color: "#475569",
            fontSize: 34,
            fontWeight: 700,
            letterSpacing: 0,
            marginBottom: 16,
          }}
        >
          {subtitle}
        </div>
        <h1
          style={{
            fontSize: 86,
            lineHeight: 1,
            letterSpacing: 0,
            margin: 0,
          }}
        >
          {title}
        </h1>
      </div>

      <div style={{ marginTop: 96, opacity: gridOpacity }}>
        <div
          style={{
            alignItems: "flex-end",
            borderBottom: "4px solid #111827",
            display: "grid",
            gap: 54,
            gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))`,
            height: 590,
            position: "relative",
          }}
        >
          {[0.25, 0.5, 0.75, 1].map((line) => (
            <div
              key={line}
              style={{
                background: "#dbe3ef",
                bottom: `${line * 100}%`,
                height: 2,
                left: 0,
                opacity: 0.85,
                position: "absolute",
                right: 0,
              }}
            />
          ))}

          {bars.map((bar, index) => {
            const grow = spring({
              frame,
              fps,
              delay: fps * 0.45 + index * 7,
              config: {
                damping: 22,
                mass: 0.9,
                stiffness: 95,
              },
            });
            const progress = clampProgress(grow);
            const percentHeight = (bar.value / maxValue) * 100 * progress;
            const valueOpacity = interpolate(progress, [0.2, 1], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });

            return (
              <div
                key={bar.label}
                style={{
                  alignItems: "center",
                  display: "flex",
                  flexDirection: "column",
                  height: "100%",
                  justifyContent: "flex-end",
                  minWidth: 0,
                  position: "relative",
                }}
              >
                <div
                  style={{
                    color: "#0f172a",
                    fontSize: 38,
                    fontWeight: 800,
                    marginBottom: 20,
                    opacity: valueOpacity,
                  }}
                >
                  {Math.round(bar.value * progress)}
                </div>
                <div
                  style={{
                    background: `linear-gradient(180deg, ${bar.color}, #0f172a)`,
                    borderRadius: "8px 8px 0 0",
                    boxShadow: "0 28px 44px rgba(15, 23, 42, 0.18)",
                    height: `${percentHeight}%`,
                    minHeight: progress > 0.03 ? 18 : 0,
                    width: "100%",
                  }}
                />
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: "grid",
            gap: 54,
            gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))`,
            marginTop: 28,
          }}
        >
          {bars.map((bar) => (
            <div
              key={bar.label}
              style={{
                color: "#334155",
                fontSize: 32,
                fontWeight: 700,
                lineHeight: 1.15,
                overflow: "hidden",
                textAlign: "center",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {bar.label}
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
