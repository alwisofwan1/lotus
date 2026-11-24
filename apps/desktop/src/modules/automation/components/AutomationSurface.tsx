"use client";

import { CalendarClock, ChevronLeft, GitPullRequest, MessageCirclePlus, PanelLeft, Plus, X } from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { EmptyState, MenuItem, MenuLabel, MenuSeparator, ResourceMenu, ResourceTabs, SkeletonDetail, SplitButton } from "@/components/resource/resource-kit";
import { SplitHandle } from "@/modules/workspace-shell/components/SplitHandle";
import { useElementSize } from "@/modules/workspace-shell/hooks/useElementSize";
import { DEFAULT_LAYOUT, LAYOUT_BOUNDS, type ShellLayoutPreferences } from "@/modules/workspace-shell/services/layout-preferences";
import { clampSplitSize, computeSplitMax, SPLIT_HANDLE_SIZE } from "@/modules/workspace-shell/services/split-sizing";

import "@/styles/automation.css";

import { useAutomation } from "../hooks/useAutomation";
import { useAutomationLayout, type AutomationWidths } from "../hooks/useAutomationLayout";
import type { AutomationClient, AutomationDraft, AutomationProject, Subscribe } from "../services/automation-api";
import { needsAttention, pendingByAutomation, waitingItems } from "../services/inbox-model";
import type { OpenAskRequest } from "../services/open-ask-request";
import { FEED_MIN, surfaceFit } from "../services/surface-fit";
import { agentPromptFor, TEMPLATES, type AutomationTemplate } from "../services/templates";
import { AutomationBoundary } from "./AutomationBoundary";
import { AutomationDetail, ReviewNowSection } from "./AutomationDetail";
import { DockAutomation } from "./DockAutomation";
import { DockNew } from "./DockNew";
import type { AgentWatchHost, Watch } from "../services/agent-watch";
import { PrReviewForm, ScheduledPromptForm } from "./AutomationForms";
import { AutomationSidebar, type SidebarView } from "./AutomationSidebar";
import { BrowseTab, TemplateIconView } from "./BrowseTab";
import { ChannelHeader } from "./ChannelHeader";
import { CreateWithAgent } from "./CreateWithAgent";
import { InboxTab } from "./InboxTab";
import { InstalledTab } from "./InstalledTab";
import { isBusy, RunningNow } from "./RunningNow";

/**
 * Automations, laid out like Slack: a sidebar of views and one channel per automation, the feed
 * in the middle, and a right pane that reads the open item (or shows Settings, or the composer).
 *
 * Host-agnostic on purpose: everything it needs from where it is mounted comes in through these
 * props (the host contract), and it sizes itself from its own measured width (`surfaceFit`), so the
 * same surface works over Code, beside Chat's rail, or in a narrow Canvas panel. `AutomationPanel`
 * wires the app's own client for hosts that have nothing to pass.
 *
 * Nothing here posts on its own. A review reaches GitHub only through "Send to GitHub", always as
 * a COMMENT review; a channel post only through "Send to channel". Connections (Slack, GitHub)
 * live in their own surface, Connectors.
 */

export interface AutomationSurfaceProps {
  client: AutomationClient;
  subscribe: Subscribe;
  onClose: () => void;
  /** Opens an agent with this prompt; resolves to why not. Absent when there is nowhere to open one. */
  onCreateWithAgent?: (prompt: string) => Promise<string | null>;
  /**
   * A host that can show the agent it opens (the canvas): the Dock's New page then follows it in
   * three steps instead of handing it off (16e v2). Absent: `onCreateWithAgent` as before.
   */
  agentWatch?: AgentWatchHost;
  /** Steps over to Connectors, where Slack and GitHub are set up. */
  onOpenConnectors?: () => void;
  /** The window's workspaces: the projects an automation can run its panes in. */
  projects?: AutomationProject[];
  /** An Ask to show in Inbox (its notification was followed); `seq` changes for each request. */
  openAsk?: OpenAskRequest | null;
  /** The host's stored layout, for the two seam widths. Absent keeps them in this browser's storage. */
  layout?: AutomationWidths;
  onLayoutChange?: (patch: Partial<ShellLayoutPreferences>) => void;
  /**
   * The host's own sidebar, to draw the automation sidebar in (the shell's rail), so the window has
   * one sidebar and not two. Absent: the surface draws its own. `null`: the host has one but has not
   * mounted it yet, so nothing is drawn for a moment rather than a second sidebar flashing in.
   */
  navTarget?: HTMLElement | null;
  /**
   * Other work that waits for the user, shown at the top of Inbox and counted in its badge — a
   * Factory Run's questions or spec (FI2). The host knows what each is; Inbox only lists and opens.
   */
  waitingElsewhere?: WaitingElsewhere[];
  /** Opens on this automation's channel, with its settings, instead of Inbox (from Connectors › Used by). */
  initialChannel?: string | null;
  /**
   * `dock`: the Canvas Dock's quiet list (`.pen` 16 v2). No sidebar: the tabs are the header
   * (Inbox · Automations · Sent), Running is one live line on top of Inbox, finished work lives in
   * Sent only, and New is an icon. The Dock's own rail closes and widens it.
   */
  variant?: "full" | "dock";
}

