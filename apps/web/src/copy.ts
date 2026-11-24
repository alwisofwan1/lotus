/**
 * Every word on the site lives here.
 *
 * Two reasons, both from plans/lotus-web/:
 *
 * 1. Copy churns. Sections are composed from this file so a wording change never
 *    touches markup, and so i18n later is cheap without paying for it now
 *    (i18n itself is Out of scope — see map.md).
 *
 * 2. The site's credibility rests on facts derived from the product's source, and
 *    those do NOT live here — they live in `lib/facts`, each with a probe pointing
 *    at the file it came from, so `test/facts-match-source.test.ts` can read that
 *    source and fail when copy and code disagree. This file re-exports them so
 *    sections still import all their text from one place.
 *
 * FORBIDDEN CLAIMS bind everything in this file. See
 * plans/lotus-web/issues/06-strategi-go-to-market.md §7. The three most tempting
 * and factually WRONG ones:
 *   - "your code never leaves your machine" — false; Lotus drives vendor CLIs
 *     that send code to their APIs. Local means the process, not the data.
 *   - availability on any platform other than macOS (Apple Silicon) and Windows (x64,
 *     .github/workflows/release-windows.yml) — Linux is not built.
 *   - any Pocket availability or date claim — ADR-9.
 * Also: no speed or productivity numbers, no testimonials, no user counts, no
 * enterprise claims, and never repeat "lose track of none" as a guarantee outside
 * the <h1>.
 *
 * ── 2026-09-30, the revamp (plans/lotus-web/REVAMP.md) ──
 *
 * Ten sections and ~2,000 words became five blocks, and the picture became a live,
 * interactive rebuild of the app. Two decisions from the owner shape every string below:
 *
 *   · Option B. The headline keeps "Lotus runs it." as the vision, and the demo shows only
 *     what a user can reach. On 2026-10-03 the Run Node made a graph run reachable (⌘K
 *     "New Run from Selection" → Run, a member gate waits for you), so the description and
 *     the changelog say so; the demo itself does not draw a run yet.
 *   · Chat was shown as SOON until 2026-10-03. It had been live in the app; it is a view
 *     in the demo now.
 */

import { AGENT_CLIS, proof, runnerSupport } from "./lib/facts";

export { AGENT_CLIS, proof, runnerSupport };

export const site = {
  name: "Lotus",
  /** Locked in issues/01. Do not rewrite. It is the vision statement, not page copy —
   *  the demo below deliberately shows only the reachable part of it (Option B). */
  positioning:
    "Lotus is a native desktop workbench where you draw how your agents work together — and the graph you drew is what runs, with verifiers that can stop bad output and gates that wait for you.",
  /** The meta description. Option B (2026-09-30) took the gate out because no click could
   *  start a run; the Run Node (2026-10-03) made it reachable, so it is back. */
  description:
    "A native workbench for AI coding agents, for macOS and Windows. Agents, terminals, notes and music on one canvas; agents hand work to each other, and a run you drew waits at a gate for your decision.",
  /** Public builds since v0.2.3: Apple Silicon Macs and 64-bit Windows (see `download`). */
  platform: "macOS and Windows",
  stage: "Beta",
  /** The <title>. A bare product name tells a person nothing when the link is
   *  pasted into a chat, which is how nearly all of this launch's traffic arrives. */
  documentTitle: "Lotus — a local desktop workbench for AI coding agents",
  /** The home page's sitemap `lastmod`. Bump it when the landing copy or demo changes. */
  updated: "2026-11-21",
  /** The share-card text. Names only reachable behaviour (Option B): the old card's
   *  "verify, approve" described a graph run no click in the app can start (LOT2-65). */
  ogImageAlt:
    "Lotus logo and the line “Draw how your agents work together. Lotus runs it.”, above three steps: Say it, Answer, Show it.",
  /** The tab and home-screen colour: `--ground` in global.css. */
  themeColor: "#161513",
} as const;

/**
 * Structured data for search engines.
 *
 * Kept deliberately small and strictly true. The forbidden-claims list binds this
 * as much as visible copy — arguably more, because nobody proofreads JSON-LD:
 *   · no `offers` — pricing is Out of scope, so any price would be invented
 *   · no `downloadUrl` — the links are GitHub's `latest` redirects, not a stable file a
 *     crawler should index; the page names them
 *   · no `aggregateRating` — there are no users, let alone reviews
 *   · `operatingSystem` names the two built platforms and nothing more (no Linux)
 */
