import type { CanvasBrowserState } from "../types/canvas";

export interface BrowserIdentityInput {
  browserNumber?: number;
  label?: string | null;
  pageTitle?: string | null;
  url?: string | null;
  state?: CanvasBrowserState | string | null;
}

export interface BrowserRegistryEntry {
  id: string;
  name: string;
  aliases: string[];
  url: string;
  host: string;
  state: CanvasBrowserState | "unknown";
}

function cleanLabel(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function browserDefaultName(browserNumber: number | undefined): string {
  return `Browser ${typeof browserNumber === "number" && Number.isFinite(browserNumber) ? browserNumber : 1}`;
}

export function browserDisplayName(input: BrowserIdentityInput): string {
  return cleanLabel(input.label)
    || cleanLabel(input.pageTitle)
    || browserHost(input.url)
    || browserDefaultName(input.browserNumber);
}

export function normalizeBrowserLabel(input: string, fallback: string): string {
  const label = cleanLabel(input);
  return label || fallback;
}

export function browserHost(url: string | null | undefined): string {
  const value = cleanLabel(url);
  if (!value || value === "about:blank") return "";
  try {
    return new URL(value).host;
  } catch {
    return value.replace(/^https?:\/\//i, "").split("/")[0] ?? value;
  }
}

export function browserAliases(input: BrowserIdentityInput): string[] {
  const name = browserDisplayName(input);
  const defaultName = browserDefaultName(input.browserNumber);
  const host = browserHost(input.url);
  return Array.from(new Set([name, defaultName, host].filter(Boolean)));
}

export function browserRegistryEntry(id: string, input: BrowserIdentityInput): BrowserRegistryEntry {
  const state = input.state === "active" || input.state === "loading" || input.state === "disconnected"
    ? input.state
    : "unknown";
  return {
    id,
    name: browserDisplayName(input),
    aliases: browserAliases(input),
    url: cleanLabel(input.url) || "about:blank",
    host: browserHost(input.url),
    state,
  };
}
