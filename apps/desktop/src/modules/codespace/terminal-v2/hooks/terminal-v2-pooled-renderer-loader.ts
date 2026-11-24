"use client";

import type { TerminalTheme } from "@/lib/design-system";
import { createTerminalClipboardProvider } from "@/modules/codespace/services/terminal-clipboard-provider";
import {
  createTerminalV2ConstructorPooledXtermRendererFactory,
  createTerminalV2DefaultPooledXtermOptions,
  type TerminalV2PooledXtermClipboardAddonConstructor,
  type TerminalV2PooledXtermConstructor,
  type TerminalV2PooledXtermFitAddonConstructor,
  type TerminalV2PooledXtermRendererFactory,
  type TerminalV2PooledXtermSearchAddonConstructor,
  type TerminalV2PooledXtermSerializeAddonConstructor,
  type TerminalV2PooledXtermUnicode11AddonConstructor,
} from "../rendering/terminal-v2-pooled-xterm-renderer-factory";

export type LoadDefaultPooledXtermRendererFactoryOptions = {
  fontSize?: number;
  terminalTheme?: TerminalTheme;
};

export async function loadDefaultPooledXtermRendererFactory({
  fontSize,
  terminalTheme,
}: LoadDefaultPooledXtermRendererFactoryOptions = {}): Promise<TerminalV2PooledXtermRendererFactory> {
  const [
    { Terminal },
    { FitAddon },
    { SerializeAddon },
    { SearchAddon },
    { ClipboardAddon },
    { Unicode11Addon },
  ] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/addon-serialize"),
    import("@xterm/addon-search"),
    import("@xterm/addon-clipboard"),
    // Not optional decoration: without the Unicode 11 width tables xterm measures an emoji as one
    // cell while the font draws it as two, so every emoji in an agent's status line silently eats
    // the character next to it. The owned (non-pooled) renderer has always loaded this one.
    import("@xterm/addon-unicode11"),
  ]);
  return createTerminalV2ConstructorPooledXtermRendererFactory({
    terminalOptions: createTerminalV2DefaultPooledXtermOptions(fontSize, terminalTheme),
    TerminalCtor: Terminal as unknown as TerminalV2PooledXtermConstructor,
    FitAddonCtor: FitAddon as unknown as TerminalV2PooledXtermFitAddonConstructor,
    SerializeAddonCtor: SerializeAddon as unknown as TerminalV2PooledXtermSerializeAddonConstructor,
    SearchAddonCtor: SearchAddon as unknown as TerminalV2PooledXtermSearchAddonConstructor,
    // A provider is passed rather than letting the addon reach for the browser clipboard: an
    // OSC 52 arriving from a PTY has no user gesture behind it, and the refusal is thrown from
    // INSIDE `terminal.write()`, so it escaped up the write pump. See
    // `services/terminal-clipboard-provider.ts`.
    // Bound rather than subclassed: a bound constructor still produces a real `ClipboardAddon`
    // instance, so anything identifying the addon by its constructor keeps working.
    ClipboardAddonCtor: ClipboardAddon.bind(
      null,
      undefined,
      createTerminalClipboardProvider(),
    ) as unknown as TerminalV2PooledXtermClipboardAddonConstructor,
    Unicode11AddonCtor: Unicode11Addon as unknown as TerminalV2PooledXtermUnicode11AddonConstructor,
  });
}