export const structuredData = {
  category: "DeveloperApplication",
  os: "macOS, Windows",
} as const;

/**
 * Where a demo video would go — and why it is `null` rather than a guess.
 *
 * The rendered video is real (`tools/remotion-lotus-hero`, 1920×1080, 30 fps) but nothing
 * is hosted. The live demo replaced the need for it on the page; this seam stays so the
 * duration claim remains under test the day a video is hosted, and so nobody types a
 * duration into markup. See `test/facts-match-source.test.ts`.
 */
export const demo = {
  /** The hosted video URL, or `null` while there is nowhere to point. */
  url: null as string | null,
  hostedLabel: "Watch the 42-second demo",
} as const;

/** The top bar. */
export const nav = {
  skip: "Skip to the product",
  changelog: "Changelog",
  /** In-page anchors, in page order. */
  links: [
    { label: "Product", href: "/#story" },
    { label: "Install", href: "/#install" },
    { label: "FAQ", href: "/#faq" },
  ],
} as const;

/** The proof strip's accessible name — the values themselves come from lib/facts. */
export const proofLabel = "Lotus in four facts";

/** Section 01. The headline is verbatim from issues/01 and pinned by a test. */
export const hero = {
  /** The agent count is AGENT_CLIS, which a test holds to apps/desktop/src/agents.json. */
  eyebrow: [site.stage, `${AGENT_CLIS.length} coding agents`, site.platform],
  headline: { lead: "Draw how your agents work together.", turn: "Lotus runs it." },
  /** "workspace", not "canvas": most of the eleven CLIs launch in Code panes, and only
   *  Claude Code, Codex and custom runners become canvas nodes (lib/facts AGENT_RUNNERS). */
  lede: "A native workbench for AI coding agents. They share one workspace, hand work to each other, and stop when they need you.",
  cta: { submit: "Get early access" },
  /** The line under the facts strip: every CLI the Code pane picker offers. */
  agents: { label: "Works with", own: "or your own CLI" },
  /** The promise, from issues/06 §3. Concrete because abstract promises measurably fail. */
  fineprint:
    "One build log every two weeks, an invite when macOS signing lands, one-click unsubscribe.",
  success: {
    lead: "On the list.",
    body: "Confirm the mail we just sent. Next log within two weeks.",
  },
  /**
   * Shown in place of the field while the list has nowhere safe to post — see
   * `lib/waitlist/config.ts`. It says what is true rather than disabling a button and
   * hoping nobody presses it: the alternative was a form that mailed addresses to an
   * unrelated person's newsletter.
   */
  closed: {
    label: "The list opens shortly",
    body: "The field is off rather than quietly dropping your address.",
  },
} as const;

/**
 * The download links. Stable `releases/latest/download/…` names, published from v0.2.3 on
 * (apps/desktop/scripts/release-macos.mjs, .github/workflows/release-windows.yml).
 * Apple Silicon and x64 only — never claim Intel Macs or ARM Windows.
 */
export const download = {
  header: "Download",
  mac: { label: "Download for macOS", href: "https://github.com/alwisofwan1/lotus/releases/latest/download/Lotus-macos-arm64.dmg" },
  win: { label: "Download for Windows", href: "https://github.com/alwisofwan1/lotus/releases/latest/download/Lotus-windows-x64-setup.exe" },
  all: { label: "All releases", href: "https://github.com/alwisofwan1/lotus/releases" },
  /** The builds are not notarized / Authenticode-signed yet, so the OS warns once. The steps
   *  live in `install`: right-click → Open stopped working on macOS 15 (Sequoia). */
  hint: "Apple Silicon Macs and 64-bit Windows. The first launch needs one extra step.",
  install: { label: "How to install", href: "/#install" },
} as const;

/** The last call, and the page's second signup placement (tagged `footer`). */
export const finalCta = {
  heading: { lead: "Draw it.", turn: "Lotus runs it." },
  body: "Beta for Apple Silicon Macs and 64-bit Windows. Bring the agent CLIs you already use.",
} as const;

/**
 * The changelog page. Releases come from `src/releases/*.md` (lib/releases.ts); `entries` is
 * the hand-written log from before the update feed, kept as history and never added to.
 */
