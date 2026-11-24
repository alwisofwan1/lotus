export interface HomeModeCard {
  id: string;
  label: string;
  subtitle: string;
  description: string;
  kbd: string;
  href: string;
}

export const homeModeCards: HomeModeCard[] = [
  {
    id: "codecanvas",
    label: "CodeCanvas",
    subtitle: "Canvas",
    description:
      "Map agents, terminals, tasks, and handoffs on a visual workspace.",
    kbd: "⌘⇧C",
    href: "/canvas",
  },
  {
    id: "workspace",
    label: "Workspace",
    subtitle: "Terminal",
    description:
      "Open terminals, files, browser panes, and threads in one workspace.",
    // The chord stays ⌘T because that is what people press; only what it opens has changed.
    kbd: "⌘T",
    href: "/",
  },
  {
    id: "chat",
    label: "Chat (beta)",
    subtitle: "Chat",
    description: "The new chat: replays after a restart, shows every step the agent takes.",
    kbd: "⌘A",
    href: "/chat",
  },
];
