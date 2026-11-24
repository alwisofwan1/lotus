import type { Metadata } from "next";
import { CSP_VIOLATION_BUFFER_SCRIPT } from "@/lib/csp-violation-log";
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@fontsource-variable/atkinson-hyperlegible-mono";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/monaspace-neon/400.css";
import "@fontsource/monaspace-neon/500.css";
import "@fontsource/monaspace-neon/600.css";
// Whiteboard (CodeCanvas) fonts — Excalidraw parity, self-hosted.
import "@fontsource/nunito/400.css";
import "@fontsource/lilita-one/400.css";
import "@fontsource/comic-mono/400.css";
// CodeCanvas Artisan Theme fonts (--canvas-font-*): Caveat = handwritten display
// (theme names), Inter = body; JetBrains Mono (above) = mono. Self-hosted, offline.
import "@fontsource/caveat/400.css";
import "@fontsource/caveat/600.css";
import "@fontsource/caveat/700.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
// Note node paper look (ADR-0046): serif title face. Variable, so one file covers every weight.
import "@fontsource-variable/source-serif-4";
// Lantern Night's pair. A theme may only name a face from CANVAS_FONT_WHITELIST, but
// passing that check does not bundle anything: an unimported family is emitted into
// --canvas-font-* and then falls straight through to the fallback stack, silently.
// Five of the fourteen whitelisted names still have that gap; these two close it for
// the only built-in that does not use Caveat/Inter. (Of the five left, Söhne and Berkeley
// Mono are commercial and not on fontsource at all, so a theme must not name them until
// someone licenses and self-hosts the woff2.)
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
// The HUD bucket (--canvas-font-hud): a pixel face for the 8-10px status readout only.
// Silkscreen ships 400 and 700 and nothing else, which suits a bucket whose whole job is
// two or three sizes of badge text.
import "@fontsource/silkscreen/400.css";
import "@fontsource/silkscreen/700.css";
// Garden of Dawn's trio — the only light built-in, and the only theme using any of these three.
// Inherited from Crimson Zen, which it replaced, and re-argued rather than assumed; see the
// `fonts` note on GARDEN_OF_DAWN in builtin-themes.ts.
// Italics are bundled here where Lantern Night's pair skipped them: this theme's display and
// body faces are both serifs and land in a note node, where emphasis is markdown's own idiom,
// so a synthesised oblique of a high-contrast serif would be visible rather than merely wrong.
import "@fontsource/fraunces/400.css";
import "@fontsource/fraunces/400-italic.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/400-italic.css";
import "@fontsource/newsreader/500.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./globals.css";
import "../styles/design-system.css";
import "../styles/ui-kit.css";
import "../styles/codespace.css";
import "../styles/configure-layout.css";
// Every route, not only /canvas: Lotus Settings (mounted in AppShell) renders its sections inside a
// `codecanvas-shell` scope from any mode. Every rule in it is scoped to canvas classes.
import "../styles/canvas/index.css";
// App-level, not canvas-level: the music mini player follows the user onto every route.
import "../styles/music-mini-player.css";
import { AppShell } from "@/modules/shell";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { buildThemeBootstrapScript } from "@/lib/design-system";

export const metadata: Metadata = {
  title: "AgentTeams — Coding Platform",
  description: "Coordinate multiple Claude Code instances for your daily coding activities",
  icons: {
    icon: "/mark-light.png",
    apple: "/mark-light.png",
  },
};

function buildTauriCancelationGuardScript(): string {
  return `
    (() => {
      const isTauriCancelation = (reason) => {
        if (typeof reason === "string") {
          return reason.toLowerCase().includes("operation is manually canceled");
        }

        if (!reason || typeof reason !== "object") return false;

        const type = typeof reason.type === "string" ? reason.type.toLowerCase() : "";
        const message = [reason.msg, reason.message, reason.name]
          .filter((value) => typeof value === "string")
          .join(" ")
          .toLowerCase();

        return type === "cancelation"
          || type === "cancellation"
          || message.includes("operation is manually canceled")
          || message.includes("aborterror");
      };

      // Same check as isMonacoCancellationError (src/lib/monaco-cancellation.ts).
      const isMonacoCancellation = (reason) =>
        reason instanceof Error && reason.name === "Canceled" && reason.message === "Canceled";

      window.addEventListener("unhandledrejection", (event) => {
        if (!isTauriCancelation(event.reason) && !isMonacoCancellation(event.reason)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    })();
  `;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth" data-ui-ready="false">
      <body className="flex min-h-screen antialiased" style={{ backgroundColor: "var(--bg)" }}>
        {/* Plain inline scripts, not `next/script`: a `beforeInteractive` script is shipped as
            data (`self.__next_s`) and inserted by Next at runtime, which the production CSP blocks.
            Inline in the exported HTML, Tauri hashes each one into the CSP at build time. */}
        <script id="csp-violation-buffer" dangerouslySetInnerHTML={{ __html: CSP_VIOLATION_BUFFER_SCRIPT }} />
        <script id="tauri-cancelation-guard" dangerouslySetInnerHTML={{ __html: buildTauriCancelationGuardScript() }} />
        <script id="theme-bootstrap" dangerouslySetInnerHTML={{ __html: buildThemeBootstrapScript() }} />
        <ThemeProvider>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