export const buildLog = {
  title: "Changelog",
  heading: "What's new in Lotus.",
  lede: "Every release, newest first. Lotus installs updates itself; each version's files are on GitHub.",
  description: "Every Lotus release, newest first: what's new and what was fixed.",
  rss: "Follow by RSS",
  files: "Files",
  earlier: "Before the update feed",
  entries: [
    {
      date: "2026-10-03",
      kind: "Shipped",
      title: "Graph runs start from the canvas",
      body: "Select agents, a critic and a human gate, pick New Run from Selection in ⌘K, and press Run. The gate waits for your Approve or Reject, and every run shares one agent limit.",
    },
    {
      date: "2026-10-02",
      kind: "Shipped",
      title: "Automations got an inbox",
      body: "A review asked for in Slack becomes a room per pull request, with follow-up sessions and re-review. You can answer the agent in the run's thread, and nothing reaches other people until you press Send.",
    },
    {
      date: "2026-10-01",
      kind: "Shipped",
      title: "Agents read and write your notes",
      body: "Two new MCP tools let an agent read a note from any mode and append to it, replace it, or create one. Notes on the canvas look like paper now.",
    },
    {
      date: "2026-09-30",
      kind: "Shipped",
      title: "An editor you can stay in",
      body: "Go to any file with ⌘P, commit from Source with a suggested message, and get Compare, Reload or Overwrite when an agent changes a file you have open.",
    },
    {
      date: "2026-09-30",
      kind: "Shipped",
      title: "A new site, with the product running on it",
      body: "The landing page is now a live rebuild of the canvas: hand work to an agent, answer its prompt, mark a page for it.",
    },
    {
      date: "2026-08-23",
      kind: "In progress",
      title: "Signing and notarization: not done yet",
      body: "Builds are unsigned today, and that is the one thing standing between this list and an invite.",
    },
    {
      date: "2026-08-09",
      kind: "Shipped",
      title: "Permission requests reach a paired phone",
      body: "A stopped agent surfaces the command it wants to run; answering it remotely releases the turn on the desktop.",
    },
    {
      date: "2026-07-26",
      kind: "Fixed",
      title: "Reattached terminals no longer garble",
      body: "Scrollback replay raced the live stream on reattach. Output is now ordered against one ring buffer per session.",
    },
  ],
} as const;

/**
 * The privacy notice.
 *
 * This is a legal instrument, not a section of marketing copy, so it is written to
 * satisfy GDPR Art. 13(1)–(2) item by item: controller identity, purpose, legal
 * basis, recipients, third-country transfer, retention, the data-subject rights,
 * the right to withdraw, and the right to complain. A page that recites "we value
 * your privacy" and omits those is decoration.
 *
 * Two things here were checked against what the site actually does, because a
 * privacy notice that describes a different site is worse than none:
 *
 *   · **The page loads nothing from another origin.** Until 2026-09-30 the three
 *     typefaces came from Google Fonts, so every visitor's IP address reached Google
 *     and this notice disclosed it. They are self-hosted now (styles/fonts.css, all
 *     SIL OFL 1.1), and the disclosure went with them — test/privacy-notice.test.ts
 *     fails if either side comes back without the other.
 *   · **There is no analytics, no cookie, and no third-party script.** That is not
 *     a promise, it is enforced: `script-src 'self'` in the CSP, and the only
 *     cross-origin destination allowed anywhere is Buttondown's form endpoint.
 *     Grep the CSP before changing this sentence.
 *
 * The `<angle bracket>` values are unfilled on purpose and are a launch blocker,
 * the same convention `footer.postalAddress` already uses. Naming a controller we
 * have not decided on would be a fabrication, and inventing one on a legal page is
 * worse than leaving the gap visible.
 */