export interface WaitingElsewhere {
  id: string;
  /** e.g. `Factory`. */
  source: string;
  title: string;
  /** What it waits for, in a few words. */
  line: string;
  onOpen: () => void;
}

type Route = { page: "view"; view: SidebarView } | { page: "new"; kind: "agent_prompt" | "pr_review" } | { page: "edit"; id: string };
/** What the right pane shows in Inbox and in a channel: the open item, or the channel's Settings. */
type PaneMode = "reader" | "settings";
type ChannelTab = "open" | "waiting" | "done";

const NAV = LAYOUT_BOUNDS.automationNavWidth;
const PANE = LAYOUT_BOUNDS.automationPaneWidth;
const SEAM = SPLIT_HANDLE_SIZE;

const VIEW_COPY = {
  inbox: ["Inbox", "Everything automations made that needs you. Nothing reaches other people until you send it."],
  running: ["Running now", "Runs working right now, with what each agent is doing."],
  sent: ["Sent", "Reviews you sent, questions you answered, and results already delivered."],
  all: ["All automations", "Work Lotus runs on its own: on a schedule, or when someone asks for a review in Slack."],
  browse: ["Browse examples", "Start from an example, or build one yourself."],
} as const;

const CHANNEL_SHOW = { open: "all", waiting: "waiting", done: "done" } as const;

