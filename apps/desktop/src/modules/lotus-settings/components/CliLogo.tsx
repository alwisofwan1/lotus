import { SquareTerminal } from "lucide-react";
import { findSpec, listProviders } from "@/modules/codespace/services/bridge/agent-registry";

/**
 * The vendor's colour for a CLI's mark, or undefined to keep the ink. From the agent registry; the
 * vendors with black/white marks (Codex, Grok, Cursor, OpenCode, Copilot, Droid) follow the theme.
 */
export const CLI_TINTS: Record<string, string> = Object.fromEntries(
  listProviders().flatMap((spec) => (spec.tint ? [[spec.id, spec.tint]] : [])),
);

/** A CLI's mark in `currentColor` (the logo is a mask), so it follows the theme like `AgentMark`. */
/** `tint` paints the mark (a colour or a gradient) instead of `currentColor`. */
/** `brand` shows the vendor's colours: its own artwork for multi-colour marks, else its `CLI_TINTS` entry. */
export function CliLogo({ id, size = 14, tint, brand }: { id: string; size?: number; tint?: string; brand?: boolean }) {
  const spec = findSpec(id);
  const logo = spec?.logo;
  if (!logo) return <SquareTerminal size={size} strokeWidth={1.75} aria-hidden />;
  if (brand && spec.fullColourLogo) return <img src={logo} alt="" aria-hidden width={size} height={size} className="shrink-0" />;
  tint ??= brand ? CLI_TINTS[id] : undefined;
  const mask = `url("${logo}") center / contain no-repeat`;
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 bg-current"
      style={{ width: size, height: size, mask, WebkitMask: mask, ...(tint ? { background: tint } : {}) }}
    />
  );
}