export const privacy = {
  title: "Privacy",
  /** The desktop app's policy is a page of its own (`privacyDesktop`); this points to it. */
  desktop: {
    before: "The Lotus desktop app, and what it does with a Google account you connect to it, has ",
    link: "its own privacy policy",
    href: "/privacy/desktop/",
  },
  updated: "2026-11-21",
  intro:
    "This site does exactly one thing with data: it takes an email address for the beta waiting list. This page says what happens to it, in the order the GDPR asks.",
  sections: [
    {
      heading: "Who is responsible",
      body: [
        "The controller of your data is <legal entity name>, <registered postal address>. Write to <privacy contact email> about anything on this page.",
        "There is no Data Protection Officer. At this size the law does not require one, and claiming a role nobody holds would be worse than saying so.",
      ],
    },
    {
      heading: "What we collect",
      body: [
        "Your email address, and one word recording which part of the site or which link you signed up from — `hero`, `footer`, `x`, `reddit`. That word exists so we know which channels are worth our time, and it is the only measurement on this site.",
        "Nothing else. No name, no company, no job title, no IP log of our own, no cookie, no analytics script, no session recording, no fingerprint. This page does carry two small scripts of its own: one animates the page and copies an install command when you press Copy, and one reads which operating system your browser reports, only to put that download first. They make no network request, store nothing, and send nothing anywhere.",
      ],
    },
    {
      heading: "Why, and on what basis",
      body: [
        "To send you a short build log roughly every two weeks, and an invite when the macOS build is signed. Nothing else — no ads, no selling, no sharing with anyone who is not listed below.",
        "The legal basis is your consent, GDPR Art. 6(1)(a), given when you submit the form and confirm the mail that follows. Giving us the address is entirely optional; the only consequence of not giving it is that you do not get an invite.",
      ],
    },
    {
      heading: "Who else sees it",
      body: [
        "Buttondown, the newsletter service that stores the list and sends the mail. They act as our processor and are in the United States, which is a transfer outside the EEA under Chapter V — covered by the Standard Contractual Clauses in their data-processing terms.",
        "Cloudflare, which serves this page and therefore sees the request. They do not receive the list.",
        "No font service. The three typefaces are hosted alongside this page, so loading it sends your IP address to Cloudflare and to no one else.",
        "Nobody else. No advertising network, no data broker, no affiliate.",
      ],
    },
    {
      heading: "How long we keep it",
      body: [
        "Until you unsubscribe, or until the beta list is closed and the invites have gone out — whichever comes first. When either happens the address is deleted from Buttondown rather than archived.",
      ],
    },
    {
      heading: "Your rights",
      body: [
        "You can ask for a copy of what we hold, correct it, have it deleted, restrict or object to what we do with it, or take it elsewhere in a portable form. Write to <privacy contact email> and we will act within one month, which is the deadline Art. 12(3) sets.",
        "You can withdraw consent at any time — every mail we send carries a one-click unsubscribe, and using it needs no explanation and no reply from us.",
        "Nothing here is automated decision-making or profiling in the sense of Art. 22. A person reads the list; no system scores you.",
      ],
    },
    {
      heading: "Complaints",
      body: [
        "If you think we have handled your data badly, tell us first — but you do not have to. You have the right to complain directly to your national supervisory authority, and doing so costs you nothing.",
      ],
    },
    {
      heading: "Changes",
      body: [
        "If this notice changes in a way that affects what happens to an address already on the list, we will say so in the build log rather than quietly editing this page. The date at the top is the last change.",
      ],
    },
  ],
} as const;

/**
 * The privacy policy of the Lotus desktop app — separate from the notice above, which is about
 * this website and its waiting list.
 *
 * It exists because Google requires one before the app's Google sign-in can leave Testing mode
 * (plans/google-connector, ADR-0044): a policy on the app's own domain that says what Google user
 * data the app touches, where it goes, and that its use follows the Google API Services User Data
 * Policy including Limited Use. The Limited Use sentence is Google's required disclosure and is
 * quoted, not paraphrased.
 *
 * Every factual sentence here is a property of desktop code, and `privacy-desktop.test.ts` holds
 * it there in both directions: the scopes Lotus asks for, what it reads from a sheet, where the
 * token is stored, that Disconnect revokes it, and that the agent never receives it. Change one of
 * those and this page must change with it, or the test fails.
 *
 * The controller is filled in with the developer's own details (2026-09-28): Lotus is built by one
 * person, and the contact email is the same support email Google's consent screen shows. No postal
 * address: Google's OAuth review asks for a policy and a contact, and inventing an address on a legal
 * page would be a fabrication.
 */
