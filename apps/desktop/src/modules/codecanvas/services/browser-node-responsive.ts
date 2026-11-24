import type {
  CanvasBrowserOrientation,
  CanvasBrowserViewportMode,
  CanvasBrowserViewportPreset,
  CanvasBrowserScaleMode,
} from "../types/canvas";

export interface BrowserViewportPresetSpec {
  width: number;
  height: number;
  label: string;
}

export interface BrowserViewportProfile {
  mode: CanvasBrowserViewportMode;
  preset: CanvasBrowserViewportPreset;
  width: number;
  height: number;
  orientation: CanvasBrowserOrientation;
  scaleMode: CanvasBrowserScaleMode;
  zoomFactor: number;
  label: string;
}

export interface ResolveBrowserViewportProfileInput {
  mode?: CanvasBrowserViewportMode | null;
  orientation?: CanvasBrowserOrientation | null;
  scaleMode?: CanvasBrowserScaleMode | null;
  viewportWidth?: number | null;
  viewportHeight?: number | null;
  viewportZoom?: number | null;
  nodeWidth?: number | null;
  nodeHeight?: number | null;
}

export const BROWSER_VIEWPORT_PRESETS = {
  desktop: { width: 1440, height: 900, label: "Desktop" },
  tablet: { width: 820, height: 1180, label: "Tablet" },
  mobile: { width: 390, height: 844, label: "Mobile" },
} satisfies Record<Exclude<CanvasBrowserViewportPreset, "custom">, BrowserViewportPresetSpec>;

const MIN_CUSTOM_VIEWPORT = 240;
const MAX_CUSTOM_VIEWPORT = 2160;
const DEFAULT_NODE_WIDTH = 640;
const DEFAULT_NODE_HEIGHT = 420;
export const MIN_BROWSER_VIEWPORT_ZOOM = 0.35;
export const MAX_BROWSER_VIEWPORT_ZOOM = 1.25;
const BROWSER_VIEWPORT_ZOOM_STEP = 0.1;
const BROWSER_NODE_CHROME_HEIGHT = 88;
const BROWSER_NODE_TARGET_GUTTER = 16;

function clampViewportDimension(value: number | null | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if ((value as number) <= 0) return fallback;
  return Math.min(MAX_CUSTOM_VIEWPORT, Math.max(MIN_CUSTOM_VIEWPORT, Math.round(value as number)));
}

function resolveAutoPreset(nodeWidth: number, nodeHeight: number): Exclude<CanvasBrowserViewportPreset, "custom"> {
  const aspect = nodeWidth / Math.max(1, nodeHeight);
  if (aspect < 0.78 || nodeWidth < 460) return "mobile";
  if (aspect < 1.12 || nodeWidth < 620) return "tablet";
  return "desktop";
}

export function clampBrowserViewportZoom(value: number | null | undefined, fallback = 1): number {
  if (!Number.isFinite(value)) return fallback;
  const clamped = Math.min(MAX_BROWSER_VIEWPORT_ZOOM, Math.max(MIN_BROWSER_VIEWPORT_ZOOM, value as number));
  return Math.round(clamped * 100) / 100;
}

function fitBrowserViewportZoom(width: number, height: number, nodeWidth: number, nodeHeight: number): number {
  const availableWidth = Math.max(160, nodeWidth - BROWSER_NODE_TARGET_GUTTER);
  const availableHeight = Math.max(160, nodeHeight - BROWSER_NODE_CHROME_HEIGHT);
  return clampBrowserViewportZoom(Math.min(1, availableWidth / width, availableHeight / height));
}

function resolveViewportZoom(
  width: number,
  height: number,
  input: ResolveBrowserViewportProfileInput,
  nodeWidth: number,
  nodeHeight: number,
): number {
  if (input.viewportZoom != null) return clampBrowserViewportZoom(input.viewportZoom);
  if ((input.scaleMode ?? "fit") === "actual") return 1;
  return fitBrowserViewportZoom(width, height, nodeWidth, nodeHeight);
}

function orientPreset(
  preset: Exclude<CanvasBrowserViewportPreset, "custom">,
  requestedOrientation?: CanvasBrowserOrientation | null,
): Pick<BrowserViewportProfile, "width" | "height" | "orientation" | "label"> {
  const spec = BROWSER_VIEWPORT_PRESETS[preset];
  const naturalOrientation: CanvasBrowserOrientation = spec.width >= spec.height ? "landscape" : "portrait";
  const orientation = requestedOrientation ?? naturalOrientation;
  const shouldSwap = orientation === "landscape" ? spec.width < spec.height : spec.width > spec.height;
  const width = shouldSwap ? spec.height : spec.width;
  const height = shouldSwap ? spec.width : spec.height;
  return { width, height, orientation, label: spec.label };
}

export function resolveBrowserViewportProfile(input: ResolveBrowserViewportProfileInput): BrowserViewportProfile {
  const mode = input.mode ?? "auto";
  const scaleMode = input.scaleMode ?? "fit";
  const nodeWidth = clampViewportDimension(input.nodeWidth, DEFAULT_NODE_WIDTH);
  const nodeHeight = clampViewportDimension(input.nodeHeight, DEFAULT_NODE_HEIGHT);

  if (mode === "custom") {
    const width = clampViewportDimension(input.viewportWidth, BROWSER_VIEWPORT_PRESETS.desktop.width);
    const height = clampViewportDimension(input.viewportHeight, BROWSER_VIEWPORT_PRESETS.desktop.height);
    return {
      mode,
      preset: "custom",
      width,
      height,
      orientation: width >= height ? "landscape" : "portrait",
      scaleMode,
      zoomFactor: resolveViewportZoom(width, height, input, nodeWidth, nodeHeight),
      label: "Custom",
    };
  }

  const preset = mode === "auto" ? resolveAutoPreset(nodeWidth, nodeHeight) : mode;
  const oriented = orientPreset(preset, input.orientation);
  return {
    mode,
    preset,
    scaleMode,
    ...oriented,
    zoomFactor: resolveViewportZoom(oriented.width, oriented.height, input, nodeWidth, nodeHeight),
  };
}

export function rotateBrowserViewportProfile(profile: BrowserViewportProfile): BrowserViewportProfile {
  return {
    ...profile,
    width: profile.height,
    height: profile.width,
    orientation: profile.orientation === "landscape" ? "portrait" : "landscape",
  };
}

export function stepBrowserViewportZoom(
  profile: BrowserViewportProfile,
  direction: "in" | "out",
): number {
  const delta = direction === "in" ? BROWSER_VIEWPORT_ZOOM_STEP : -BROWSER_VIEWPORT_ZOOM_STEP;
  return clampBrowserViewportZoom(profile.zoomFactor + delta);
}
