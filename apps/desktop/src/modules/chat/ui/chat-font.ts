"use client";

import { useSyncExternalStore, type CSSProperties } from "react";

// The reading font of chat text (replies and your messages), set in Settings › Chat › Reading
// (mockups/chat-typography.html). Every face is already bundled in app/layout.tsx: offline, no new file.
// `scale` sets each face to the same visual size as Inter at 15px.
export const CHAT_FONTS = [
  { value: "inter", label: "Inter (default)", hint: "Clean and neutral. Lotus' own face.", stack: "Inter, -apple-system, sans-serif", scale: 1 },
  { value: "system", label: "System", hint: "San Francisco, as in the rest of macOS.", stack: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', scale: 1 },
  { value: "serif", label: "Serif", hint: "Source Serif. Calm, like a book, for long replies.", stack: '"Source Serif 4 Variable", Georgia, serif', scale: 1.08 },
  { value: "readable", label: "Hyperlegible", hint: "Atkinson Hyperlegible. Every letter is distinct.", stack: '"Atkinson Hyperlegible Next Variable", Inter, sans-serif', scale: 1.03 },
  { value: "mono", label: "Monospace", hint: "JetBrains Mono. Text reads like the terminal.", stack: '"JetBrains Mono", ui-monospace, monospace', scale: 0.9 },
] as const;

export type ChatFont = (typeof CHAT_FONTS)[number]["value"];

/** The CSS variables chat.css reads for chat text. */
export function chatFontStyle(font: ChatFont): CSSProperties {
  const face = CHAT_FONTS.find((f) => f.value === font) ?? CHAT_FONTS[0];
  return { "--chat-read-font": face.stack, "--chat-read-scale": face.scale } as CSSProperties;
}

const KEY = "lotus.chat.font";
const CHANGE = "lotus:chat-font";

function read(): ChatFont {
  try {
    const saved = localStorage.getItem(KEY);
    return CHAT_FONTS.some((f) => f.value === saved) ? (saved as ChatFont) : "inter";
  } catch {
    return "inter";
  }
}

export function setChatFont(font: ChatFont): void {
  localStorage.setItem(KEY, font);
  window.dispatchEvent(new Event(CHANGE));
}

function subscribe(onChange: () => void): () => void {
  // CHANGE for this window; `storage` for another Lotus window.
  window.addEventListener(CHANGE, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useChatFont(): ChatFont {
  return useSyncExternalStore(subscribe, read, () => "inter");
}