export const privacyDesktop = {
  title: "Lotus app privacy policy",
  updated: "2026-09-28",
  intro:
    "This policy is about the Lotus desktop app for macOS, and above all about what it does with your Google account when you connect it. The website and its waiting list have their own notice at /privacy/.",
  sections: [
    {
      heading: "Who is responsible",
      body: [
        "The controller of your data is Alwi Sofwan, the developer of Lotus. Write to dev@example.com about anything on this page.",
      ],
    },
    {
      heading: "Where the app runs",
      body: [
        "Lotus runs on your Mac. It has no server of its own and no account with us: nothing you do in the app is sent to the people who make Lotus. There is no analytics, no crash report and no telemetry sent to us.",
        "Lotus starts AI coding tools that you install and sign in to yourself, such as Claude Code. Those tools send your prompts and the files they work on to their own providers, under those providers' terms. That is how they work, and it is why this page does not claim your data stays on your computer. Optional features you turn on yourself — voice, notifications to your phone, GitHub, Slack, Notion — talk to the service you connected them to, in the same way.",
      ],
    },
    {
      heading: "What Lotus does with Google",
      body: [
        "Connecting Google is optional. When you do, Lotus signs you in through Google in your own browser and asks for three permissions: `openid` and `email`, only to show which account is connected, and `drive.file`. With `drive.file`, Lotus can reach only the files it created and the files you pick in Google's own Picker — nothing else in your Drive.",
        "Lotus uses that access for one feature: an automation you set up can add rows to a Google Sheet and save a report file to a Drive folder after each run. To do that it creates a sheet or a file, appends rows to it, uploads a file, and, for a sheet or folder you pick, reads its name, its link, its tab names and the first row of a tab (the column headers). It does not read the other contents of your sheets or files.",
      ],
    },
    {
      heading: "Where your Google data is kept",
      body: [
        "The sign-in token Google gives Lotus is kept in the macOS Keychain on your Mac. The short-lived access token is held only in memory. The connected account's email address and the granted permissions are kept in a file in the app's own folder, so the app can show them without opening the Keychain. None of this is sent to us.",
        "The AI agent an automation runs never receives the Google token and never writes to Google itself. It returns rows and text, and Lotus writes them. The agent is told the column names of the sheet it writes to — which can come from that sheet's first row — as part of the instructions you gave the automation, so those names reach the AI provider you chose, like the rest of your prompt.",
      ],
    },
    {
      heading: "Google API Services User Data Policy",
      body: [
        "Lotus's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements (https://developers.google.com/terms/api-services-user-data-policy).",
        "In plain terms: Google data is used only for the feature you set up, is never sold, never used for advertising, never used to train AI models, and is not read by any person.",
      ],
    },
    {
      heading: "Stopping and deleting",
      body: [
        "Disconnect in the app's Connectors ends Lotus's access at Google (it revokes the token) and deletes the token and the account file from your Mac. You can also remove Lotus at any time from your Google account at https://myaccount.google.com/permissions.",
        "The sheets and files Lotus created or wrote to are yours and stay in your Drive until you delete them. Results the app keeps on your Mac are deleted when you delete the automation or the app.",
      ],
    },
    {
      heading: "Your rights",
      body: [
        "Because the app keeps your Google data only on your own Mac, you can see, change or delete it there yourself. For anything else on this page — including a question about access, correction, deletion, restriction, objection or portability — write to dev@example.com, and we will answer within one month. You can also complain to your national supervisory authority.",
      ],
    },
    {
      heading: "Changes",
      body: [
        "If the app starts doing something new with Google data, this page changes first and says so at the top, and the app asks for any new permission in Google's own consent screen. The date at the top is the last change.",
      ],
    },
  ],
} as const;

/**
 * Footer. The postal address is a statutory requirement in every email we send
 * (CAN-SPAM §7704(a)(5)(iii)), and the privacy link must sit beside the form
 * (GDPR Art. 13(1)). Neither is optional decoration.
 */
export const footer = {
  blurb: "A local desktop workbench for AI coding agents",
  /** Still a placeholder, and a launch blocker for the MAIL, not for this page: CAN-SPAM
   *  wants the address in every email. Footer.astro renders it only once it is real, so
   *  visitors never see angle brackets; the privacy notice names the same placeholder. */
  postalAddress: "<registered postal address>",
  mailingLabel: "Mailing address",
  links: [
    { label: "Changelog", href: "/changelog/" },
    { label: "Privacy", href: "/privacy/" },
    // Google's brand verification requires the homepage to link the policy the OAuth consent
    // screen names, which is this one, not the website notice above (checked 2026-09-29).
    { label: "App privacy", href: "/privacy/desktop/" },
  ],
} as const;