export function AutomationSurface({
  client,
  subscribe,
  onClose,
  onCreateWithAgent,
  agentWatch,
  onOpenConnectors,
  projects = [],
  openAsk = null,
  layout,
  onLayoutChange,
  navTarget,
  waitingElsewhere = [],
  variant = "full",
  initialChannel = null,
}: AutomationSurfaceProps) {
  const state = useAutomation(client, subscribe);
  const [route, setRoute] = useState<Route>(() =>
    initialChannel ? { page: "view", view: { kind: "channel", id: initialChannel } } : { page: "view", view: { kind: "inbox" } },
  );
  const [paneMode, setPaneMode] = useState<PaneMode>(() => (initialChannel ? "settings" : "reader"));
  const [channelTab, setChannelTab] = useState<ChannelTab>("open");
  /** A Dock reopened while its agent still runs lands back on New, where the watch is. */
  const [composing, setComposing] = useState(() => variant === "dock" && Boolean(agentWatch?.kept));
  /**
   * The Dock's watched "Describe it to an agent": kept here so leaving New and coming back finds it,
   * and mirrored to the host, which outlives a closed Dock (this surface unmounts with it).
   */
  const [watch, setWatchState] = useState<Watch | null>(() => agentWatch?.kept ?? null);
  const setWatch = (next: Watch | null) => {
    setWatchState(next);
    agentWatch?.keep?.(next);
  };
  /**
   * The right pane is closed until the user opens something into it (a row, Settings, the
   * composer, a Browse preview), as a thread opens in Slack, and closes again with its X or Esc.
   * The feed takes the full width while it is closed.
   */
  const [paneOpen, setPaneOpen] = useState(() => Boolean(initialChannel));
  /** Narrow hosts only: the sidebar drawer is open. */
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [readerEl, setReaderEl] = useState<HTMLDivElement | null>(null);

  // A new request to show an Ask moves to Inbox (adjusted while rendering, not in an effect).
  const askSeq = openAsk?.seq;
  const [shownSeq, setShownSeq] = useState(askSeq);
  if (askSeq !== shownSeq) {
    setShownSeq(askSeq);
    if (askSeq !== undefined) {
      setRoute({ page: "view", view: { kind: "inbox" } });
      setPaneMode("reader");
      setPaneOpen(true);
    }
  }

  const [widths, setWidths] = useAutomationLayout(layout, onLayoutChange);
  const [bodyRef, body] = useElementSize<HTMLDivElement>();
  const dock = variant === "dock";
  // The Dock draws no sidebar at all: like a hosted one, it never takes this surface's width.
  const hostedNav = dock || navTarget !== undefined;
  const fit = surfaceFit(body.width, { hostedNav });
  const overlay = fit.pane === "overlay";
  const drawer = fit.nav === "drawer";

  // One reading of "waiting" for every count and list (services/inbox-model).
  const waiting = waitingItems(state.drafts, state.results);
  const pending = pendingByAutomation(waiting);
  const attention = needsAttention(state.automations, state.runs);
  const inboxCount = waiting.length + waitingElsewhere.length + attention.length;
  const runningCount = state.runs.filter(isBusy).length;
  // A dev build's `standby` session still posts DMs and lists channels.
  const slackConnected = state.slack?.state === "connected" || state.slack?.state === "standby";
  const openConnectors = onOpenConnectors ?? (() => undefined);

  const view = route.page === "view" ? route.view : null;
  const channelId = view?.kind === "channel" ? view.id : null;
  const channel = channelId ? state.automations.find((a) => a.id === channelId) : undefined;
  const editing = route.page === "edit" ? state.automations.find((a) => a.id === route.id) : undefined;

  const go = (next: SidebarView) => {
    setTemplateError(null);
    setRoute({ page: "view", view: next });
    setChannelTab("open");
    setPaneOpen(false);
    setDrawerOpen(false);
    setComposing(false);
    setPaneMode("reader");
  };
  const toChannel = (id: string, mode: PaneMode = "settings") => {
    setRoute({ page: "view", view: { kind: "channel", id } });
    setChannelTab("open");
    setPaneMode(mode);
    setPaneOpen(mode === "settings");
  };
  /** The header's Settings button toggles: pressed again, it closes the pane. */
  const openSettings = () => {
    setComposing(false);
    if (paneOpen && paneMode === "settings") return closePane();
    setPaneMode("settings");
    setPaneOpen(true);
  };
  /** The composer opens over whatever the pane shows; closing it goes back to that. */
  const compose = () => {
    setComposing(true);
    setDrawerOpen(false);
  };
  /** Closes the pane, whatever it shows. The open row stays selected, so opening it again is one press. */
  function closePane() {
    setComposing(false);
    setPaneMode("reader");
    setPaneOpen(false);
  }

  const startTemplate = (template: AutomationTemplate) => {
    setTemplateError(null);
    if (!onCreateWithAgent) {
      setTemplateError("Open Code mode with a workspace first: the agent needs a pane to run in.");
      return;
    }
    void onCreateWithAgent(agentPromptFor(template.request)).then((error) => error && setTemplateError(error));
  };

  // The right pane: the composer over anything; otherwise Inbox's and a channel's reader or Settings.
  // In the Dock, one automation is its own page (16d), with no Settings pane beside it.
  const reads = view?.kind === "inbox" || view?.kind === "browse" || (!dock && Boolean(channel) && (channelTab !== "done" || paneMode === "settings"));
  const settingsShown = !dock && Boolean(channel) && paneMode === "settings" && !composing;
  // Closed until the user opens something into it; on a narrow host it then covers the feed.
  // In the Dock, New is its own page (16e), not the pane.
  const paneShown = (composing && !dock) || (paneOpen && reads);

  const navInline = fit.nav === "inline";
  const navMax = Math.min(NAV.max, computeSplitMax(body.width - (paneShown && !overlay ? widths.automationPaneWidth + SEAM : 0), FEED_MIN, NAV.min));
  const navSize = clampSplitSize(widths.automationNavWidth, { min: NAV.min, max: navMax });
  const paneRoom = body.width - (navInline ? navSize + SEAM : 0);
  const paneMax = overlay ? Math.max(PANE.min, paneRoom) : Math.min(PANE.max, computeSplitMax(paneRoom, FEED_MIN, PANE.min));
  const paneSize = clampSplitSize(widths.automationPaneWidth, { min: PANE.min, max: paneMax });

  // Escape steps back one level; with nothing to step back from it is the host's (closing the panel).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, details[open]")) return;
    let handled = true;
    if (drawerOpen) setDrawerOpen(false);
    else if (composing) setComposing(false);
    else if (paneShown) closePane();
    else if (route.page === "edit") toChannel(route.id);
    else if (route.page === "new") go({ kind: "inbox" });
    else handled = false;
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const newButton = (
    <SplitButton icon={<MessageCirclePlus size={14} aria-hidden />} label="New automation" onClick={compose} menuLabel="More ways to create">
      <MenuLabel>Examples</MenuLabel>
      {TEMPLATES.map((t) => (
        <MenuItem key={t.id} icon={<TemplateIconView icon={t.icon} size={14} />} onSelect={() => startTemplate(t)}>
          {t.title}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>Build it yourself</MenuLabel>
      <MenuItem icon={<CalendarClock size={14} />} onSelect={() => setRoute({ page: "new", kind: "agent_prompt" })}>
        Scheduled prompt
      </MenuItem>
      <MenuItem icon={<GitPullRequest size={14} />} onSelect={() => setRoute({ page: "new", kind: "pr_review" })}>
        PR review
      </MenuItem>
    </SplitButton>
  );

  const dockNew = (
    <ResourceMenu className="au-dock-new" label="New automation" trigger={<Plus size={15} strokeWidth={1.75} aria-hidden />}>
      <MenuItem icon={<MessageCirclePlus size={14} />} onSelect={compose}>
        Describe it to an agent
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>From an example</MenuLabel>
      {TEMPLATES.map((t) => (
        <MenuItem key={t.id} icon={<TemplateIconView icon={t.icon} size={14} />} onSelect={() => startTemplate(t)}>
          {t.title}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>Build it yourself</MenuLabel>
      <MenuItem icon={<CalendarClock size={14} />} onSelect={() => setRoute({ page: "new", kind: "agent_prompt" })}>
        Scheduled prompt
      </MenuItem>
      <MenuItem icon={<GitPullRequest size={14} />} onSelect={() => setRoute({ page: "new", kind: "pr_review" })}>
        PR review
      </MenuItem>
    </ResourceMenu>
  );

  const navToggle = drawer ? (
    <button
      type="button"
      className="rs-icon-button au-nav-toggle"
      aria-label="Show automations sidebar"
      aria-expanded={drawerOpen}
      title="Sidebar"
      onClick={() => setDrawerOpen((open) => !open)}
    >
      <PanelLeft size={15} strokeWidth={1.75} aria-hidden />
    </button>
  ) : null;

  const only = <T extends { automationId: string }>(items: T[], id: string | null) => (id ? items.filter((d) => d.automationId === id) : items);
  const feed = (id: string | null, show: "all" | "waiting" | "done" = "all") => (
    <InboxTab
      // A new request remounts the list, so it opens on that Ask whatever was open before.
      key={`${id ?? askSeq ?? "inbox"}:${show}`}
      initialSelectedId={id ? null : (openAsk?.id ?? null)}
      drafts={only(state.drafts, id) as AutomationDraft[]}
      results={only(state.results, id) as AutomationDraft[]}
      sent={only(state.sent, id) as AutomationDraft[]}
      answered={only(state.answered, id) as AutomationDraft[]}
      automations={state.automations}
      client={client}
      loaded={state.loaded}
      runs={only(state.runs, id)}
      projects={projects}
      readerTarget={readerEl}
      hideReader={composing || settingsShown}
      show={show}
      onOpenItem={() => setPaneOpen(true)}
      readerOpen={paneShown && !composing && !settingsShown}
      quiet={dock}
      onOpenAutomation={(id) => go({ kind: "channel", id })}
    />
  );

  const notices = (
    <>
      {state.error ? (
        <p className="au-error" role="alert">
          Could not load automations: {state.error}{" "}
          <button type="button" className="au-link" onClick={() => void state.refresh()}>
            Retry
          </button>
        </p>
      ) : null}
      {templateError ? (
        <p className="au-error" role="alert">
          {templateError}
        </p>
      ) : null}
    </>
  );

  const scroll = (children: ReactNode, form = false) => (
    <div className="au-main-scroll">
      <div className={form ? "au-main-inner au-main-inner--form" : "au-main-inner"}>{children}</div>
    </div>
  );

  const middle = () => {
    if (dock && composing) {
      return (
        <DockNew
          host={agentWatch}
          onCreateWithAgent={onCreateWithAgent}
          automations={state.automations}
          client={client}
          watch={watch}
          onWatch={setWatch}
          onBack={() => setComposing(false)}
          onOpen={(id) => {
            setWatch(null);
            go({ kind: "channel", id });
          }}
        />
      );
    }
    if (route.page === "new") {
      const prompt = route.kind === "agent_prompt";
      return scroll(
        <>
          {navToggle}
          <h1 className="au-page-title">{prompt ? "New scheduled prompt" : "New PR review"}</h1>
          {prompt ? (
            <ScheduledPromptForm
              client={client}
              presets={state.presets}
              accounts={state.ghAccounts}
              projects={projects}
              slackConnected={slackConnected}
              onSaved={(a) => toChannel(a.id)}
              onCancel={() => go({ kind: "inbox" })}
            />
          ) : (
            <PrReviewForm
              client={client}
              presets={state.presets}
              accounts={state.ghAccounts}
              projects={projects}
              onSaved={(a) => toChannel(a.id)}
              onCancel={() => go({ kind: "inbox" })}
            />
          )}
        </>,
        true,
      );
    }
    if (route.page === "edit") {
      if (!editing) return scroll(state.loaded ? <p className="au-note">This automation no longer exists.</p> : <SkeletonDetail label="Loading automation" />, true);
      const back = () => toChannel(editing.id);
      return scroll(
        <>
          {navToggle}
          <h1 className="au-page-title">Edit “{editing.name}”</h1>
          {editing.actionKind === "agent_prompt" ? (
            <ScheduledPromptForm
              client={client}
              presets={state.presets}
              accounts={state.ghAccounts}
              projects={projects}
              slackConnected={slackConnected}
              initial={editing}
              onSaved={back}
              onCancel={back}
            />
          ) : (
            <PrReviewForm
              client={client}
              presets={state.presets}
              accounts={state.ghAccounts}
              projects={projects}
              initial={editing}
              onSaved={back}
              onCancel={back}
            />
          )}
        </>,
        true,
      );
    }
    if (channelId) {
      // Deleted elsewhere, or not loaded yet: say so instead of showing a stale channel.
      if (!channel) {
        return scroll(
          <>
            {state.loaded ? <p className="au-note">This automation no longer exists.</p> : <SkeletonDetail label="Loading automation" />}
            {state.loaded ? (
              <button type="button" className="rs-button" onClick={() => go({ kind: "all" })}>
                Back to automations
              </button>
            ) : null}
          </>,
        );
      }
      if (dock) {
        return (
          <DockAutomation
            automation={channel}
            runs={state.runs}
            drafts={state.drafts}
            results={state.results}
            presets={state.presets}
            client={client}
            projects={projects}
            onBack={() => go({ kind: "all" })}
            onEdit={() => setRoute({ page: "edit", id: channel.id })}
            onDeleted={() => go({ kind: "all" })}
          />
        );
      }
      const waitingCount = pending.get(channel.id) ?? 0;
      return (
        <>
          <ChannelHeader
            automation={channel}
            client={client}
            settingsOpen={settingsShown}
            onOpenSettings={openSettings}
            leading={
              dock ? (
                <button type="button" className="rs-icon-button au-dock-back" aria-label="Back to automations" title="Automations" onClick={() => go({ kind: "all" })}>
                  <ChevronLeft size={15} strokeWidth={1.75} aria-hidden />
                </button>
              ) : (
                navToggle
              )
            }
          />
          <div className="au-ctabs">
            <ResourceTabs
              label="Channel views"
              value={channelTab}
              onChange={setChannelTab}
              tabs={[
                { id: "open", label: "Open" },
                { id: "waiting", label: "Waiting on you", count: waitingCount },
                { id: "done", label: "Done" },
              ]}
            />
          </div>
          {scroll(
            <>
              {notices}
              {feed(channel.id, CHANNEL_SHOW[channelTab])}
            </>,
          )}
          {channel.actionKind === "pr_review" ? (
            <div className="au-composer">
              <ReviewNowSection automation={channel} client={client} runs={state.runs} />
            </div>
          ) : null}
        </>
      );
    }
    const kind = view?.kind === "channel" || !view ? "inbox" : view.kind;
    const [title, sub] = VIEW_COPY[kind];
    const body =
      kind === "browse" ? (
        <BrowseTab
          onUseTemplate={startTemplate}
          onNewForm={(k) => setRoute({ page: "new", kind: k })}
          previewTarget={composing ? null : readerEl}
          onOpenPreview={() => setPaneOpen(true)}
        />
      ) : kind === "running" ? (
        runningCount === 0 ? (
          <EmptyState action={<button type="button" className="rs-button" onClick={() => go({ kind: "all" })}>See automations</button>}>
            <strong>Nothing running</strong>
            Runs show here while their agent works, step by step.
          </EmptyState>
        ) : (
          <RunningNow runs={state.runs} automations={state.automations} client={client} projects={projects} />
        )
      ) : kind === "sent" ? (
        feed(null, "done")
      ) : kind === "all" || (state.loaded && state.automations.length === 0 && waitingElsewhere.length === 0) ? (
        <InstalledTab
          automations={state.automations}
          runs={state.runs}
          drafts={state.drafts}
          loaded={state.loaded}
          client={client}
          onOpen={(id) => go({ kind: "channel", id })}
          onBrowse={() => go({ kind: "browse" })}
          onDescribe={compose}
          quiet={dock}
        />
      ) : (
        <>
          {waitingElsewhere.length > 0 ? (
            <ul className="au-elsewhere" aria-label="Waiting elsewhere">
              {waitingElsewhere.map((item) => (
                <li key={item.id}>
                  <button type="button" className="au-elsewhere-row" onClick={item.onOpen}>
                    <span className="au-elsewhere-source">{item.source}</span>
                    <span className="au-elsewhere-title">{item.title}</span>
                    <span className="au-elsewhere-line">{item.line}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {feed(null, dock ? "waiting" : "all")}
        </>
      );
    if (dock) {
      const tab = kind === "all" || kind === "browse" ? "all" : kind === "sent" ? "sent" : "inbox";
      return (
        <>
          <header className="au-dhead">
            <ResourceTabs
              label="Automation views"
              value={tab}
              onChange={(next) => go({ kind: next })}
              tabs={[
                { id: "inbox", label: "Inbox", count: inboxCount },
                { id: "all", label: "Automations" },
                { id: "sent", label: "Sent" },
              ]}
            />
            {dockNew}
          </header>
          {scroll(
            <>
              {notices}
              {body}
            </>,
          )}
        </>
      );
    }
    return (
      <>
        <header className="au-vhead">
          {navToggle}
          <div className="au-vhead-text">
            <h1 className="au-vhead-title">{title}</h1>
            <p className="au-vhead-sub">{sub}</p>
          </div>
        </header>
        {scroll(
          <>
            {notices}
            {body}
          </>,
        )}
      </>
    );
  };

  const pane = (): ReactNode => {
    if (composing && !dock) {
      return (
        <div className="au-pane-scroll">
          <CreateWithAgent onCreateWithAgent={onCreateWithAgent} onClose={() => setComposing(false)} />
        </div>
      );
    }
    if (channel && settingsShown) {
      return (
        <div className="au-pane-scroll">
          <AutomationDetail
            variant="pane"
            automation={channel}
            runs={state.runs}
            drafts={state.drafts}
            results={state.results}
            presets={state.presets}
            slack={state.slack}
            client={client}
            onEdit={() => setRoute({ page: "edit", id: channel.id })}
            onDeleted={() => go({ kind: "all" })}
            onOpenConnectors={openConnectors}
            projects={projects}
          />
        </div>
      );
    }
    return null;
  };
  const paneContent = pane();
  const paneTitle = composing ? "New automation" : settingsShown ? "Settings" : view?.kind === "browse" ? "Preview" : "Thread";
  const paneSub = composing || settingsShown ? null : channel ? `#${channel.name}` : view?.kind === "inbox" ? "Inbox" : null;
  const routeKey = route.page === "view" ? `${route.view.kind}:${channelId ?? ""}:${channelTab}` : `${route.page}`;

  const sidebar = (
    <AutomationSidebar
      automations={state.automations}
      pending={pending}
      inboxCount={inboxCount}
      failing={new Set(attention.map((n) => n.automation.id))}
      runningCount={runningCount}
      view={view}
      onSelect={go}
      newButton={newButton}
      onClose={onClose}
      onOpenConnectors={onOpenConnectors}
      variant={hostedNav ? "rail" : "own"}
    />
  );

  return (
    <div className="ws-body au-body">
      <div
        className="ws-column au-column rs-surface au-shell"
        ref={bodyRef}
        onKeyDown={onKeyDown}
        data-nav={fit.nav}
        data-pane={fit.pane}
        data-variant={dock ? "dock" : undefined}
      >
        {/* A portal keeps the sidebar in this tree: its keys (Esc) still reach this surface. */}
        {hostedNav ? (
          navTarget && !dock ? createPortal(sidebar, navTarget) : null
        ) : navInline ? (
          <>
            <div className="au-shell-slot" style={{ width: navSize }}>
              {sidebar}
            </div>
            <SplitHandle
              orientation="vertical"
              size={navSize}
              min={NAV.min}
              max={navMax}
              defaultSize={DEFAULT_LAYOUT.automationNavWidth}
              label="Resize automations sidebar"
              onResize={(next) => setWidths({ automationNavWidth: next })}
            />
          </>
        ) : drawerOpen ? (
          <>
            <div className="au-scrim" aria-hidden onClick={() => setDrawerOpen(false)} />
            <div className="au-shell-slot au-drawer" style={{ width: Math.min(navSize, Math.max(NAV.min, body.width - 48)) }}>
              {sidebar}
            </div>
          </>
        ) : null}

        <main className="au-main" aria-label="Automation feed">
          <AutomationBoundary region="feed" resetKey={routeKey}>
            {middle()}
          </AutomationBoundary>
        </main>

        {paneShown ? (
          <>
            {overlay ? null : (
              <SplitHandle
                orientation="vertical"
                /* The pane is AFTER this seam: pulling left, into the feed, widens it. */
                sizes="after"
                size={paneSize}
                min={PANE.min}
                max={paneMax}
                defaultSize={DEFAULT_LAYOUT.automationPaneWidth}
                label="Resize automation pane"
                onResize={(next) => setWidths({ automationPaneWidth: next })}
              />
            )}
            <aside
              className="au-shell-slot au-pane"
              data-overlay={overlay || undefined}
              style={{ width: overlay ? Math.min(paneSize, Math.max(0, paneRoom)) || undefined : paneSize }}
              aria-label="Automation pane"
            >
              <header className="au-pane-bar">
                <h2 className="au-pane-title">{paneTitle}</h2>
                {paneSub ? <span className="au-pane-sub">{paneSub}</span> : null}
                <button
                  type="button"
                  className="rs-icon-button au-pane-x"
                  aria-label={composing ? "Close the composer" : "Close pane"}
                  title="Close (Esc)"
                  onClick={composing ? () => setComposing(false) : closePane}
                >
                  <X size={15} strokeWidth={1.75} aria-hidden />
                </button>
              </header>
              <AutomationBoundary region="pane" resetKey={`${routeKey}:${paneMode}:${composing}`}>
                {paneContent}
              </AutomationBoundary>
              {/* Inbox reads its open item into this node; it stays mounted so the item keeps its state. */}
              <div className="au-pane-scroll au-pane-reader" ref={setReaderEl} hidden={paneContent !== null} />
            </aside>
          </>
        ) : null}
      </div>
    </div>
  );
}
