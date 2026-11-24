"use client";
import {
  ArrowRight,
  Command,
  LayoutTemplate,
  MessageSquareText,
  Settings,
  TerminalSquare,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { BrandMark } from "@/components/icons/BrandMark";
import type { CSSProperties } from "react";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { homeModeCards } from "@/modules/shell/config/home-modes";
import { useLotusSettings } from "@/modules/lotus-settings/lotus-settings-context";

const homeModeIcons = {
  codecanvas: LayoutTemplate,
  codespace: TerminalSquare,
  codeswarm: UsersRound,
  chat: MessageSquareText,
} as const;

function ShortcutHint({ kbd, label }: { kbd: string; label: string }) {
  return (
    <span className="home-launchpad-shortcut-item">
      <kbd className="home-launchpad-shortcut-kbd">
        {kbd}
      </kbd>
      <span className="home-launchpad-shortcut-label">
        {label}
      </span>
    </span>
  );
}

export function HomePage() {
  const router = useRouter();
  const { openSettings } = useLotusSettings();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;

      if (event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        router.push("/canvas");
      } else if (event.key === "t") {
        event.preventDefault();
        router.push("/");
      } else if (event.key === "a") {
        event.preventDefault();
        router.push("/chat");
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <div className="home-launchpad h-[calc(100dvh-var(--app-shell-top-offset,0px)-var(--windows-titlebar-h,0px))]">
      <div className="home-launchpad-stage">
        <header className="home-launchpad-topbar">
          <Link href="/" className="home-launchpad-brand" aria-label="Lotus home">
            <BrandMark className="home-launchpad-brand-mark" />
            <span>Lotus</span>
          </Link>
          <button type="button" onClick={() => openSettings()} className="home-launchpad-settings-pill">
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Settings</span>
            <kbd>⌘,</kbd>
          </button>
        </header>

        <main className="home-launchpad-main">
          <section className="home-launchpad-hero" aria-labelledby="home-launchpad-title">
            <p className="home-launchpad-eyebrow">
              <Command className="h-3.5 w-3.5" aria-hidden="true" />
              Local agent workbench
            </p>
            <h1 id="home-launchpad-title">Start a coding session.</h1>
            <p className="home-launchpad-subtitle">
              Open a workspace, delegate a task, or continue a chat.
            </p>
          </section>

          <nav className="home-launchpad-grid" aria-label="Lotus work modes">
            {homeModeCards.map((card, index) => (
              <Link
                key={card.id}
                href={card.href}
                className="home-launchpad-card"
                style={{ "--launchpad-item-index": index } as CSSProperties}
              >
                <HomeModeCardContent card={card} />
              </Link>
            ))}
          </nav>

          <aside className="home-launchpad-status-strip" aria-label="Workbench defaults">
            <StatusLine label="Workspace" value="Local" />
            <StatusLine label="Agents" value="Claude/Codex" />
            <StatusLine label="Review" value="Manual" />
          </aside>
        </main>

        <div className="home-launchpad-shortcuts" aria-label="Keyboard shortcuts">
          <ShortcutHint kbd="⌘⇧C" label="CODECANVAS" />
          <ShortcutHint kbd="⌘T" label="CODESPACE" />
          <ShortcutHint kbd="⌘S" label="CODESWARM" />
          <ShortcutHint kbd="⌘A" label="CODECHAT" />
          <ShortcutHint kbd="⌘," label="SETTINGS" />
        </div>
      </div>
    </div>
  );
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="home-launchpad-status-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HomeModeCardContent({ card }: { card: (typeof homeModeCards)[number] }) {
  const Icon = homeModeIcons[card.id as keyof typeof homeModeIcons] ?? TerminalSquare;

  return (
    <>
      <div className="home-launchpad-card-top">
        <span className="home-launchpad-card-icon">
          <Icon className="h-4.5 w-4.5" aria-hidden="true" />
        </span>
        <kbd className="home-launchpad-card-kbd">{card.kbd}</kbd>
      </div>
      <div className="home-launchpad-card-copy">
        <p className="home-launchpad-card-subtitle">{card.subtitle}</p>
        <h2 className="home-launchpad-card-title">{card.label}</h2>
        <p className="home-launchpad-card-description">{card.description}</p>
      </div>
      <span className="home-launchpad-card-action" aria-hidden="true">
        Open mode
        <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </>
  );
}