/* ─────────────────────────────────────────────────────────────────────────────
   The redesign, 2026-11-21.

   The product is told once: one app window stays pinned while the page scrolls, and it
   changes scene per chapter. It replaced the interactive demo and the separate Factory,
   Automations and Chat sections. Chrome strings are the app's own and pinned by
   `test/copy-matches-product.test.ts`; agent output and names are dummy data.
   ───────────────────────────────────────────────────────────────────────────── */

/** How a line inside the window is inked. */
export type Tone = "ink" | "dim" | "mute" | "run" | "link" | "ask";
export interface Line {
  readonly text: string;
  readonly tone?: Tone;
}

export const story = {
  label: "The Lotus app, changing with each chapter.",
  project: "lotus-demo",
  /** ShellChrome's mode switch, in its order. */
  modes: ["Canvas", "Code", "Chat"],
  chapters: [
    {
      id: "canvas",
      kicker: "Canvas",
      title: "Draw the work.",
      body: "Agents, terminals, notes and music on one canvas, grouped in Frames. Say what you want and the composer builds it.",
      points: ["Mix agents from different vendors", "Type or talk to one composer"],
      /** Which mode tab is lit, and what the status pill says. `null`: opened from the rail. */
      mode: "Canvas",
      status: "lotus-demo",
    },
    {
      id: "handoff",
      kicker: "Hand-off",
      title: "Agents pass work to each other.",
      body: "Nara on Codex finishes the refactor and tells Bima on Claude Code to run the tests. Bima asks you before the risky part.",
      points: ["Any agent can message another by name", "Whoever needs you rises to the top"],
      mode: "Canvas",
      /** mode-status.ts wording: "need you", never "waiting". */
      status: "1 need you · 1 done",
    },
    {
      id: "chat",
      kicker: "Chat",
      title: "Ask one agent. It brings in others.",
      body: "Chat runs on Claude Code, Codex, Cursor or Antigravity. It delegates to child chats, each in its own worktree, and merges their branches back.",
      points: ["Fork from any finished turn", "The gauge shows how much context is left"],
      mode: "Chat",
      status: "2 children running",
    },
    {
      id: "factory",
      kicker: "Factory",
      title: "A ticket in. A pull request out.",
      body: "Pick an issue from GitHub or a page from Notion. Factory builds it in its own worktree, runs your checks, has it reviewed and opens the PR. It never merges. That stays yours.",
      points: [],
      mode: null,
      status: "Factory · 1 needs you",
    },
    {
      id: "automations",
      kicker: "Automations",
      title: "Work that starts without you.",
      body: "A trigger, an action, an output. Lotus watches Slack, GitHub or a schedule, does the work with your agents, and drafts the reply where the question was asked. You send it.",
      points: [],
      mode: null,
      status: "Automations · 1 running",
    },
  ],

  canvas: {
    frame: "Auth",
    /** The composer's target chip and a hint the app really shows (nl-hint-phrases.ts). */
    target: "→ Lotus",
    nlHint: "tell Bima to run the tests",
    nara: {
      name: "Nara",
      runner: "Codex",
      lines: [
        { text: "• Edited src/auth/middleware.ts", tone: "ink" },
        { text: "• Ran bun run lint" },
        { text: "  └ 0 problems", tone: "mute" },
      ],
    },
    bima: {
      name: "Bima",
      runner: "Claude Code",
      lines: [
        { text: "✻ Welcome to Claude Code!", tone: "mute" },
        { text: "  cwd: ~/lotus-demo", tone: "mute" },
      ],
    },
    terminal: {
      name: "Terminal 1",
      lines: [
        { text: "❯ bun dev", tone: "ink" },
        { text: " ✓ Ready in 1.2s", tone: "run" },
      ],
    },
    music: { name: "Music", source: "YouTube", title: "Late Night Coding — Lo-fi Mix", channel: "Midnight Tapes" },
    note: { label: "Note", body: "Sign in button is narrower than the fields" },
  },

  handoff: {
    /** The wire label the canvas draws for a hand-off edge. */
    wire: "triggers",
    done: "done",
    needsYou: "needs you",
    nara: [
      { text: "• Ran bun run lint" },
      { text: "  └ 0 problems", tone: "mute" },
      { text: "• Called lotus.lotus_dispatch_to_cell", tone: "ink" },
      { text: '  └ to Bima: "run the tests",', tone: "mute" },
      { text: "    replyTo Nara", tone: "mute" },
      { text: "─ Worked for 2m 14s ─", tone: "mute" },
    ],
    bima: [
      { text: "> run the tests  (from Nara)", tone: "ink" },
      { text: "⏺ Bash(bun test)", tone: "ink" },
      { text: "  ⎿  20 pass · 0 fail · 1.84s", tone: "mute" },
      { text: "⏺ Unit tests are green. Running the end-to-end suite next.", tone: "ink" },
    ],
  },

  /** Claude Code's own permission dialog, in the shape the app captured it in
   *  apps/desktop/src-tauri/src/permission_prompt_fixtures/bash-prompt-60col.txt (a test
   *  guards the wording). The digit is how it is answered: in the CLI, the app and Pocket. */
  permission: {
    title: "Bash command",
    command: "bun run e2e",
    question: "Do you want to proceed?",
    options: [
      { key: 1, label: "Yes" },
      { key: 2, label: "Yes, and always allow access to lotus-demo from this project" },
      { key: 3, label: "Yes, and switch to auto mode" },
      { key: 4, label: "No" },
    ],
    hint: "Esc to cancel · Tab to amend",
  },

  chat: {
    search: "Search threads",
    groups: { running: "Running", earlier: "Earlier" },
    parent: { title: "Split the settings refactor", sub: "lotus-demo · now" },
    kids: [
      { title: "Registry: 17 sections to 10", model: "Codex · high" },
      { title: "Settings tests", model: "Opus 5.5" },
    ],
    earlier: [
      { title: "Why does e2e fail only on CI?", sub: "lotus-demo · 4m" },
      { title: "Session TTL: config or env?", sub: "lotus-demo · 22m" },
    ],
    ask: "Split the settings refactor: one agent on the registry, one on the tests.",
    reply: "Two children started, each in its own worktree. I'll merge their branches when both are green.",
    merged: "merged",
    placeholder: "Ask anything…",
    gauge: "context 38% used",
  },

  factory: {
    name: "Factory",
    ticket: "#482",
    title: "Fix session expiry on refresh",
    steps: [
      { title: "Ticket", body: "Spec approved" },
      { title: "Worktree", body: "Fresh branch" },
      { title: "Implement", body: "Inside a budget cap" },
      { title: "Checks", body: "Your lint and tests" },
      { title: "Review", body: "A second agent" },
      { title: "Pull request", body: "Waits for you" },
    ],
    /** [stage, text, emphasis]. Example values. */
    log: [
      ["implement", "Claude Code · worktree ", "lotus/f-482"],
      ["implement", "Edited src/session/refresh.ts (+38 −12)", ""],
      ["checks", "bun run lint · ", "0 problems"],
      ["checks", "bun test · ", "142 pass"],
      ["review", "A second agent read the diff · ", "1 note, fixed"],
      ["pr", "Opened #483 · ", "never merged by Lotus"],
    ],
    pr: "Pull request ready: checks green, review done",
    needsYou: "needs you",
    meta: [
      ["stage", "pull request", ""],
      ["attempt", "2/3", ""],
      ["elapsed", "6m 12s", ""],
      ["cost", "$0.84", "of $5.00 cap"],
    ],
  },

  /** GLOSSARY: Automation, Trigger, Output, Draft. Anything addressed to other people waits
   *  as a draft for the user's send, so the copy says draft. */
  automations: {
    rule: [
      { tok: "WHEN", text: "someone asks for a PR review in #proj-web" },
      { tok: "DO", text: "review it, adding only what other reviewers have not said" },
      { tok: "REPLY", text: "a draft for the same Slack thread" },
    ],
    draft: {
      label: "DRAFT · #proj-web thread",
      text: "LGTM with 2 suggestions: the export skips archived rows, and the CSV header changed name.",
      send: "Send",
      edit: "Edit",
    },
    inbox: { title: "Inbox", running: "Running now · 1" },
    rows: [
      { title: "Review #482 · auth middleware", sub: "asked in #proj-web", state: "running" },
      { title: "Review #479 · billing export", sub: "LGTM with 2 suggestions. Send?", state: "needs you" },
      { title: "Weekday 09:00 · open issues digest", sub: "sent to you on Slack", state: "done" },
      { title: "Review #471 · search ranking", sub: "replied in thread", state: "done" },
    ],
  },
} as const;

