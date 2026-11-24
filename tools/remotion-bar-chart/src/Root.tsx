import { Composition } from "remotion";
import { AnimatedBarChart, type AnimatedBarChartProps } from "./AnimatedBarChart";

const defaultChartProps = {
  title: "Quarterly Momentum",
  subtitle: "Animated five-bar performance chart",
  bars: [
    { label: "Alpha", value: 72, color: "#14b8a6" },
    { label: "Beta", value: 48, color: "#f97316" },
    { label: "Gamma", value: 86, color: "#2563eb" },
    { label: "Delta", value: 61, color: "#db2777" },
    { label: "Epsilon", value: 94, color: "#16a34a" },
  ],
} satisfies AnimatedBarChartProps;

export const RemotionRoot = () => {
  return (
    <Composition
      id="AnimatedBarChart"
      component={AnimatedBarChart}
      durationInFrames={150}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={defaultChartProps}
    />
  );
};