/**
 * Lotus Pocket. A teaser, never an availability claim (ADR-9; forbidden-claims.test.ts): no
 * date, no store, no download. The phone wears Pocket's own tokens
 * (apps/pocket/lib/app/theme/app_tokens.dart) and its own words: the header's state word is
 * `needs you` (agent_activity.dart), the composer says "Type to session", and every answer
 * of the permission card has equal weight (ADR-8).
 */
export const pocket = {
  kicker: "Lotus Pocket",
  heading: ["When an agent asks,", "your phone knows."],
  body: "A companion app for the Lotus on your machine. It shows who is waiting and lets you answer from anywhere.",
  points: [
    { title: "A push when an agent waits", body: "Only for the agents that need you." },
    { title: "The real prompt, word for word", body: "Answer with the digit the agent printed." },
    { title: "Keep the work moving", body: "Read the terminal, type or dictate the next task." },
  ],
  status: "In development · not released yet",
  label: "Lotus Pocket on a phone: a notification says Bima needs you, and the permission prompt is answered with 1, Yes.",
  phone: {
    time: "9:41",
    push: { title: "Lotus · macbook", when: "now", body: "Bima — “Do you want to proceed?”" },
    agent: "Bima",
    sub: "Claude Code · lotus-demo",
    states: { asking: "needs you", after: "working" },
    after: "⏺ Bash(bun run e2e)",
    composer: "Type to session",
    mic: "Dictate",
  },
} as const;

/**
 * The one-time first-launch step. The builds are not notarized (macOS, "Lotus Self-Signed"
 * identity in apps/desktop/scripts/release-macos.mjs) and not Authenticode-signed (Windows),
 * so the OS warns once. Right-click → Open no longer bypasses Gatekeeper on macOS 15.
 */
export const install = {
  kicker: "Install",
  heading: ["First launch,", "one extra step."],
  body: "Your OS warns you once. That is expected for now.",
  why: {
    lead: "Why?",
    body: "Lotus is not notarized by Apple and has no Windows code-signing certificate yet. This step goes away when signing lands.",
  },
  tabsLabel: "Platform",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Select and copy",
  mac: {
    tab: "macOS",
    steps: [
      { title: "Download and install", body: "Open Lotus-macos-arm64.dmg and drag Lotus to Applications.", link: "Download .dmg" },
      {
        title: "Allow the app",
        body: "Paste this in Terminal. It removes the download quarantine flag.",
        command: "xattr -dr com.apple.quarantine /Applications/Lotus.app",
        or: "Or open Lotus once, then go to System Settings → Privacy & Security → Open Anyway.",
      },
      { title: "Open Lotus", body: "Updates install inside the app. You do this only once." },
    ],
  },
  win: {
    tab: "Windows",
    steps: [
      { title: "Download", body: "Get Lotus-windows-x64-setup.exe.", link: "Download .exe" },
      {
        title: "Pass SmartScreen",
        body: "Run the installer. Click More info → Run anyway.",
        or: "Or unblock the file first, in PowerShell:",
        command: 'Unblock-File "$env:USERPROFILE\\Downloads\\Lotus-windows-x64-setup.exe"',
      },
      { title: "Open Lotus", body: "Updates install inside the app. You do this only once." },
    ],
  },
} as const;

export const faq = {
  kicker: "FAQ",
  heading: "Questions.",
  items: [
    {
      q: "Why does macOS or Windows warn me?",
      a: "The builds are not notarized or code-signed yet. Follow the one-time step in Install.",
    },
    {
      q: "Which agents does Lotus run?",
      a: `${AGENT_CLIS.join(", ").replace(/, ([^,]+)$/, " and $1")}. You can add any other terminal agent as a custom runner. Lotus starts the CLIs you already have installed and signed in, on your own subscriptions.`,
    },
    {
      q: "Does my code stay on my machine?",
      a: "Lotus itself runs locally. The agents it starts send your code to their vendor's API, the same as when you run them in a terminal.",
    },
    {
      q: "Which platforms?",
      a: "Apple Silicon Macs and 64-bit Windows. There is no Intel Mac build.",
    },
    {
      q: "How do updates work?",
      a: "Lotus checks for a new version and installs it inside the app. Every release is in the changelog.",
    },
  ],
} as const;
