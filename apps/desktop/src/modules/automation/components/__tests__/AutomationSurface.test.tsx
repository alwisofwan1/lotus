import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AutomationSurface, type AutomationSurfaceProps } from "../AutomationSurface";
import type {
  Automation,
  AutomationClient,
  AutomationDraft,
  AutomationRun,
  RunConversation,
  SendResult,
} from "../../services/automation-api";

const { openExternalLink } = vi.hoisted(() => ({ openExternalLink: vi.fn(async () => {}) }));
vi.mock("@/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-api")>()),
  openExternalLink,
}));

// ---------- fixtures ----------

const reviewer: Automation = {
  id: "a1",
  name: "Review orbit PRs",
  enabled: true,
  triggerKind: "manual",
  actionKind: "pr_review",
  config: {
    account: "alwisofwan1",
    presetId: "preset_alwi",
    repos: ["initech/orbit-app"],
    instructions: "Focus on security.",
  },
  slack: null,
  github: null,
  schedule: null,
  prompt: null,
  createdAtMs: 1,
  nextRunMs: null,
};

const brief: Automation = {
  id: "a2",
  name: "Morning brief",
  enabled: false,
  triggerKind: "schedule",
  actionKind: "agent_prompt",
  config: null,
  slack: null,
  github: null,
  schedule: { cron: "0 9 * * 1,2,3,4,5", timezone: "Asia/Jakarta" },
  prompt: {
    prompt: "Summarize the PRs waiting for me.",
    presetId: "preset_alwi",
    account: "alwisofwan1",
    repos: ["acme/*"],
    reviewerTeam: null,
    tools: [],
    includeReviewRequests: true,
    dmSelf: true,
    slackChannel: null,
  },
  createdAtMs: 2,
  nextRunMs: null,
};

const draft: AutomationDraft = {
  id: "d1",
  runId: "r1",
  automationId: "a1",
  kind: "pr_review",
  subject: "initech/orbit-app#42",
  status: "pending",
  content: {
    repo: "initech/orbit-app",
    number: 42,
    url: "https://github.com/initech/orbit-app/pull/42",
    headSha: "abc1234def",
    summary: "One risky line.",
    coverage: "complete",
    comments: [
      { path: "src/app.ts", line: 11, severity: "blocker", body: "eval on user input." },
      { path: "src/app.ts", line: 12, body: "nitpick" },
    ],
    droppedComments: 1,
    reply: { verdict: "changes-needed", points: ["eval on user input. (L11)"] },
  },
  slack: null,
  result: null,
  sentUrl: null,
  createdAtMs: 2,
};

const run: AutomationRun = {
  id: "r2",
  automationId: "a1",
  automationName: "Review orbit PRs",
  key: "initech/orbit-app#7@abcdef1234",
  status: "skipped",
  detail: "the pull request is still a draft",
  createdAtMs: 3,
  finishedAtMs: 4_003,
};

const connected = { state: "connected", detail: null, userId: "U0REVIEWER1", team: "Initech" };

function fakeClient(overrides: Partial<AutomationClient> = {}): AutomationClient {
  return {
    list: vi.fn(async () => [reviewer, brief]),
    presets: vi.fn(async () => [
      { id: "preset_alwi", name: "Alwi", agent: "ccs acme", supported: true },
      { id: "preset_codex", name: "Codex", agent: "codex", supported: false },
    ]),
    createPrReview: vi.fn(async () => reviewer),
    ghAccounts: vi.fn(async () => [
      { login: "masjidubk13", active: false },
      { login: "alwisofwan1", active: true },
    ]),
    runNow: vi.fn(async () => ({ status: "started" as const, runId: "r9" })),
    runs: vi.fn(async () => [run]),
    runConversation: vi.fn(async (): Promise<RunConversation> => ({ runId: "r1", running: false, canReply: true, whyNot: null, entries: [] })),
    sendMessage: vi.fn(async () => "r9"),
    paneOpened: vi.fn(async () => undefined),
    paneFailed: vi.fn(async () => undefined),
    findCheckout: vi.fn(async () => null),
    setWorkspaces: vi.fn(async () => undefined),
    runSteps: vi.fn(async () => []),
    onRunStep: vi.fn(() => () => undefined),
    drafts: vi.fn(async () => [draft]),
    sentReviews: vi.fn(async () => []),
    updateDraft: vi.fn(async () => true),
    sendDraft: vi.fn(async (): Promise<SendResult> => ({ status: "sent", url: "https://github.com/x#review-1" })),
    approveDraft: vi.fn(async (): Promise<SendResult> => ({ status: "sent", url: "https://github.com/x#review-1", slackReply: "replied" })),
    sendAll: vi.fn(async (): Promise<[string, SendResult][]> => []),
    replyNow: vi.fn(async () => "replied"),
    slackPreview: vi.fn(async () => ({ text: null, waiting: 0 })),
    discardDraft: vi.fn(async () => undefined),
    answerAsk: vi.fn(async () => "r-follow"),
    answeredAsks: vi.fn(async () => []),
    slackStatus: vi.fn(async () => ({ state: "not_set_up", detail: null, userId: null, team: null })),
    slackConnect: vi.fn(async () => connected),
    slackDisconnect: vi.fn(async () => undefined),
    slackChannels: vi.fn(async () => [
      { id: "C1", name: "code-review", isPrivate: false },
      { id: "G2", name: "orbit-dev", isPrivate: true },
    ]),
    slackUsergroups: vi.fn(async () => [{ id: "S0TEAM", handle: "team-orbit", name: "Team Orbit" }]),
    slackUserNames: vi.fn(async (ids: string[]) => Object.fromEntries(ids.filter((id) => id === "U0TANAKA").map((id) => [id, "Tanaka"]))),
    slackManifest: vi.fn(async () => "display_information:\n  name: Lotus Automation\n"),
    setSlackTrigger: vi.fn(async () => reviewer),
    setRequestSource: vi.fn(async () => reviewer),
    createAgentPrompt: vi.fn(async () => brief),
    results: vi.fn(async () => []),
    sendResult: vi.fn(async () => undefined),
    resendGoogle: vi.fn(async () => undefined),
    googleStatus: vi.fn(async () => ({ state: "not_connected", email: null })),
    googlePick: vi.fn(async (kind: "sheet" | "folder") =>
      kind === "sheet"
        ? { id: "S7", name: "Ops log", url: "https://docs.google.com/spreadsheets/d/S7/edit", tabs: ["Sheet1", "Old"], columns: ["When", "What"] }
        : { id: "F7", name: "Reports", url: "https://drive.google.com/drive/folders/F7" },
    ),
    googleCancelPick: vi.fn(async () => undefined),
    setEnabled: vi.fn(async (id: string, enabled: boolean) => ({ ...reviewer, id, enabled })),
    deleteAutomation: vi.fn(async () => true),
    runScheduledNow: vi.fn(async () => ({ status: "started" as const, runId: "r10" })),
    updatePrompt: vi.fn(async () => reviewer),
    updateAgent: vi.fn(async () => reviewer),
    edit: vi.fn(async () => brief) as AutomationClient["edit"],
    ...overrides,
  };
}

const noSubscribe = () => () => undefined;

const projects = [
  { id: "ws-orbit", name: "orbit" },
  { id: "ws-lotus", name: "Lotus" },
];

function renderSurface(client: AutomationClient, props: Partial<AutomationSurfaceProps> = {}) {
  return render(
    <AutomationSurface client={client} subscribe={noSubscribe} onClose={() => undefined} projects={projects} {...props} />,
  );
}

const VIEW_LABEL = { Installed: "All automations", Inbox: "Inbox", Browse: "Browse examples" } as const;

/** Steps to a view from the surface's own sidebar (it opens on Inbox). */
async function openTab(name: keyof typeof VIEW_LABEL) {
  const side = await screen.findByRole("complementary", { name: "Automations sidebar" });
  fireEvent.click(within(side).getByRole("button", { name: VIEW_LABEL[name] }));
}

/** Opens an automation's channel from the sidebar, as it opens: on what waits, or on Settings. */
async function openChannel(name: string) {
  const channels = await screen.findByRole("list", { name: "Automation channels" });
  fireEvent.click(await within(channels).findByRole("button", { name }));
  return screen.findByRole("heading", { level: 1, name });
}

/** Opens an automation's channel from the sidebar, with its Settings in the right pane. */
async function openAutomation(name: string) {
  const channels = await screen.findByRole("list", { name: "Automation channels" });
  fireEvent.click(await within(channels).findByRole("button", { name }));
  const heading = await screen.findByRole("heading", { level: 1, name });
  const settings = screen.getByRole("button", { name: "Settings" });
  if (settings.getAttribute("aria-pressed") !== "true") fireEvent.click(settings);
  await screen.findByRole("heading", { level: 2, name: "Settings" });
  return heading;
}

/** Opens the selected waiting row into the right pane, which stays closed until a row is opened. */
async function openSelectedRow() {
  const list = await screen.findByRole("listbox", { name: "Waiting items" });
  const row = within(list).getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");
  fireEvent.click(row ?? within(list).getAllByRole("option")[0]);
  return list;
}

/** Steps to Inbox and, when something waits, opens the selected row as a user would. */
async function openInbox() {
  await openTab("Inbox");
  await waitFor(() => expect(screen.queryByRole("listbox", { name: "Waiting items" }) ?? screen.queryByText("Nothing waiting")).not.toBeNull());
  if (screen.queryByRole("listbox", { name: "Waiting items" })) await openSelectedRow();
}

afterEach(() => { try { localStorage.clear(); } catch { /* none */ } });

async function inboxCard() {
  await openTab("Inbox");
  await openSelectedRow();
  return screen.findByRole("article", { name: "initech/orbit-app#42" });
}

// ---------- Installed ----------

describe("Installed", () => {
  it("lists each automation with what starts it, and what is on comes first", async () => {
    renderSurface(fakeClient());
    await openTab("Installed");
    const list = await screen.findByRole("list", { name: "Automations" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Review orbit PRs", "Morning brief"]);
    expect(within(rows[1]).getByText("9AM Mon-Fri")).toBeInTheDocument();
    expect(within(rows[0]).getByText("On demand")).toBeInTheDocument();
    expect(within(rows[0]).getByText("1 to review")).toBeInTheDocument();
  });

  it("turns an automation on or off from its row", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openTab("Installed");
    fireEvent.click(await screen.findByRole("switch", { name: "Turn on Morning brief" }));
    await waitFor(() => expect(client.setEnabled).toHaveBeenCalledWith("a2", true));
  });

  it("searches and filters, and says so when nothing matches", async () => {
    renderSurface(fakeClient());
    await openTab("Installed");
    const list = await screen.findByRole("list", { name: "Automations" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search automations" }), { target: { value: "brief" } });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search automations" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Off" }));
    expect(within(screen.getByRole("list", { name: "Automations" })).getAllByRole("listitem")).toHaveLength(1);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search automations" }), { target: { value: "zzz" } });
    expect(screen.getByText(/No automations match “zzz” with these filters/)).toBeInTheDocument();
  });

  it("teaches what to do when there are no automations yet", async () => {
    renderSurface(fakeClient({ list: vi.fn(async () => []) }));
    expect(await screen.findByText("No automations yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Describe one" }));
    expect(screen.getByRole("textbox", { name: "Describe an automation" })).toBeInTheDocument();
  });

  it("opens a row as its channel, marked in the sidebar, and steps back from there", async () => {
    renderSurface(fakeClient());
    await openTab("Installed");
    const row = await screen.findByRole("listitem", { name: "Review orbit PRs" });
    fireEvent.click(within(row).getByRole("button", { name: "Review orbit PRs" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Review orbit PRs" })).toBeInTheDocument();
    const channels = screen.getByRole("list", { name: "Automation channels" });
    expect(within(channels).getByRole("button", { name: "Review orbit PRs" })).toHaveAttribute("aria-current", "page");
    await openTab("Installed");
    expect(await screen.findByRole("list", { name: "Automations" })).toBeInTheDocument();
  });

  it("puts what is on first in the sidebar, and counts what waits for you", async () => {
    renderSurface(fakeClient());
    const channels = await screen.findByRole("list", { name: "Automation channels" });
    await within(channels).findByRole("button", { name: "Review orbit PRs" });
    expect(within(channels).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Review orbit PRs", "Morning brief"]);
    expect(within(channels).getByRole("button", { name: "Morning brief" })).toHaveAttribute("data-off");
    expect(within(channels).getByRole("button", { name: "Review orbit PRs" })).toHaveTextContent("1");
  });

  it("turns a channel on or off from the state pill in its header", async () => {
    const client = fakeClient();
    renderSurface(client);
    const channels = await screen.findByRole("list", { name: "Automation channels" });
    fireEvent.click(await within(channels).findByRole("button", { name: "Morning brief" }));
    fireEvent.click(await screen.findByRole("button", { name: "Off. Turn on Morning brief" }));
    await waitFor(() => expect(client.setEnabled).toHaveBeenCalledWith("a2", true));
  });
});

// ---------- New automation ----------

describe("New automation", () => {
  it("opens a composer; the agent gets the request, the skill, and is told to ask first", async () => {
    const onCreateWithAgent = vi.fn<(prompt: string) => Promise<string | null>>(async () => null);
    renderSurface(fakeClient(), { onCreateWithAgent });
    fireEvent.click(await screen.findByRole("button", { name: "New automation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Describe an automation" }), {
      target: { value: "Every Monday, DM me stale PRs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create with agent" }));

    await waitFor(() => expect(onCreateWithAgent).toHaveBeenCalledTimes(1));
    const prompt = onCreateWithAgent.mock.calls[0][0];
    expect(prompt).toMatch(/Every Monday, DM me stale PRs/);
    expect(prompt).toContain("lotus-automation skill");
    expect(prompt).toMatch(/summary/i);
  });

  it("says why when the agent could not be opened, and explains when there is nowhere to open one", async () => {
    const onCreateWithAgent = vi.fn<(prompt: string) => Promise<string | null>>(
      async () => "No workspace is open to put the agent in.",
    );
    const { unmount } = renderSurface(fakeClient(), { onCreateWithAgent });
    fireEvent.click(await screen.findByRole("button", { name: "New automation" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Describe an automation" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create with agent" }));
    expect(await screen.findByText("No workspace is open to put the agent in.")).toBeInTheDocument();
    unmount();

    renderSurface(fakeClient());
    fireEvent.click(await screen.findByRole("button", { name: "New automation" }));
    expect(screen.getByRole("button", { name: "Create with agent" })).toBeDisabled();
    expect(screen.getByText(/Open Code mode with a workspace first/)).toBeInTheDocument();
  });

  it("starts an example from the menu or from Browse", async () => {
    const onCreateWithAgent = vi.fn<(prompt: string) => Promise<string | null>>(async () => null);
    renderSurface(fakeClient(), { onCreateWithAgent });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Weekday PR brief" }));
    await waitFor(() => expect(onCreateWithAgent.mock.calls[0][0]).toMatch(/every weekday at 09:00/i));

    await openTab("Browse");
    fireEvent.click(screen.getByRole("button", { name: /Friday review digest/ }));
    // A card previews first; nothing starts until Use template.
    expect(onCreateWithAgent).toHaveBeenCalledTimes(1);
    const preview = await screen.findByRole("article", { name: "Friday review digest preview" });
    expect(within(preview).getByText("Fridays at 16:00")).toBeInTheDocument();
    expect(within(preview).getByLabelText("Example output")).toHaveTextContent(/Still open in your queue/);
    expect(within(within(preview).getByRole("list", { name: "Questions the agent may ask" })).getByText("Which agent preset runs it")).toBeInTheDocument();
    fireEvent.click(within(preview).getByRole("button", { name: "Use template" }));
    await waitFor(() => expect(onCreateWithAgent.mock.calls[1][0]).toMatch(/every Friday/i));
  });

  it("finds examples by words and by what starts them", async () => {
    renderSurface(fakeClient());
    await openTab("Browse");
    const examples = () => within(screen.getByRole("region", { name: "Start with an agent" })).queryAllByRole("button");
    expect(examples()).toHaveLength(4);
    fireEvent.click(within(screen.getByRole("group", { name: "Filter examples" })).getByRole("button", { name: "From Slack" }));
    expect(examples().map((b) => b.textContent)).toEqual([expect.stringContaining("Review PRs asked for in Slack")]);
    fireEvent.click(within(screen.getByRole("group", { name: "Filter examples" })).getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search examples" }), { target: { value: "friday" } });
    expect(examples()).toHaveLength(1);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search examples" }), { target: { value: "zzz" } });
    expect(screen.getByText(/No example matches/)).toBeInTheDocument();
  });
});

// ---------- Forms ----------

describe("PR review form", () => {
  async function openForm(client: AutomationClient) {
    renderSurface(client);
    fireEvent.click(await screen.findByRole("menuitem", { name: "PR review" }));
    const form = await screen.findByRole("form", { name: "New PR review" });
    await within(form).findByText(/as alwisofwan1 · Alwi/);
    return form;
  }

  it("needs only an organization: account, preset and name fill themselves in", async () => {
    const client = fakeClient();
    const form = await openForm(client);
    fireEvent.change(within(form).getByLabelText("Organization or repositories"), {
      target: { value: "acme, initech/orbit-app" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Create automation" }));
    await waitFor(() =>
      expect(client.createPrReview).toHaveBeenCalledWith({
        name: "PR review · acme, initech/orbit-app",
        account: "alwisofwan1",
        presetId: "preset_alwi",
        repos: ["acme/*", "initech/orbit-app"],
        instructions: "",
        workdir: null,
        workspaceId: null,
        openPane: false,
        mcpTools: [],
        skill: null,
        maxFiles: null,
        timeoutMinutes: null,
        runTests: false,
        autoSend: false,
      }),
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Review orbit PRs" })).toBeInTheDocument();
  });

  it("runs in the project's checkout in the background, and opens a pane only when asked to", async () => {
    const client = fakeClient();
    const form = await openForm(client);
    fireEvent.change(within(form).getByLabelText("Organization or repositories"), { target: { value: "acme" } });
    expect(within(form).queryByRole("checkbox", { name: /Open a pane/ })).toBeNull(); // only with a project
    fireEvent.change(within(form).getByRole("combobox", { name: "Project" }), { target: { value: "ws-orbit" } });
    const pane = within(form).getByRole("checkbox", { name: /Open a pane to watch each run/ });
    expect(pane).not.toBeChecked();
    fireEvent.click(pane);
    fireEvent.click(within(form).getByRole("button", { name: "Create automation" }));
    await waitFor(() =>
      expect(client.createPrReview).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-orbit", openPane: true })),
    );
  });

  it("keeps account, preset and name under Advanced, and offers only tool-less presets", async () => {
    const client = fakeClient();
    const form = await openForm(client);
    fireEvent.change(within(form).getByLabelText("GitHub account"), { target: { value: "masjidubk13" } });
    expect(within(form).getByRole("option", { name: /Codex/ })).toBeDisabled();
    fireEvent.change(within(form).getByLabelText("Organization or repositories"), { target: { value: "acme" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create automation" }));
    await waitFor(() =>
      expect(client.createPrReview).toHaveBeenCalledWith(expect.objectContaining({ account: "masjidubk13" })),
    );
  });

  it("does not ask for a GitHub team: a request in Slack or the Review button is enough", async () => {
    const form = await openForm(fakeClient());
    expect(within(form).queryByLabelText("GitHub team")).toBeNull();
    expect(within(form).queryByText(/request you or your team on GitHub/)).toBeNull();
  });
});

describe("Scheduled prompt form", () => {
  it("creates a weekday 09:00 prompt that reads my review queue, from just the prompt", async () => {
    const client = fakeClient({ slackStatus: vi.fn(async () => connected) });
    renderSurface(client);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Scheduled prompt" }));
    const form = await screen.findByRole("form", { name: "New scheduled prompt" });
    fireEvent.change(within(form).getByLabelText("Prompt"), { target: { value: "Summarize my queue." } });
    await within(form).findByText(/Alwi · alwisofwan1/);
    expect(within(form).queryByRole("checkbox", { name: "Web search" })).toBeNull(); // every tool now
    fireEvent.change(within(form).getByRole("combobox", { name: "Project" }), { target: { value: "ws-orbit" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create automation" }));

    await waitFor(() =>
      expect(client.createAgentPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Summarize my queue.",
          days: ["mon", "tue", "wed", "thu", "fri"],
          time: "09:00",
          includeReviewRequests: true,
          account: "alwisofwan1",
          tools: [],
          workdir: null,
          workspaceId: "ws-orbit",
          slackChannel: null,
        }),
      ),
    );
  });

  it("edits an existing prompt starting from what it was made with", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openAutomation("Morning brief");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit settings" }));
    const form = await screen.findByRole("form", { name: "Edit scheduled prompt" });
    expect(within(form).getByLabelText("Prompt")).toHaveValue("Summarize the PRs waiting for me.");
    expect(within(form).getByRole("button", { name: "Sat" })).toHaveAttribute("aria-pressed", "false");
    expect(within(form).getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(form).getByRole("button", { name: "Sat" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(client.edit).toHaveBeenCalledWith(
        "a2",
        "agent_prompt",
        expect.objectContaining({ days: ["mon", "tue", "wed", "thu", "fri", "sat"], repos: ["acme/*"] }),
      ),
    );
  });
});

describe("Scheduled prompt form: Google outputs", () => {
  const googleOn = vi.fn(async () => ({ state: "connected", email: "you@company.com" }));

  async function openNew(client: AutomationClient) {
    renderSurface(client);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Scheduled prompt" }));
    const form = await screen.findByRole("form", { name: "New scheduled prompt" });
    fireEvent.change(within(form).getByLabelText("Prompt"), { target: { value: "Check every service." } });
    await within(form).findByText(/Alwi · alwisofwan1/);
    return form;
  }

  it("cannot pick Google outputs until Google is connected", async () => {
    const form = await openNew(fakeClient());
    expect(within(form).getByRole("checkbox", { name: /Add rows to a Google Sheet/ })).toBeDisabled();
    expect(within(form).getByRole("checkbox", { name: /Save a report file to Google Drive/ })).toBeDisabled();
    expect(within(form).getAllByText("(connect Google in Connectors first)")).toHaveLength(2);
  });

  it("asks for a new sheet with my columns and a CSV in My Drive", async () => {
    const client = fakeClient({ googleStatus: googleOn });
    const form = await openNew(client);
    await waitFor(() => expect(within(form).getByRole("checkbox", { name: /Add rows to a Google Sheet/ })).toBeEnabled());
    const drive = within(form).getByRole("checkbox", { name: /Save a report file to Google Drive/ });
    fireEvent.click(drive);
    expect(within(form).getByRole("button", { name: "CSV" })).toBeDisabled();

    fireEvent.click(within(form).getByRole("checkbox", { name: /Add rows to a Google Sheet/ }));
    expect(within(form).getByText("New sheet")).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Remove column Item" }));
    const add = within(form).getByLabelText("Add a column");
    fireEvent.change(add, { target: { value: "Service" } });
    fireEvent.keyDown(add, { key: "Enter" });
    fireEvent.change(add, { target: { value: "service" } });
    fireEvent.keyDown(add, { key: "Enter" });
    fireEvent.click(within(form).getByRole("button", { name: "CSV" }));
    expect(within(form).getByText(/^Next file: .* — \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.csv$/)).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Create automation" }));

    await waitFor(() =>
      expect(client.createAgentPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          googleSheet: { spreadsheetId: "new", tab: "Daily", columns: ["Date", "Status", "Note", "Service"] },
          googleDrive: { folderId: "root", format: "csv" },
        }),
      ),
    );
  });

  it("takes a pasted folder link as its id", async () => {
    const client = fakeClient({ googleStatus: googleOn });
    const form = await openNew(client);
    await waitFor(() => expect(within(form).getByRole("checkbox", { name: /Save a report file to Google Drive/ })).toBeEnabled());
    fireEvent.click(within(form).getByRole("checkbox", { name: /Save a report file to Google Drive/ }));
    fireEvent.change(within(form).getByLabelText("Folder"), {
      target: { value: "https://drive.google.com/drive/folders/1cQ88pJl2jeOwWTl?usp=sharing" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Create automation" }));
    await waitFor(() =>
      expect(client.createAgentPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ googleSheet: null, googleDrive: { folderId: "1cQ88pJl2jeOwWTl", format: "google_doc" } }),
      ),
    );
  });

  it("picks an existing sheet and folder in Google's Picker", async () => {
    const client = fakeClient({ googleStatus: googleOn });
    const form = await openNew(client);
    await waitFor(() => expect(within(form).getByRole("checkbox", { name: /Add rows to a Google Sheet/ })).toBeEnabled());
    fireEvent.click(within(form).getByRole("checkbox", { name: /Add rows to a Google Sheet/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Pick an existing sheet" }));
    expect(await within(form).findByRole("link", { name: /Open “Ops log”/ })).toHaveAttribute("href", "https://docs.google.com/spreadsheets/d/S7/edit");
    // The sheet's own tabs and header, not the form's defaults ("Daily" does not exist in it).
    expect(within(form).getByRole("combobox", { name: "Tab" })).toHaveValue("Sheet1");
    expect(within(form).getByRole("button", { name: "Remove column When" })).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("checkbox", { name: /Save a report file to Google Drive/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Pick a folder" }));
    await waitFor(() => expect(within(form).getByLabelText("Folder")).toHaveValue("Reports"));
    fireEvent.click(within(form).getByRole("button", { name: "Create automation" }));
    await waitFor(() =>
      expect(client.createAgentPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          googleSheet: { spreadsheetId: "S7", tab: "Sheet1", columns: ["When", "What"] },
          googleDrive: { folderId: "F7", format: "google_doc" },
        }),
      ),
    );
    expect(client.googlePick).toHaveBeenCalledWith("sheet");
    expect(client.googlePick).toHaveBeenCalledWith("folder");
  });

  it("waits for the browser while picking, can cancel, and a cancel is not an error", async () => {
    let fail: (e: Error) => void = () => undefined;
    const client = fakeClient({
      googleStatus: googleOn,
      googlePick: vi.fn(() => new Promise<never>((_, reject) => (fail = reject))),
    });
    const form = await openNew(client);
    await waitFor(() => expect(within(form).getByRole("checkbox", { name: /Add rows to a Google Sheet/ })).toBeEnabled());
    fireEvent.click(within(form).getByRole("checkbox", { name: /Add rows to a Google Sheet/ }));
    fireEvent.click(within(form).getByRole("button", { name: "Pick an existing sheet" }));
    const waiting = await within(form).findByRole("status");
    fireEvent.click(within(waiting).getByRole("button", { name: "Cancel" }));
    expect(client.googleCancelPick).toHaveBeenCalled();
    fail(new Error("Google sign-in was cancelled"));
    await waitFor(() => expect(within(form).queryByRole("status")).toBeNull());
    expect(within(form).queryByRole("alert")).toBeNull();
    expect(within(form).getByText("New sheet")).toBeInTheDocument();
  });

  it("keeps the sheet an automation already writes to when edited", async () => {
    const withSheet: Automation = {
      ...brief,
      prompt: {
        ...brief.prompt!,
        googleSheet: { spreadsheetId: "SHEET1", tab: "Daily", columns: ["Date", "Status"], url: "https://docs.google.com/spreadsheets/d/SHEET1/edit" },
        googleDrive: null,
      },
    };
    const client = fakeClient({ googleStatus: googleOn, list: vi.fn(async () => [withSheet]) });
    renderSurface(client);
    await openAutomation("Morning brief");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit settings" }));
    const form = await screen.findByRole("form", { name: "Edit scheduled prompt" });
    expect(within(form).getByRole("link", { name: /Open the sheet/ })).toHaveAttribute("href", "https://docs.google.com/spreadsheets/d/SHEET1/edit");
    expect(within(form).getByRole("button", { name: "Pick another sheet" })).toBeEnabled();
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(client.edit).toHaveBeenCalledWith(
        "a2",
        "agent_prompt",
        expect.objectContaining({ googleSheet: { spreadsheetId: "SHEET1", tab: "Daily", columns: ["Date", "Status"] } }),
      ),
    );
  });
});

// ---------- Detail ----------

describe("A PR review's page", () => {
  it("reviews a pasted PR, and the message follows the run until it ends", async () => {
    let runs: AutomationRun[] = [];
    let notify = () => undefined as void;
    const subscribe = (onChange: () => void) => {
      notify = onChange;
      return () => undefined;
    };
    const client = fakeClient({ drafts: vi.fn(async () => []), runs: vi.fn(async () => runs) });
    render(<AutomationSurface client={client} subscribe={subscribe} onClose={() => undefined} />);
    await openAutomation("Review orbit PRs");
    const box = screen.getByRole("region", { name: "Review a pull request" });
    fireEvent.change(within(box).getByLabelText("Pull request URL"), {
      target: { value: "https://github.com/initech/orbit-app/pull/2498" },
    });
    fireEvent.click(within(box).getByRole("button", { name: "Review" }));
    await waitFor(() =>
      expect(client.runNow).toHaveBeenCalledWith("a1", "https://github.com/initech/orbit-app/pull/2498"),
    );
    expect(await within(box).findByText(/Reviewing/)).toBeInTheDocument();

    runs = [{ ...run, id: "r9", status: "skipped", detail: "the pull request is already merged" }];
    notify();
    expect(await within(box).findByText("Skipped: the pull request is already merged")).toBeInTheDocument();
  });

  it("says so when that commit is already being reviewed or has a draft", async () => {
    renderSurface(fakeClient({ runNow: vi.fn(async () => ({ status: "duplicate" as const, runId: "r1" })) }));
    await openAutomation("Review orbit PRs");
    fireEvent.change(screen.getByLabelText("Pull request URL"), {
      target: { value: "https://github.com/initech/orbit-app/pull/42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText(/already being reviewed, or has a draft/)).toBeInTheDocument();
  });

  it("lists its runs with outcome, reason and duration", async () => {
    renderSurface(fakeClient());
    await openAutomation("Review orbit PRs");
    const runs = screen.getByRole("list", { name: "Runs" });
    expect(within(runs).getByLabelText("Skipped")).toBeInTheDocument();
    expect(within(runs).getByText("initech/orbit-app#7")).toBeInTheDocument();
    expect(within(runs).getByText("4.0s · the pull request is still a draft")).toBeInTheDocument();
  });

  it("opens a run that kept its conversation as a thread, in place", async () => {
    const kept = { ...run, id: "r5", status: "succeeded" as const, detail: "draft ready", sessionCwd: "/Users/me/vault" };
    const client = fakeClient({
      runs: vi.fn(async () => [kept]),
      runConversation: vi.fn(async () => ({
        runId: "r5",
        running: false,
        canReply: true,
        whyNot: null,
        entries: [
          { kind: "you" as const, text: "Why line 20?", atMs: 1 },
          { kind: "agent" as const, text: "It runs eval on input.", atMs: 2 },
        ],
      })),
    });
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    const row = within(screen.getByRole("list", { name: "Runs" })).getByRole("button");
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    const thread = await screen.findByRole("region", { name: "Conversation with the agent" });
    expect(client.runConversation).toHaveBeenCalledWith("r5");
    expect(within(thread).getByRole("article", { name: "You" })).toHaveTextContent("Why line 20?");
    expect(within(thread).getByRole("article", { name: "Agent" })).toHaveTextContent("It runs eval on input.");
    expect(within(thread).getByText("2 messages")).toBeInTheDocument();
  });
  it("names the project an automation runs its panes in", async () => {
    const inProject = { ...reviewer, config: { ...reviewer.config!, workspaceId: "ws-orbit", openPane: true } };
    renderSurface(fakeClient({ list: vi.fn(async () => [inProject, brief]) }));
    await openAutomation("Review orbit PRs");
    expect(screen.getByTitle("Each run opens a pane in this project and works there")).toHaveTextContent("orbit");
  });

  it("names the project an automation runs in the background in", async () => {
    const inProject = { ...reviewer, config: { ...reviewer.config!, workspaceId: "ws-orbit" } };
    renderSurface(fakeClient({ list: vi.fn(async () => [inProject, brief]) }));
    await openAutomation("Review orbit PRs");
    expect(screen.getByTitle("Each run works in this project's folder, in the background; follow it under Runs")).toHaveTextContent(
      "orbit",
    );
  });

  it("shows what a running review's agent is doing, step by step, as it happens", async () => {
    const running = { ...run, id: "r7", status: "running" as const, detail: null, finishedAtMs: null };
    let push: ((step: { runId: string; atMs: number; text: string }) => void) | null = null;
    const client = fakeClient({
      runs: vi.fn(async () => [running]),
      runSteps: vi.fn(async () => [{ atMs: 10, text: "Read the PR diff" }]),
      onRunStep: vi.fn((listener) => {
        push = listener;
        return () => undefined;
      }),
    });
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    // At the top of the page, above the drafts and the Review form's results, not only down in Runs.
    const now = await screen.findByRole("region", { name: "Running now" });
    expect(within(now).getByText("initech/orbit-app#7")).toBeInTheDocument();
    const steps = await within(now).findByRole("list", { name: "What the agent is doing" });
    expect(await within(steps).findByText("Read the PR diff")).toBeInTheDocument();
    expect(client.runSteps).toHaveBeenCalledWith("r7");
    await waitFor(() => expect(push).not.toBeNull());
    push!({ runId: "other", atMs: 11, text: "Not this run" });
    push!({ runId: "r7", atMs: 12, text: "Searched for `eval`" });
    expect(await within(steps).findByText("Searched for `eval`")).toBeInTheDocument();
    expect(within(steps).queryByText("Not this run")).toBeNull();
  });

  it("opens the newest running run's trace and keeps the others to one line until picked", async () => {
    const older = { ...run, id: "r7", status: "running" as const, detail: null, finishedAtMs: null, createdAtMs: 10 };
    const newer = { ...older, id: "r8", key: "initech/orbit-app#9@abcdef1234", createdAtMs: 20 };
    const steps: Record<string, { atMs: number; text: string }[]> = {
      r7: [{ atMs: 11, text: "Read src/old.ts" }],
      r8: [
        { atMs: 21, text: "Read GitHub orbit-app#9" },
        { atMs: 22, text: "Read GitHub orbit-app#9" },
        { atMs: 23, text: "Read src/new.ts" },
      ],
    };
    const client = fakeClient({ runs: vi.fn(async () => [older, newer]), runSteps: vi.fn(async (id: string) => steps[id]) });
    renderSurface(client);
    await openInbox();
    const now = await screen.findByRole("region", { name: "Running now" });
    const trace = await within(now).findByRole("list", { name: "What the agent is doing" });
    // A step done twice in a row is one row.
    expect(await within(trace).findByText("Read GitHub orbit-app#9")).toBeInTheDocument();
    expect(within(trace).getByText("×2")).toBeInTheDocument();
    expect(within(trace).getByText("Read src/new.ts")).toBeInTheDocument();
    // The older run is one line: its latest step, outside any trace.
    expect(await within(now).findByText("Read src/old.ts")).toBeInTheDocument();
    expect(within(trace).queryByText("Read src/old.ts")).toBeNull();
    const [olderHead, newerHead] = within(now).getAllByRole("button", { expanded: false }).concat(within(now).getAllByRole("button", { expanded: true }));
    expect(newerHead).toHaveTextContent("orbit-app#9");
    fireEvent.click(olderHead);
    const opened = await within(now).findByRole("list", { name: "What the agent is doing" });
    expect(within(opened).getByText("Read src/old.ts")).toBeInTheDocument();
    expect(within(now).getAllByRole("list", { name: "What the agent is doing" })).toHaveLength(1);
  });

  it("keeps and edits the MCP tools a review may use, so a settings edit never drops them", async () => {
    const withMcp = { ...reviewer, config: { ...reviewer.config!, mcpTools: ["mcp__context7"] } };
    const client = fakeClient({ list: vi.fn(async () => [withMcp, brief]) });
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit settings" }));
    const form = await screen.findByRole("form", { name: "Edit PR review" });
    const field = within(form).getByLabelText("MCP tools");
    expect(field).toHaveValue("mcp__context7");
    fireEvent.change(field, { target: { value: "mcp__context7, mcp__plugin_claude-mem_mcp-search" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(client.edit).toHaveBeenCalledWith(
        "a1",
        "pr_review",
        expect.objectContaining({ mcpTools: ["mcp__context7", "mcp__plugin_claude-mem_mcp-search"] }),
      ),
    );
  });

  it("keeps and edits a review's skill and limits, and refuses a limit that is not a number", async () => {
    const tuned = { ...reviewer, config: { ...reviewer.config!, skill: "code-review", maxFiles: 800, timeoutMinutes: null } };
    const client = fakeClient({ list: vi.fn(async () => [tuned, brief]) });
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit settings" }));
    const form = await screen.findByRole("form", { name: "Edit PR review" });
    expect(within(form).getByLabelText("Skill")).toHaveValue("code-review");
    expect(within(form).getByLabelText("Max files")).toHaveValue("800");

    fireEvent.change(within(form).getByLabelText("Timeout (minutes)"), { target: { value: "ten" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    expect(await within(form).findByText(/timeout: "ten" is not a whole number/)).toBeInTheDocument();
    expect(client.edit).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText("Skill"), { target: { value: "/mattpocock-skills:code-review" } });
    fireEvent.change(within(form).getByLabelText("Timeout (minutes)"), { target: { value: "60" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(client.edit).toHaveBeenCalledWith(
        "a1",
        "pr_review",
        expect.objectContaining({ skill: "mattpocock-skills:code-review", maxFiles: 800, timeoutMinutes: 60 }),
      ),
    );
  });

  it("keeps the test-run switch off by default and warns that the PR's code runs on this Mac when on", async () => {
    const client = fakeClient({ list: vi.fn(async () => [reviewer, brief]) });
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit settings" }));
    const form = await screen.findByRole("form", { name: "Edit PR review" });
    const toggle = within(form).getByLabelText("Run the PR's tests");
    expect(toggle).not.toBeChecked();
    expect(within(form).queryByText(/The PR's code runs on this Mac/)).toBeNull();

    fireEvent.click(toggle);
    expect(within(form).getByText(/The PR's code runs on this Mac/)).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(client.edit).toHaveBeenCalledWith("a1", "pr_review", expect.objectContaining({ runTests: true })),
    );
  });

  it("says why a run's agent cannot be written to", async () => {
    const kept = { ...run, id: "r5", sessionCwd: "/x" };
    const whyNot = "This run's conversation was not saved (the agent did not start).";
    const client = fakeClient({
      runs: vi.fn(async () => [kept]),
      runConversation: vi.fn(async () => ({ runId: "r5", running: false, canReply: false, whyNot, entries: [] })),
    });
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    fireEvent.click(within(screen.getByRole("list", { name: "Runs" })).getByRole("button"));
    const box = await screen.findByRole("textbox", { name: "Message the agent" });
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute("placeholder", whyNot);
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });
  it("expands a run without a conversation to show its whole outcome", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    const row = within(screen.getByRole("list", { name: "Runs" })).getByRole("button");
    expect(row).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/no saved conversation: it was skipped before the agent started/)).toBeInTheDocument();
    expect(client.runConversation).not.toHaveBeenCalled();
  });

  it("names an earlier run of a commit that was asked for again by its pull request", async () => {
    const earlier = { ...run, id: "r0", key: "initech/orbit-app#7@abcdef1234~6f1c2b9e-0a4d-4c1e-9f5a-1b2c3d4e5f60" };
    renderSurface(fakeClient({ runs: vi.fn(async () => [earlier]) }));
    await openAutomation("Review orbit PRs");
    expect(await screen.findByText("initech/orbit-app#7")).toBeInTheDocument();
  });

  it("offers the Slack reply's shape as a block inside the instructions", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    fireEvent.click(screen.getByRole("button", { name: "Edit instructions" }));
    expect(screen.getByText(/\{mention\} \{verdict\} \{pr\} \{counts\} \{points\}/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Insert Slack reply template" }));
    const box = screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement;
    expect(box.value).toContain("Focus on security.\n\n```slack-reply\n{mention} {verdict} on {pr} · {counts}\n{points}\n```");
    expect(box.value).toContain("```slack-reply-lgtm\n{mention} LGTM ✅ {pr}\n```");
    expect(box.value).toContain("```slack-reply-group\n{mention} Review selesai untuk {count} PR:\n\n{reviews}\n```");
    // Once is enough.
    expect(screen.queryByRole("button", { name: "Insert Slack reply template" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.updatePrompt).toHaveBeenCalledWith("a1", expect.stringContaining("```slack-reply-lgtm")));
  });

  it("adds a review focus with one press, offers it once, and saves only on Save", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    fireEvent.click(screen.getByRole("button", { name: "Edit instructions" }));
    const focuses = screen.getByRole("group", { name: "Add a review focus" });
    fireEvent.click(within(focuses).getByRole("button", { name: "+ Performance" }));
    const box = screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement;
    expect(box.value).toMatch(/^Focus on security\.\nFlag performance problems/);
    expect(within(focuses).queryByRole("button", { name: "+ Performance" })).toBeNull();
    expect(client.updatePrompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.updatePrompt).toHaveBeenCalledWith("a1", expect.stringContaining("N+1 queries")));
  });

  it("shows which tools a review may use, read-only when none are added", async () => {
    renderSurface(fakeClient());
    await openAutomation("Review orbit PRs");
    expect(screen.getByText(/^(Read-only|\d+ tools?)$/)).toBeInTheDocument();
  });

  it("previews the Slack reply for a review and for an LGTM, and says why a block would be refused", async () => {
    renderSurface(fakeClient());
    await openAutomation("Review orbit PRs");
    fireEvent.click(screen.getByRole("button", { name: "Edit instructions" }));
    const preview = screen.getByRole("region", { name: "Slack reply preview" });
    expect(within(preview).getByRole("tabpanel", { name: "Review reply" }).textContent).toMatch(/^@Aditya 🔧 Changes needed on acme-api#2952 · 1 should-fix, 1 question\n• /);
    fireEvent.click(within(preview).getByRole("tab", { name: "LGTM" }));
    expect(within(preview).getByRole("tabpanel", { name: "LGTM reply" })).toHaveTextContent("@Aditya LGTM ✅ acme-api#2952");
    fireEvent.click(within(preview).getByRole("tab", { name: "2 PRs" }));
    const two = within(preview).getByRole("tabpanel", { name: "Two-PR reply" }).textContent ?? "";
    // One greeting, then a short part per PR.
    expect(two).toMatch(/^@Aditya Review selesai untuk 2 PR:\n\nacme-api#2952 — 🔧 Changes needed\n• /);
    expect(two).toContain("\n\nacme-web#2511 — LGTM ✅");
    expect(two.match(/@Aditya/g)).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "```slack-reply-lgtm\nShip {pr} {who}\n```" } });
    expect(within(preview).getByRole("alert")).toHaveTextContent("has {who}, which Lotus does not fill");
  });

  it("edits the review instructions in place", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    expect(screen.getByText("Focus on security.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit instructions" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Only SQL." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.updatePrompt).toHaveBeenCalledWith("a1", "Only SQL."));
  });

  it("listens in a Slack channel for requests to me or my team, once Slack is connected", async () => {
    const client = fakeClient({ slackStatus: vi.fn(async () => connected) });
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    fireEvent.click(await screen.findByRole("button", { name: "Listen in Slack" }));
    fireEvent.change(await screen.findByLabelText("Channel"), { target: { value: "G2" } });
    fireEvent.change(screen.getByLabelText("Team mention"), { target: { value: "S0TEAM" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.setSlackTrigger).toHaveBeenCalledWith("a1", ["G2"], "S0TEAM"));
  });

  it("watches GitHub's review requests without Slack, with an optional team", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    fireEvent.click(screen.getByRole("button", { name: "Watch GitHub" }));
    fireEvent.change(screen.getByLabelText("GitHub team"), { target: { value: " acme/acme " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.setRequestSource).toHaveBeenCalledWith("a1", "github", { team: "acme/acme" }));

    // No team: only requests to the account count.
    fireEvent.click(await screen.findByRole("button", { name: "Watch GitHub" }));
    fireEvent.change(screen.getByLabelText("GitHub team"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(client.setRequestSource).toHaveBeenLastCalledWith("a1", "github", {}));
  });

  it("says when it watches GitHub, and stops on request", async () => {
    const watching = { ...reviewer, github: { team: "acme/acme" } };
    const client = fakeClient({ list: vi.fn(async () => [watching, brief]) });
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    expect(screen.getByText(/Review requests to alwisofwan1 or acme\/acme/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop watching GitHub" }));
    await waitFor(() => expect(client.setRequestSource).toHaveBeenCalledWith("a1", "github", null));
  });

  it("shows the reason GitHub refused the settings", async () => {
    const client = fakeClient({ setRequestSource: vi.fn(async () => Promise.reject("github: team \"acme\" is not org/team-slug")) });
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    fireEvent.click(screen.getByRole("button", { name: "Watch GitHub" }));
    fireEvent.change(screen.getByLabelText("GitHub team"), { target: { value: "acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/is not org\/team-slug/)).toBeInTheDocument();
  });

  it("points to Connectors when Slack is not set up", async () => {
    const onOpenConnectors = vi.fn();
    renderSurface(fakeClient(), { onOpenConnectors });
    await openAutomation("Review orbit PRs");
    fireEvent.click(screen.getByRole("button", { name: "connect Slack" }));
    expect(onOpenConnectors).toHaveBeenCalled();
  });

  it("deletes only after a second, explicit confirmation", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(client.deleteAutomation).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog", { name: "Delete automation" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(client.deleteAutomation).toHaveBeenCalledWith("a1"));
    expect(await screen.findByRole("list", { name: "Automations" })).toBeInTheDocument();
  });
});

describe("A scheduled prompt's page", () => {
  it("says it is off and turns on only when the user presses Turn on", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openAutomation("Morning brief");
    expect(screen.getByText(/Off\. It runs only after you turn it on/)).toBeInTheDocument();
    expect(client.setEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(client.setEnabled).toHaveBeenCalledWith("a2", true));
  });

  it("runs now from the menu", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openAutomation("Morning brief");
    fireEvent.click(screen.getByRole("menuitem", { name: "Run now" }));
    await waitFor(() => expect(client.runScheduledNow).toHaveBeenCalledWith("a2"));
    expect(await screen.findByText(/Run started/)).toBeInTheDocument();
  });

  it("shows its schedule and delivery in words", async () => {
    renderSurface(fakeClient());
    await openAutomation("Morning brief");
    const schedule = screen.getByRole("region", { name: "Schedule" });
    expect(within(schedule).getByText("9AM Mon-Fri")).toBeInTheDocument();
    expect(within(schedule).getByText("Asia/Jakarta")).toBeInTheDocument();
    expect(screen.getByText("Your Slack DM, automatically")).toBeInTheDocument();
  });
});

// ---------- Inbox ----------

describe("Inbox", () => {
  it("shows a running run's thread as working, and waits to be written to", async () => {
    const running = { ...run, id: "r7", status: "running" as const, detail: null, finishedAtMs: null, sessionCwd: "/w" };
    const client = fakeClient({
      runs: vi.fn(async () => [running]),
      runConversation: vi.fn(async () => ({ runId: "r7", running: true, canReply: false, whyNot: null, entries: [] })),
    });
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    fireEvent.click(within(screen.getByRole("list", { name: "Runs" })).getByRole("button"));
    const thread = await screen.findByRole("region", { name: "Conversation with the agent" });
    expect(within(thread).getByLabelText("The agent is working")).toBeInTheDocument();
    expect(within(thread).getByRole("textbox", { name: "Message the agent" })).toBeDisabled();
  });
  it("says a run that watches in a pane may be waiting for the user there", async () => {
    const inPane = { ...reviewer, config: { ...reviewer.config!, workspaceId: "ws-orbit", openPane: true } };
    const running = { ...run, id: "r7", status: "running" as const, detail: null, finishedAtMs: null };
    renderSurface(fakeClient({ list: vi.fn(async () => [inPane, brief]), runs: vi.fn(async () => [running]) }));
    await openAutomation("Review orbit PRs");
    const now = await screen.findByRole("region", { name: "Running now" });
    expect(within(now).getByText(/Running in a pane in orbit: look there/)).toBeInTheDocument();
  });

  it("lists what is running now at the top of the Inbox, with its steps", async () => {
    const running = { ...run, id: "r7", status: "running" as const, detail: null, finishedAtMs: null };
    const client = fakeClient({ runs: vi.fn(async () => [running]), runSteps: vi.fn(async () => [{ atMs: 1, text: "Read src/app.ts" }]) });
    renderSurface(client);
    await openInbox();
    const now = await screen.findByRole("region", { name: "Running now" });
    expect(within(now).getByText("Review orbit PRs")).toBeInTheDocument();
    expect(await within(now).findByText("Read src/app.ts")).toBeInTheDocument();
  });

  it("names a running Follow-up Run as one, never by its raw key", async () => {
    const ask = "6f1c2b9e-0a4d-4c1e-9f5a-1b2c3d4e5f60";
    const first = { ...run, id: "r7", key: `answer@${ask}`, status: "running" as const, detail: null, finishedAtMs: null };
    const again = { ...first, id: "r8", key: `answer@${ask}#2` };
    renderSurface(fakeClient({ runs: vi.fn(async () => [first, again]) }));
    await openInbox();
    const now = await screen.findByRole("region", { name: "Running now" });
    expect(within(now).getAllByText("Follow-up")).toHaveLength(2);
    expect(within(now).queryByText(/answer@/)).not.toBeInTheDocument();
  });

  it("talks to a scheduled prompt's agent under its result, like a Slack thread", async () => {
    const result: AutomationDraft = {
      ...draft,
      id: "res1",
      runId: "r3",
      automationId: "a2",
      kind: "agent_prompt",
      subject: "Morning brief",
      content: null,
      result: { text: "3 PRs.", dm: "off", channel: "C1" },
    };
    const client = fakeClient({ drafts: vi.fn(async () => []), results: vi.fn(async () => [result]) });
    renderSurface(client);
    await openInbox();
    await screen.findByRole("article", { name: "Morning brief result" });
    const thread = await screen.findByRole("region", { name: "Conversation with the agent" });
    expect(client.runConversation).toHaveBeenCalledWith("r3");
    expect(within(thread).getByText(/A new result it makes waits in Inbox for Send/)).toBeInTheDocument();
    const box = within(thread).getByRole("textbox", { name: "Message the agent" });
    fireEvent.change(box, { target: { value: "  Shorter, please.  " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(client.sendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(client.sendMessage).toHaveBeenCalledWith("r1", "Shorter, please.", expect.any(String)));
    // Shown at once, before the agent's transcript has it.
    expect(await within(thread).findByRole("article", { name: "You" })).toHaveTextContent("Shorter, please.");
    expect(box).toHaveValue("");
  });

  it("keeps the message and says why when it cannot be sent", async () => {
    const client = fakeClient({ sendMessage: vi.fn(async () => Promise.reject("the agent is still working; send your message when it has finished")) });
    renderSurface(client);
    await inboxCard();
    const thread = await screen.findByRole("region", { name: "Conversation with the agent" });
    const box = within(thread).getByRole("textbox", { name: "Message the agent" });
    fireEvent.change(box, { target: { value: "Why?" } });
    fireEvent.click(within(thread).getByRole("button", { name: "Send message" }));
    expect(await within(thread).findByRole("alert")).toHaveTextContent("still working");
    expect(box).toHaveValue("Why?");
  });
  it("shows a review's conversation under its draft: words as messages, the rest folded", async () => {
    const client = fakeClient({
      runConversation: vi.fn(async () => ({
        runId: "r1",
        running: false,
        canReply: true,
        whyNot: null,
        entries: [
          { kind: "instructions" as const, text: "You are reviewing a GitHub pull request…", atMs: 1 },
          { kind: "step" as const, tool: "Read", text: "src/app.ts", atMs: 2 },
          { kind: "step" as const, tool: "Grep", text: "eval", atMs: 3 },
          { kind: "result" as const, result: { summary: "One risky line.", comments: [{ path: "a", line: 1 }] }, atMs: 4 },
          { kind: "you" as const, text: "Is line 1 really a blocker?", atMs: 5 },
          { kind: "agent" as const, text: "Yes: it runs eval on the query.", atMs: 6 },
        ],
      })),
    });
    renderSurface(client);
    const card = await inboxCard();
    expect(within(card).queryByRole("button", { name: /Open the agent's conversation/ })).toBeNull();
    const thread = await screen.findByRole("region", { name: "Conversation with the agent" });
    expect(within(thread).getByText("What Lotus told the agent")).toBeInTheDocument();
    expect(within(thread).getByText("Used 2 tools")).toBeInTheDocument();
    expect(within(thread).getByText("Handed back a review draft · 1 comment")).toBeInTheDocument();
    expect(within(thread).getByRole("article", { name: "Agent" })).toHaveTextContent("Yes: it runs eval on the query.");
    expect(within(thread).getByText(/read-only\. Nothing is posted to GitHub or Slack/)).toBeInTheDocument();
  });
  it("sends what the reviewer edited, not what the agent wrote", async () => {
    const client = fakeClient();
    renderSurface(client);
    const card = await inboxCard();
    expect(within(card).getByText("One risky line.")).toBeInTheDocument(); // read, not a text box
    expect(within(card).queryByRole("textbox", { name: "Summary" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Edit summary" }));
    fireEvent.change(within(card).getByLabelText("Summary"), { target: { value: "Edited summary." } });
    fireEvent.click(within(card).getByRole("button", { name: "Remove comment on src/app.ts:12" }));
    fireEvent.click(within(card).getByRole("button", { name: "Comment on GitHub" }));
    await waitFor(() =>
      expect(client.sendDraft).toHaveBeenCalledWith(
        "d1",
        { summary: "Edited summary.", comments: [{ path: "src/app.ts", line: 11, severity: "blocker", body: "eval on user input." }] },
        false,
        false,
      ),
    );
    expect(await within(card).findByRole("link", { name: "Commented on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/x#review-1",
    );
  });

  it("shows each comment's severity and lets the reviewer change it before Send", async () => {
    const client = fakeClient();
    renderSurface(client);
    const card = await inboxCard();
    const blocker = within(card).getByLabelText("Severity of comment on src/app.ts:11");
    expect(blocker).toHaveValue("blocker");
    expect(within(card).getByLabelText("Severity of comment on src/app.ts:12")).toHaveValue("");
    fireEvent.change(blocker, { target: { value: "question" } });
    await waitFor(() =>
      expect(client.updateDraft).toHaveBeenCalledWith("d1", {
        summary: "One risky line.",
        comments: [
          { path: "src/app.ts", line: 11, severity: "question", body: "eval on user input." },
          { path: "src/app.ts", line: 12, body: "nitpick" },
        ],
      }),
    );
    fireEvent.change(blocker, { target: { value: "" } });
    fireEvent.click(within(card).getByRole("button", { name: "Comment on GitHub" }));
    await waitFor(() =>
      expect(client.sendDraft).toHaveBeenCalledWith(
        "d1",
        {
          summary: "One risky line.",
          comments: [
            { path: "src/app.ts", line: 11, body: "eval on user input." },
            { path: "src/app.ts", line: 12, body: "nitpick" },
          ],
        },
        false,
        false,
      ),
    );
  });

  it("holds a stale draft back and sends it only when the reviewer insists", async () => {
    const sendDraft = vi
      .fn<AutomationClient["sendDraft"]>()
      .mockResolvedValueOnce({ status: "stale", reviewed: "abc1234def", current: "fff9999aaa" })
      .mockResolvedValueOnce({ status: "sent", url: "https://github.com/x#review-2" });
    renderSurface(fakeClient({ sendDraft }));
    const card = await inboxCard();
    fireEvent.click(within(card).getByRole("button", { name: "Comment on GitHub" }));
    expect(await within(card).findByText(/moved from abc1234 to fff9999/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Send anyway" }));
    await waitFor(() => expect(sendDraft).toHaveBeenLastCalledWith("d1", expect.anything(), true, false));
  });

  it("tells how many comments were left out, and discards", async () => {
    const client = fakeClient();
    renderSurface(client);
    const card = await inboxCard();
    expect(within(card).getByText(/1 finding was not on the diff: it is in the summary, under “Not on the diff”/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Discard" }));
    expect(client.discardDraft).not.toHaveBeenCalled(); // asks first
    fireEvent.click(within(card).getByRole("button", { name: "Keep" }));
    fireEvent.click(within(card).getByRole("button", { name: "Discard" }));
    fireEvent.click(within(card).getByRole("button", { name: "Discard without reason" }));
    await waitFor(() => expect(client.discardDraft).toHaveBeenCalledWith("d1"));
  });

  it("keeps an optional reason picked when discarding", async () => {
    const client = fakeClient();
    renderSurface(client);
    const card = await inboxCard();
    fireEvent.click(within(card).getByRole("button", { name: "Discard" }));
    fireEvent.click(within(card).getByRole("button", { name: "Too nitpicky" }));
    await waitFor(() => expect(client.discardDraft).toHaveBeenCalledWith("d1", "Too nitpicky"));
  });

  it("offers to reply in the request's Slack thread, ticked by default", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" } };
    const sendDraft = vi.fn(async (): Promise<SendResult> => ({ status: "sent", url: "https://gh/r", slackReply: "replied" }));
    renderSurface(fakeClient({ drafts: vi.fn(async () => [fromSlack]), sendDraft }));
    const card = await inboxCard();
    expect(await within(card).findByRole("checkbox", { name: "Reply in the Slack thread in #code-review" })).toBeChecked();
    expect(within(card).getByText(/asked for a review in #code-review/)).toBeInTheDocument(); // who asked, and where
    fireEvent.click(within(card).getByRole("button", { name: "Send review & reply in Slack" }));
    await waitFor(() => expect(sendDraft).toHaveBeenCalledWith("d1", expect.anything(), false, true));
    expect(await within(card).findByText(/Replied in the Slack thread/)).toBeInTheDocument();
  });

  it("sends every review of one Slack thread with Send all, and shows the one reply", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" }, slackGroup: 2 };
    const sendAll = vi.fn(async (): Promise<[string, SendResult][]> => [
      ["d1", { status: "sent", url: "https://gh/r1", slackReply: "waiting: 1 of 2 sent" }],
      ["d2", { status: "sent", url: "https://gh/r2", slackReply: "replied" }],
    ]);
    renderSurface(fakeClient({ drafts: vi.fn(async () => [fromSlack]), sendAll }));
    const card = await inboxCard();
    fireEvent.click(await within(card).findByRole("button", { name: "Send both + reply in Slack" }));
    await waitFor(() => expect(sendAll).toHaveBeenCalledWith("d1", true, true));
    expect(await within(card).findByText(/Replied in the Slack thread/)).toBeInTheDocument();
  });

  it("groups one Slack request's PRs under who asked, and reads their name in the reply", async () => {
    const asked = { channel: "C1", threadTs: "1.2", requester: "U0TANAKA" };
    const first = { ...draft, slack: asked, slackGroup: 2, createdAtMs: 2 };
    const second: AutomationDraft = {
      ...draft,
      id: "d2",
      subject: "initech/orbit-desktop#146",
      content: { ...draft.content!, repo: "initech/orbit-desktop", number: 146, reply: { verdict: "questions", points: [], lead: "Login can mount late." } },
      slack: asked,
      slackGroup: 2,
      createdAtMs: 3,
    };
    const slackPreview = vi.fn(async () => ({ text: "Hi <@U0TANAKA>-san, thanks for the PRs", waiting: 0 }));
    renderSurface(fakeClient({ drafts: vi.fn(async () => [second, first]), slackPreview }));
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    expect(await within(list).findByText("Tanaka")).toBeInTheDocument();
    expect(within(list).getByText("asked for 2 reviews · #code-review")).toBeInTheDocument();
    // In the order they were asked, owner dropped, the reply's lead as the preview.
    const rows = within(list).getAllByRole("option");
    expect(rows.map((r) => r.querySelector(".au-triage-title")?.textContent)).toEqual(["orbit-app#42", "orbit-desktop#146"]);
    expect(rows[1]).toHaveTextContent("Login can mount late.");
    const card = await inboxCard();
    expect(await within(card).findByLabelText("Slack message preview")).toHaveTextContent("Hi @Tanaka-san, thanks for the PRs");
    expect(within(card).getByRole("button", { name: "Send both + reply to Tanaka" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "desktop#146" }));
    expect(await screen.findByRole("option", { name: /orbit-desktop#146/, selected: true })).toBeInTheDocument();
  });

  it("offers no Send all for a review alone in its thread", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" }, slackGroup: 1 };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [fromSlack]) }));
    const card = await inboxCard();
    await within(card).findByRole("checkbox", { name: /Reply in the Slack thread/ });
    expect(within(card).queryByRole("button", { name: /Send all/ })).not.toBeInTheDocument();
  });

  it("shows the Slack message before Send and sends the reviewer's rewrite as written", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" }, slackGroup: 1 };
    const slackPreview = vi.fn(async () => ({ text: "<@U0SLACKUSR1> 🔧 Changes needed on api#1", waiting: 0 }));
    const sendDraft = vi.fn(async (): Promise<SendResult> => ({ status: "sent", url: "https://gh/r", slackReply: "replied" }));
    renderSurface(fakeClient({ drafts: vi.fn(async () => [fromSlack]), slackPreview, sendDraft }));
    const card = await inboxCard();
    // Read as Slack shows it, then opened for the reviewer's own text.
    expect(await within(card).findByLabelText("Slack message preview")).toHaveTextContent("🔧 Changes needed on api#1");
    expect(within(card).queryByRole("textbox", { name: "Slack message" })).toBeNull();
    expect(slackPreview).toHaveBeenCalledWith("d1", false);
    fireEvent.click(within(card).getByRole("button", { name: "Edit message" }));
    const box = within(card).getByRole("textbox", { name: "Slack message" }) as HTMLTextAreaElement;
    expect(box.value).toBe("<@U0SLACKUSR1> 🔧 Changes needed on api#1");
    fireEvent.change(box, { target: { value: "Tolong cek dulu ya" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send review & reply in Slack" }));
    await waitFor(() => expect(sendDraft).toHaveBeenCalledWith("d1", expect.anything(), false, true, false, "Tolong cek dulu ya"));
  });

  it("sends Lotus's text when the reviewer puts their rewrite back", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" }, slackGroup: 1 };
    const slackPreview = vi.fn(async () => ({ text: "Lotus text", waiting: 0 }));
    const sendDraft = vi.fn(async (): Promise<SendResult> => ({ status: "sent", url: "https://gh/r", slackReply: "replied" }));
    renderSurface(fakeClient({ drafts: vi.fn(async () => [fromSlack]), slackPreview, sendDraft }));
    const card = await inboxCard();
    fireEvent.click(await within(card).findByRole("button", { name: "Edit message" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "Slack message" }), { target: { value: "mine" } });
    fireEvent.click(within(card).getByRole("button", { name: "Use Lotus's text" }));
    expect(within(card).getByLabelText("Slack message preview")).toHaveTextContent("Lotus text");
    fireEvent.click(within(card).getByRole("button", { name: "Send review & reply in Slack" }));
    await waitFor(() => expect(sendDraft).toHaveBeenCalledWith("d1", expect.anything(), false, true));
  });

  it("previews the Send all message and sends the rewrite with it", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" }, slackGroup: 2 };
    const slackPreview = vi.fn(async () => ({ text: "<@U0SLACKUSR1> Review selesai untuk 2 PR:", waiting: 0 }));
    const sendAll = vi.fn(async (): Promise<[string, SendResult][]> => [["d1", { status: "sent", url: "https://gh/r1", slackReply: "replied" }]]);
    renderSurface(fakeClient({ drafts: vi.fn(async () => [fromSlack]), slackPreview, sendAll }));
    const card = await inboxCard();
    expect(await within(card).findByText("One Slack message for all 2 reviews")).toBeInTheDocument();
    expect(slackPreview).toHaveBeenCalledWith("d1", true);
    fireEvent.click(within(card).getByRole("button", { name: "Edit message" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "Slack message" }), { target: { value: "dua PR beres" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send both + reply in Slack" }));
    await waitFor(() => expect(sendAll).toHaveBeenCalledWith("d1", true, true, "dua PR beres"));
  });

  it("says the message waits while other reviews of the thread are pending", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" }, slackGroup: 1 };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [fromSlack]), slackPreview: vi.fn(async () => ({ text: null, waiting: 1 })) }));
    const card = await inboxCard();
    expect(await within(card).findByText(/one message after 1 more review is sent or dismissed/)).toBeInTheDocument();
    expect(within(card).queryByRole("textbox", { name: "Slack message" })).toBeNull();
  });

  it("shows a held Slack reply after one Send, and Reply now posts it", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" }, slackGroup: 2 };
    const sendDraft = vi.fn(async (): Promise<SendResult> => ({ status: "sent", url: "https://gh/r", slackReply: "waiting: 1 of 2 sent" }));
    const replyNow = vi.fn(async () => "replied");
    renderSurface(fakeClient({ drafts: vi.fn(async () => [fromSlack]), sendDraft, replyNow }));
    const card = await inboxCard();
    fireEvent.click(within(card).getByRole("button", { name: "Send this review only" }));
    expect(await within(card).findByText(/1 of 2 sent · Slack waiting/)).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Reply now" }));
    await waitFor(() => expect(replyNow).toHaveBeenCalledWith("d1"));
    expect(await within(card).findByText(/Replied in the Slack thread/)).toBeInTheDocument();
  });

  it("sends the agent's Slack points with the verdict", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" } };
    const client = fakeClient({ drafts: vi.fn(async () => [fromSlack]) });
    renderSurface(client);
    const card = await inboxCard();
    fireEvent.click(await within(card).findByRole("button", { name: "Send review & reply in Slack" }));
    await waitFor(() =>
      expect(client.sendDraft).toHaveBeenCalledWith(
        "d1",
        expect.objectContaining({ reply: { verdict: "changes-needed", points: ["eval on user input. (L11)"] } }),
        false,
        true,
      ),
    );
  });

  it("replies in Slack only, with GitHub switched off, and remembers it for the automation", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" } };
    const client = fakeClient({ drafts: vi.fn(async () => [fromSlack]) });
    const { unmount } = renderSurface(client);
    const card = await inboxCard();
    fireEvent.click(within(card).getByRole("checkbox", { name: /Post on GitHub/ }));
    expect(within(card).queryByRole("group", { name: "GitHub review" })).toBeNull();
    expect(within(card).getByRole("note")).toHaveTextContent("GitHub is off: the 2 line comments are not posted anywhere.");
    fireEvent.click(within(card).getByRole("button", { name: "Reply in Slack" }));
    await waitFor(() => expect(client.sendDraft).toHaveBeenCalledWith("d1", expect.anything(), false, true, false, undefined, false));
    expect(await within(card).findByText("Not posted on GitHub")).toBeInTheDocument();
    unmount();

    renderSurface(fakeClient({ drafts: vi.fn(async () => [fromSlack]) }));
    const again = await inboxCard();
    expect(within(again).getByRole("checkbox", { name: /Post on GitHub/ })).not.toBeChecked();
    expect(within(again).getByRole("checkbox", { name: /Reply in the Slack thread/ })).toBeChecked();
  });

  it("cannot send with both destinations off", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: null } };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [fromSlack]) }));
    const card = await inboxCard();
    fireEvent.click(within(card).getByRole("checkbox", { name: /Post on GitHub/ }));
    fireEvent.click(within(card).getByRole("checkbox", { name: /Reply in the Slack thread/ }));
    expect(within(card).getByRole("button", { name: "Choose where to send" })).toBeDisabled();
  });

  it("lets the reviewer choose a verdict even for a manual review without Slack", async () => {
    const clean = { ...draft, content: { ...draft.content!, comments: [], droppedComments: 0, reply: { verdict: "looks-good" as const, points: [] } } };
    const client = fakeClient({ drafts: vi.fn(async () => [clean]) });
    renderSurface(client);
    const card = await inboxCard();
    fireEvent.click(within(card).getByRole("button", { name: "Questions" }));
    expect(within(card).getByRole("button", { name: "Questions" })).toHaveAttribute("aria-pressed", "true");
    expect(within(card).getByRole("button", { name: "Approve" })).toBeDisabled();
    fireEvent.click(within(card).getByRole("button", { name: "Comment on GitHub" }));
    await waitFor(() => expect(client.sendDraft).toHaveBeenCalledWith("d1", expect.objectContaining({ reply: { verdict: "questions", points: [] } }), false, false));
  });

  it("LGTM over line findings asks once to turn them into suggestions, then Approve opens", async () => {
    const lineOnly = { ...draft, content: { ...draft.content!, droppedComments: 0, offDiffSeverities: [] } };
    const client = fakeClient({ drafts: vi.fn(async () => [lineOnly]) });
    renderSurface(client);
    const card = await inboxCard();
    expect(within(card).getByRole("button", { name: "Approve" })).toBeDisabled();
    fireEvent.click(within(card).getByRole("button", { name: "LGTM" }));
    expect(within(card).getByRole("alertdialog")).toHaveTextContent("Turn 2 findings into suggestions?");
    expect(client.updateDraft).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: "Turn into suggestions" }));
    expect(within(card).getByRole("button", { name: "LGTM" })).toHaveAttribute("aria-pressed", "true");
    expect(within(card).getByLabelText("Severity of comment on src/app.ts:11")).toHaveValue("suggestion");
    await waitFor(() =>
      expect(client.updateDraft).toHaveBeenCalledWith("d1", {
        summary: "One risky line.",
        comments: [
          { path: "src/app.ts", line: 11, severity: "suggestion", body: "eval on user input." },
          { path: "src/app.ts", line: 12, severity: "suggestion", body: "nitpick" },
        ],
        reply: { verdict: "looks-good", points: [] },
      }),
    );
    // Approve is offered, never chosen for the reviewer.
    expect(within(card).getByRole("button", { name: "Comment" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    fireEvent.click(within(card).getByRole("button", { name: "Approve on GitHub" }));
    await waitFor(() => expect(client.approveDraft).toHaveBeenCalledWith("d1", expect.objectContaining({ comments: expect.any(Array) }), false, false));
  });

  it("a suggestion holds nothing back: LGTM and Approve stay open", async () => {
    const ideas = {
      ...draft,
      content: { ...draft.content!, droppedComments: 1, offDiffSeverities: ["suggestion" as const], comments: [{ path: "a.ts", line: 1, severity: "suggestion" as const, body: "Could be a const." }], reply: { verdict: "looks-good" as const, points: [] } },
    };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [ideas]) }));
    const card = await inboxCard();
    expect(within(card).getByRole("button", { name: "LGTM" })).toHaveAttribute("aria-pressed", "true");
    expect(within(card).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("shows one waiting room per PR while retaining older rounds in its history", async () => {
    const newer = { ...draft, id: "d2", runId: "r2", createdAtMs: 30, content: { ...draft.content!, headSha: "sha2", summary: "Fix reviewed" } };
    const reviewRoom = vi.fn(async () => ({ history: [draft, newer], feedback: [] }));
    renderSurface(fakeClient({ drafts: async () => [draft, newer], reviewRoom }));
    await openInbox();
    expect(within(await screen.findByRole("listbox", { name: "Waiting items" })).getAllByRole("option")).toHaveLength(1);
    const card = await inboxCard();
    expect(within(card).getByText("Fix reviewed")).toBeInTheDocument();
    // Read in the pane, the PR's conversation is open on arrival.
    expect(await screen.findByText("Review 1")).toBeInTheDocument();
    const rounds = within(screen.getByRole("list", { name: "Rounds" })).getAllByRole("listitem");
    expect(rounds.map((r) => r.textContent)).toEqual(["Review 1 · Draft", "Review 2 · Draft"]);
    expect(rounds[1]).toHaveAttribute("aria-current", "step");
    expect(screen.getByText("Review 2")).toBeInTheDocument();
    expect(reviewRoom).toHaveBeenCalledWith("a1", draft.content!.url);
  });

  it("groups published rounds of one PR into one room", async () => {
    const first = { ...draft, status: "sent" as const, sentUrl: "https://gh/r1" };
    const second = { ...first, id: "d2", runId: "r2", createdAtMs: 30, sentUrl: "https://gh/r2" };
    renderSurface(fakeClient({ drafts: async () => [], sentReviews: async () => [second, first] }));
    await openInbox();
    expect(within(await screen.findByRole("list", { name: "Sent reviews" })).getAllByRole("link", { name: "initech/orbit-app#42" })).toHaveLength(1);
  });

  it("explains why LGTM stays closed while a finding off the diff remains", async () => {
    renderSurface(fakeClient());
    const card = await inboxCard();
    expect(within(card).getByRole("button", { name: "LGTM" })).toBeDisabled();
    expect(within(card).getByText(/LGTM opens when the remaining findings are resolved/)).toBeInTheDocument();
  });

  it("reports an unsuccessful save and keeps the review editable", async () => {
    const clean = { ...draft, content: { ...draft.content!, comments: [], droppedComments: 0, reply: { verdict: "looks-good" as const, points: [] } } };
    const client = fakeClient({ drafts: vi.fn(async () => [clean]), updateDraft: vi.fn(async () => { throw new Error("disk full"); }) });
    renderSurface(client);
    const card = await inboxCard();
    fireEvent.click(within(card).getByRole("button", { name: "Questions" }));
    expect(await within(card).findByRole("alert")).toHaveTextContent(/Could not save/);
    expect(within(card).getByRole("button", { name: "Questions" })).toBeEnabled();
  });

  it("serializes saves so an older decision cannot overwrite the newer one", async () => {
    let finishFirst!: (saved: boolean) => void;
    const updateDraft = vi.fn().mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFirst = resolve; })).mockResolvedValue(true);
    const clean = { ...draft, content: { ...draft.content!, comments: [], droppedComments: 0, reply: { verdict: "looks-good" as const, points: [] } } };
    const client = fakeClient({ drafts: vi.fn(async () => [clean]), updateDraft });
    renderSurface(client);
    const card = await inboxCard();
    fireEvent.click(within(card).getByRole("button", { name: "Questions" }));
    await waitFor(() => expect(updateDraft).toHaveBeenCalledTimes(1));
    fireEvent.click(within(card).getByRole("button", { name: "Changes needed" }));
    expect(updateDraft).toHaveBeenCalledTimes(1);
    finishFirst(true);
    await waitFor(() => expect(updateDraft).toHaveBeenCalledTimes(2));
    expect(updateDraft).toHaveBeenLastCalledWith("d1", expect.objectContaining({ reply: { verdict: "changes-needed", points: [] } }));
  });

  it("offers Approve only for a review that found nothing, and replies LGTM in the thread", async () => {
    const clean = {
      ...draft,
      slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" },
      content: { ...draft.content!, comments: [], droppedComments: 0, reply: { verdict: "looks-good" as const, points: [] } },
    };
    const client = fakeClient({ drafts: vi.fn(async () => [clean]) });
    renderSurface(client);
    const card = await inboxCard();
    // Comment by default: Approve is the reviewer's own pick (ADR-0042).
    expect(within(card).getByRole("button", { name: "Send review & reply in Slack" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    fireEvent.click(within(card).getByRole("button", { name: "Approve & reply in Slack" }));
    await waitFor(() =>
      expect(client.approveDraft).toHaveBeenCalledWith(
        "d1",
        { summary: "One risky line.", comments: [], reply: { verdict: "looks-good", points: [] } },
        false,
        true,
      ),
    );
    expect(client.sendDraft).not.toHaveBeenCalled();
  });

  it("allows an LGTM comment but no formal approval when coverage is partial", async () => {
    const partial = { ...draft, content: { ...draft.content!, coverage: "partial" as const, comments: [], droppedComments: 0, reply: { verdict: "looks-good" as const, points: [] } } };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [partial]) }));
    const card = await inboxCard();
    expect(within(card).getByText("Partial review")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Comment on GitHub" })).toBeInTheDocument();
  });

  it("shows how each earlier finding stands on a re-review, and closes the resolved threads", async () => {
    const rereview = {
      ...draft,
      slack: { channel: "C1", threadTs: "1.2", requester: "U0SLACKUSR1" },
      content: {
        ...draft.content!,
        comments: [],
        droppedComments: 0,
        reply: { verdict: "looks-good" as const, points: [] },
        sinceSha: "0dc8e66f16b5",
        previous: [
          { path: "src/a.tsx", line: 1394, severity: "should-fix" as const, body: "Name overflows.", status: "fixed", note: "noWrap added", hasThread: true },
          { path: "src/b.tsx", line: 238, severity: "question" as const, body: "Why 960px?", status: "answered", note: null, hasThread: false },
        ],
      },
    };
    const client = fakeClient({ drafts: vi.fn(async () => [rereview]) });
    renderSurface(client);
    const card = await inboxCard();
    expect(await within(card).findByText("Since the last review (0dc8e66)")).toBeInTheDocument();
    expect(within(card).getByText("Fixed")).toBeInTheDocument();
    expect(within(card).getByText("Answered")).toBeInTheDocument();
    expect(within(card).getByText(/noWrap added/)).toBeInTheDocument();
    const close = within(card).getByRole("checkbox", { name: /Reply ✅ on 1 resolved GitHub thread/ });
    expect(close).toBeChecked();
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    fireEvent.click(within(card).getByRole("button", { name: "Approve & reply in Slack" }));
    await waitFor(() => expect(client.approveDraft).toHaveBeenCalledWith("d1", expect.anything(), false, true, true));
  });

  it("does not offer Approve while an earlier finding is still open", async () => {
    const open = {
      ...draft,
      content: {
        ...draft.content!,
        comments: [],
        droppedComments: 0,
        reply: { verdict: "changes-needed" as const, points: [] },
        sinceSha: "0dc8e66f16b5",
        previous: [{ path: "src/a.tsx", line: 1, severity: "should-fix" as const, body: "x", status: "not-fixed", note: null, hasThread: true }],
      },
    };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [open]) }));
    const card = await inboxCard();
    expect(await within(card).findByText("Still open")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("never offers Approve while the review has a finding", async () => {
    renderSurface(fakeClient());
    const card = await inboxCard();
    expect(within(card).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Comment on GitHub" })).toBeInTheDocument();
  });

  it("hides the Slack reply when it will not be sent", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: null } };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [fromSlack]), slackPreview: vi.fn(async () => ({ text: "🔧 Changes needed", waiting: 0 })) }));
    const card = await inboxCard();
    expect(await within(card).findByLabelText("Slack message preview")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("checkbox", { name: /Reply in the Slack thread/ }));
    expect(within(card).queryByLabelText("Slack message preview")).toBeNull();
  });

  it("does not reply when unticked, and has no box for a draft that did not come from Slack", async () => {
    const fromSlack = { ...draft, slack: { channel: "C1", threadTs: "1.2", requester: null } };
    const client = fakeClient({ drafts: vi.fn(async () => [fromSlack]) });
    const { unmount } = renderSurface(client);
    const card = await inboxCard();
    fireEvent.click(within(card).getByRole("checkbox", { name: /Reply in the Slack thread/ }));
    fireEvent.click(within(card).getByRole("button", { name: "Comment on GitHub" }));
    await waitFor(() => expect(client.sendDraft).toHaveBeenCalledWith("d1", expect.anything(), false, false));
    unmount();

    renderSurface(fakeClient());
    const plain = await inboxCard();
    expect(within(plain).queryByRole("checkbox", { name: /Reply in the Slack thread/ })).toBeNull();
    expect(within(plain).getByText("Manual")).toBeInTheDocument();
    expect(within(plain).getByText("No Slack reply: this PR was not asked for in Slack")).toBeInTheDocument();
  });

  it("edits one line comment in place, and says who the review posts as", async () => {
    const client = fakeClient();
    renderSurface(client);
    const card = await inboxCard();
    expect(within(card).getByRole("checkbox", { name: "Post on GitHub as alwisofwan1" })).toBeChecked();
    fireEvent.click(within(card).getByRole("button", { name: "Edit comment on src/app.ts:11" }));
    fireEvent.change(within(card).getByLabelText("Comment on src/app.ts:11"), { target: { value: "Never eval input." } });
    fireEvent.click(within(card).getByRole("button", { name: "Done" }));
    expect(within(card).getByText("Never eval input.")).toBeInTheDocument();
    await waitFor(() =>
      expect(client.updateDraft).toHaveBeenLastCalledWith("d1", {
        summary: "One risky line.",
        comments: [
          { path: "src/app.ts", line: 11, severity: "blocker", body: "Never eval input." },
          { path: "src/app.ts", line: 12, body: "nitpick" },
        ],
      }),
    );
  });

  it("lists sent reviews with what happened in Slack, so a missing reply is visible", async () => {
    const sentBase: AutomationDraft = { ...draft, status: "sent", sentUrl: "https://github.com/x#r1", sentAtMs: 10 };
    const replied = { ...sentBase, content: { ...sentBase.content!, repo: "o/r", number: 1 }, id: "s1", subject: "o/r#1", slack: { channel: "C1", threadTs: "1.2", requester: null }, slackReply: "replied" };
    const failed = { ...sentBase, content: { ...sentBase.content!, repo: "o/r", number: 2 }, id: "s2", subject: "o/r#2", slack: { channel: "C1", threadTs: "1.3", requester: null }, slackReply: "not replied: missing_scope" };
    const manual = { ...sentBase, content: { ...sentBase.content!, repo: "o/r", number: 3 }, id: "s3", subject: "o/r#3", slack: null, slackReply: null };
    const held = { ...sentBase, content: { ...sentBase.content!, repo: "o/r", number: 4 }, id: "s4", subject: "o/r#4", slack: { channel: "C1", threadTs: "1.4", requester: null }, slackReply: "waiting: 1 of 2 sent" };
    renderSurface(fakeClient({ drafts: vi.fn(async () => []), sentReviews: vi.fn(async () => [replied, failed, manual, held]) }));
    await openInbox();
    const list = await screen.findByRole("list", { name: "Sent reviews" });
    expect(await within(list).findByText(/Replied in #code-review/)).toBeInTheDocument();
    expect(within(list).getByText(/Not replied: missing_scope/)).toBeInTheDocument();
    expect(within(list).getByText("Not from Slack")).toBeInTheDocument();
    expect(within(list).getByText(/1 of 2 sent · Slack waiting/)).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "Reply now" })).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: /o\/r#1/ })).toHaveAttribute("href", "https://github.com/x#r1");
  });

  it("keeps a channel result waiting until Send, and shows delivered ones below", async () => {
    const waiting: AutomationDraft = {
      ...draft,
      id: "res1",
      automationId: "a2",
      kind: "agent_prompt",
      subject: "Morning brief",
      content: null,
      result: { text: "3 PRs wait for review.", dm: "off", channel: "C1" },
    };
    const done: AutomationDraft = {
      ...waiting,
      id: "res2",
      status: "sent",
      result: { text: "Yesterday: 2 PRs.", dm: "sent", channel: null },
    };
    const client = fakeClient({ drafts: vi.fn(async () => []), results: vi.fn(async () => [waiting, done]) });
    renderSurface(client);
    await openInbox();
    const recent = await screen.findByRole("region", { name: "Recent results" });
    expect(within(recent).getByText("Yesterday: 2 PRs.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: /^Waiting for you/ })).getByRole("option", { name: /Morning brief/ })).toBeInTheDocument();
    // The open item is read in the right pane.
    const card = within(screen.getByRole("complementary", { name: "Automation pane" })).getByRole("article", { name: "Morning brief result" });
    expect(within(card).getByText("3 PRs wait for review.")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Edit message" }));
    fireEvent.change(screen.getByLabelText("Result for Morning brief"), { target: { value: "3 PRs wait (edited)." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to channel" }));
    await waitFor(() => expect(client.sendResult).toHaveBeenCalledWith("res1", "3 PRs wait (edited)."));
  });

  it("shows where a result went in Google and sends a failed write again", async () => {
    const done: AutomationDraft = {
      ...draft,
      id: "res9",
      automationId: "a2",
      kind: "agent_prompt",
      subject: "Daily service monitoring",
      status: "sent",
      content: null,
      result: {
        text: "All 14 services up.",
        dm: "sent",
        channel: null,
        google: {
          sheet: { status: "not_sent", url: null, detail: "append rows: the file was deleted or Lotus has no access to it", reconnect: false },
          drive: { status: "sent", url: "https://docs.google.com/document/d/D1/edit", detail: "Daily service monitoring — 2026-09-28", reconnect: false },
        },
      },
    };
    const client = fakeClient({ drafts: vi.fn(async () => []), results: vi.fn(async () => [done]) });
    renderSurface(client);
    await openInbox();
    const google = await screen.findByRole("region", { name: "Sent to Google" });
    const sheet = within(google).getByRole("listitem", { name: "Google Sheet" });
    expect(sheet).toHaveTextContent("Not sent");
    expect(sheet).toHaveTextContent("deleted or Lotus has no access");
    const drive = within(google).getByRole("listitem", { name: "Google Drive" });
    expect(within(drive).getByRole("link", { name: "Open file" })).toHaveAttribute("href", "https://docs.google.com/document/d/D1/edit");
    fireEvent.click(within(google).getByRole("button", { name: "Send again to Google" }));
    await waitFor(() => expect(client.resendGoogle).toHaveBeenCalledWith("res9"));
  });

  it("lists everything waiting as rows and opens one at a time, moved with the keys", async () => {
    const result: AutomationDraft = {
      ...draft,
      id: "res1",
      automationId: "a2",
      kind: "agent_prompt",
      subject: "Morning brief",
      content: null,
      createdAtMs: draft.createdAtMs + 1000,
      result: { text: "## Today\n3 PRs wait for **review**.", dm: "off", channel: "C1" },
    };
    renderSurface(fakeClient({ results: vi.fn(async () => [result]) }));
    await openInbox();
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    const rows = within(list).getAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("aria-selected", "true");
    expect(within(rows[0]).getByText("Today 3 PRs wait for review.")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Morning brief result" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "initech/orbit-app#42" })).not.toBeInTheDocument();

    fireEvent.keyDown(rows[0], { key: "j" });
    expect(within(list).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("article", { name: "initech/orbit-app#42" })).toBeInTheDocument();
    fireEvent.click(within(list).getAllByRole("option")[0]);
    expect(screen.getByRole("article", { name: "Morning brief result" })).toBeInTheDocument();
  });

  it("keeps a result edit while another row is open", async () => {
    const result: AutomationDraft = {
      ...draft,
      id: "res1",
      automationId: "a2",
      kind: "agent_prompt",
      subject: "Morning brief",
      content: null,
      createdAtMs: draft.createdAtMs + 1000,
      result: { text: "3 PRs.", dm: "off", channel: "C1" },
    };
    renderSurface(fakeClient({ results: vi.fn(async () => [result]) }));
    await openInbox();
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    fireEvent.change(screen.getByLabelText("Result for Morning brief"), { target: { value: "4 PRs." } });
    fireEvent.click(within(list).getAllByRole("option")[1]);
    fireEvent.click(within(list).getAllByRole("option")[0]);
    expect(screen.getByText("4 PRs.", { selector: ".au-review-text *" })).toBeInTheDocument();
  });

  it("marks an older run of the same automation and lets it be discarded", async () => {
    const base: AutomationDraft = {
      ...draft,
      automationId: "a2",
      kind: "agent_prompt",
      subject: "Daily report",
      content: null,
      result: { text: "Report.", dm: "off", channel: "C1" },
    };
    const newer = { ...base, id: "new", createdAtMs: 2000 };
    const older = { ...base, id: "old", createdAtMs: 1000 };
    const client = fakeClient({ drafts: vi.fn(async () => []), results: vi.fn(async () => [newer, older]) });
    renderSurface(client);
    await openInbox();
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    const rows = within(list).getAllByRole("option");
    expect(within(rows[0]).queryByText("Older run")).not.toBeInTheDocument();
    expect(within(rows[1]).getByText("Older run")).toBeInTheDocument();
    fireEvent.click(rows[1]);
    expect(screen.getByText(/A newer run of this automation/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(client.discardDraft).toHaveBeenCalledWith("old"));
  });

  it("puts an Ask first, tagged, with its question and choices, and Dismiss closes it", async () => {
    const ask: AutomationDraft = {
      ...draft,
      id: "ask1",
      runId: "r7",
      automationId: "a2",
      kind: "ask",
      subject: "Ticket runner",
      content: null,
      createdAtMs: draft.createdAtMs - 1,
      ask: { question: "Approve these **seams**?\n\n- RLS on jobs", choices: ["Approve", "Reject"], actionKind: "agent_prompt" },
    };
    const client = fakeClient({ drafts: vi.fn(async () => [draft, ask]) });
    renderSurface(client);
    await openInbox();
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    const rows = within(list).getAllByRole("option");
    expect(within(rows[0]).getByText("Ticket runner")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Needs your answer")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("Needs your answer")).not.toBeInTheDocument();

    const card = screen.getByRole("article", { name: "Ticket runner question" });
    expect(within(card).getByText("seams", { selector: "strong" })).toBeInTheDocument();
    expect(within(card).getByText("Approve")).toBeInTheDocument();
    expect(within(card).getByText("Reject")).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
    fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(client.discardDraft).toHaveBeenCalledWith("ask1"));
  });

  it("never marks a result as older than an Ask, nor an Ask as older than a result", async () => {
    const ask: AutomationDraft = {
      ...draft,
      id: "ask1",
      automationId: "a2",
      kind: "ask",
      subject: "Daily report",
      content: null,
      createdAtMs: 1000,
      ask: { question: "Which repo?", choices: [], actionKind: "agent_prompt" },
    };
    const result: AutomationDraft = {
      ...draft,
      id: "res1",
      automationId: "a2",
      kind: "agent_prompt",
      subject: "Daily report",
      content: null,
      createdAtMs: 2000,
      result: { text: "Report.", dm: "off", channel: "C1" },
    };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [ask]), results: vi.fn(async () => [result]) }));
    await openInbox();
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    expect(within(list).queryByText("Older run")).not.toBeInTheDocument();
  });

  it("tags an Ask Older run when a newer Ask of the same automation waits", async () => {
    const ask = (id: string, question: string, createdAtMs: number, automationId = "a2"): AutomationDraft => ({
      ...draft,
      id,
      automationId,
      kind: "ask",
      subject: "Ticket runner",
      content: null,
      createdAtMs,
      ask: { question, choices: [], actionKind: "agent_prompt" },
    });
    renderSurface(
      fakeClient({ drafts: vi.fn(async () => [ask("old", "Ticket 6?", 1000), ask("new", "Ticket 7?", 2000), ask("other", "Other?", 500, "a3")]) }),
    );
    await openInbox();
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    const row = (text: string) => within(list).getByText(text).closest("li")!;
    expect(within(row("Ticket 6?")).getByText("Older run")).toBeInTheDocument();
    expect(within(row("Ticket 7?")).queryByText("Older run")).not.toBeInTheDocument();
    expect(within(row("Other?")).queryByText("Older run")).not.toBeInTheDocument();
  });

  it("brings back an Ask whose follow-up failed, and Send again resends the saved answer", async () => {
    const ask: AutomationDraft = {
      ...draft,
      id: "ask1",
      automationId: "a2",
      kind: "ask",
      subject: "Ticket runner",
      content: null,
      ask: {
        question: "Approve these seams?",
        choices: ["Approve", "Reject"],
        actionKind: "agent_prompt",
        answer: { choice: "Approve", note: "add an abuse test", answeredAtMs: 5, followUpRunId: "r-fail", failedRunId: "r-fail" },
      },
    };
    const client = fakeClient({ drafts: vi.fn(async () => [ask]) });
    renderSurface(client);
    await openInbox();
    const card = await screen.findByRole("article", { name: "Ticket runner question" });
    expect(within(card).getByRole("alert")).toHaveTextContent("The follow-up run failed");
    expect(within(card).getByText("Answered: Approve · add an abuse test")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(client.answerAsk).toHaveBeenCalledWith("ask1", "Approve", "add an abuse test"));
    expect(await within(card).findByText("The agent continues now; see Running now.")).toBeInTheDocument();
  });

  it("shows a chain's earlier questions and answers above the new Ask", async () => {
    const ask: AutomationDraft = {
      ...draft,
      id: "ask2",
      automationId: "a2",
      kind: "ask",
      subject: "Ticket runner",
      content: null,
      ask: {
        question: "Push to main?",
        choices: ["Push", "Wait"],
        actionKind: "agent_prompt",
        answer: null,
        chain: [{ question: "Approve these **seams**?", choice: "Approve", note: "add an abuse test" }],
      },
    };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [ask]) }));
    await openInbox();
    const card = await screen.findByRole("article", { name: "Ticket runner question" });
    const earlier = within(card).getByRole("list", { name: "Earlier questions" });
    expect(within(earlier).getByText("seams", { selector: "strong" })).toBeInTheDocument();
    expect(within(earlier).getByText("Answered: Approve · add an abuse test")).toBeInTheDocument();
    expect(earlier.compareDocumentPosition(within(card).getByText("Push to main?")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows an Ask as a question on its automation's own page too", async () => {
    const ask: AutomationDraft = {
      ...draft,
      id: "ask1",
      automationId: "a2",
      kind: "ask",
      subject: "Morning brief",
      content: null,
      ask: { question: "Which repo first?", choices: ["orbit", "lotus"], actionKind: "agent_prompt" },
    };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [ask]) }));
    // Something waits in this channel: its row opens the question in the pane.
    await openChannel("Morning brief");
    await openSelectedRow();
    const card = await screen.findByRole("article", { name: "Morning brief question" });
    expect(within(card).getByText("Which repo first?")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Morning brief result" })).not.toBeInTheDocument();
  });

  it.each([
    ["j", "k"],
    ["ArrowDown", "ArrowUp"],
  ])("moves between an Ask and a draft with %s and %s", async (down, up) => {
    const ask: AutomationDraft = {
      ...draft,
      id: "ask1",
      automationId: "a2",
      kind: "ask",
      subject: "Ticket runner",
      content: null,
      ask: { question: "Approve?", choices: ["Approve"], actionKind: "agent_prompt" },
    };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [draft, ask]) }));
    await openInbox();
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    fireEvent.keyDown(within(list).getAllByRole("option")[0], { key: down });
    expect(await screen.findByRole("article", { name: "initech/orbit-app#42" })).toBeInTheDocument();
    fireEvent.keyDown(within(list).getAllByRole("option")[1], { key: up });
    expect(await screen.findByRole("article", { name: "Ticket runner question" })).toBeInTheDocument();
  });

  it("answers an Ask with a choice and a note, and says it is answered", async () => {
    const ask: AutomationDraft = {
      ...draft,
      id: "ask1",
      automationId: "a2",
      kind: "ask",
      subject: "Ticket runner",
      content: null,
      ask: { question: "Approve these seams?", choices: ["Approve", "Reject"], actionKind: "agent_prompt", answer: null },
    };
    const client = fakeClient({ drafts: vi.fn(async () => [ask]) });
    renderSurface(client);
    await openInbox();
    const card = await screen.findByRole("article", { name: "Ticket runner question" });
    fireEvent.change(within(card).getByLabelText("Note for the agent"), { target: { value: "add an abuse test" } });
    fireEvent.click(within(card).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(client.answerAsk).toHaveBeenCalledWith("ask1", "Reject", "add an abuse test"));
    expect(await within(card).findByText("Answered: Reject · add an abuse test")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("takes a free-text answer when the Ask offers no choices", async () => {
    const ask: AutomationDraft = {
      ...draft,
      id: "ask2",
      automationId: "a2",
      kind: "ask",
      subject: "Ticket runner",
      content: null,
      ask: { question: "Which ticket first?", choices: [], actionKind: "agent_prompt", answer: null },
    };
    const client = fakeClient({ drafts: vi.fn(async () => [ask]) });
    renderSurface(client);
    await openInbox();
    const card = await screen.findByRole("article", { name: "Ticket runner question" });
    const send = within(card).getByRole("button", { name: "Send answer" });
    expect(send).toBeDisabled();
    fireEvent.change(within(card).getByLabelText("Your answer"), { target: { value: "Ticket 7" } });
    fireEvent.click(send);
    await waitFor(() => expect(client.answerAsk).toHaveBeenCalledWith("ask2", null, "Ticket 7"));
  });

  it("says which PR's agent asked a review question, shows its links in full and its labels as plain text", async () => {
    const ask: AutomationDraft = {
      ...draft,
      id: "ask-r",
      automationId: "a1",
      kind: "ask",
      subject: "initech/orbit-app#42",
      content: null,
      ask: {
        question: "No ticket link. Is it [TKT-7](https://evil.example/x)? ![](https://evil.example/pixel.png)",
        choices: ["**Approve**", "TKT-8"],
        actionKind: "pr_review",
        answer: null,
        review: { repo: "initech/orbit-app", number: 42, url: "https://github.com/initech/orbit-app/pull/42" },
      },
    };
    const client = fakeClient({ drafts: vi.fn(async () => [ask]) });
    renderSurface(client);
    await openInbox();
    const card = await screen.findByRole("article", { name: "initech/orbit-app#42 question" });
    expect(within(card).getByText("Asked by the agent reviewing initech/orbit-app#42")).toBeInTheDocument();
    // A link shows where it goes, never words the PR's author chose; an image is not loaded.
    expect(within(card).getByRole("link", { name: "https://evil.example/x" })).toBeInTheDocument();
    expect(within(card).queryByText("TKT-7")).not.toBeInTheDocument();
    expect(card.querySelector("img")).toBeNull();
    expect(within(card).getByRole("link", { name: "https://evil.example/pixel.png" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "**Approve**" }));
    await waitFor(() => expect(client.answerAsk).toHaveBeenCalledWith("ask-r", "**Approve**", ""));
  });

  it("names no PR on a scheduled prompt's question", async () => {
    const ask: AutomationDraft = {
      ...draft,
      id: "ask-p",
      automationId: "a2",
      kind: "ask",
      subject: "Ticket runner",
      content: null,
      ask: { question: "Approve [the plan](https://example.com/plan)?", choices: ["Approve"], actionKind: "agent_prompt", answer: null },
    };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [ask]) }));
    await openInbox();
    const card = await screen.findByRole("article", { name: "Ticket runner question" });
    expect(within(card).queryByText(/Asked by the agent reviewing/)).not.toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "the plan" })).toBeInTheDocument();
  });

  it("opens Inbox on the Ask a notification pointed to, even when it is not the first row", async () => {
    const ask = (id: string, question: string, createdAtMs: number): AutomationDraft => ({
      ...draft,
      id,
      automationId: "a2",
      kind: "ask",
      subject: "Ticket runner",
      content: null,
      createdAtMs,
      ask: { question, choices: ["Approve"], actionKind: "agent_prompt", answer: null },
    });
    const client = fakeClient({ drafts: vi.fn(async () => [ask("newer", "Ticket 8?", 2000), ask("older", "Ticket 7?", 1000)]) });
    const { rerender } = renderSurface(client);
    await openTab("Installed");
    const side = screen.getByRole("complementary", { name: "Automations sidebar" });
    expect(within(side).getByRole("button", { name: "All automations" })).toHaveAttribute("aria-current", "page");

    rerender(
      <AutomationSurface
        client={client}
        subscribe={noSubscribe}
        onClose={() => undefined}
        projects={projects}
        openAsk={{ id: "older", seq: 1 }}
      />,
    );
    expect(within(side).getByRole("button", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
    const card = await screen.findByRole("article", { name: "Ticket runner question" });
    expect(within(card).getByText("Ticket 7?")).toBeInTheDocument();
  });

  it("lists answered Asks with the answer, below what waits", async () => {
    const answered: AutomationDraft = {
      ...draft,
      id: "ask3",
      automationId: "a2",
      kind: "ask",
      status: "sent",
      subject: "Ticket runner",
      content: null,
      ask: {
        question: "Approve these seams?",
        choices: ["Approve", "Reject"],
        actionKind: "agent_prompt",
        answer: { choice: "Approve", note: "ship it", answeredAtMs: 5, followUpRunId: "r2" },
      },
    };
    const client = fakeClient({ drafts: vi.fn(async () => []), answeredAsks: vi.fn(async () => [answered]) });
    renderSurface(client);
    await openInbox();
    const section = await screen.findByRole("region", { name: "Answered" });
    expect(within(section).getByText("Answered: Approve · ship it")).toBeInTheDocument();
    expect(within(section).getByText("Approve these seams?")).toBeInTheDocument();
  });

  it("says so when nothing waits", async () => {
    renderSurface(fakeClient({ drafts: vi.fn(async () => []) }));
    await openInbox();
    expect(await screen.findByText("Nothing waiting")).toBeInTheDocument();
  });
});

// ---------- Results as markdown (PLAN §8 Q5) ----------

describe("A delivered result", () => {
  const delivered: AutomationDraft = {
    ...draft,
    id: "res9",
    runId: "r9",
    automationId: "a2",
    kind: "agent_prompt",
    subject: "Morning brief",
    status: "sent",
    content: null,
    result: {
      text: "## Yesterday\n\n- 2 PRs merged\n- `main` is green\n\nSee [the board](https://example.com/board).",
      dm: "sent",
      channel: null,
    },
  };

  function expectMarkdown(card: HTMLElement) {
    expect(within(card).getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();
    expect(within(card).getAllByRole("listitem")).toHaveLength(2);
    expect(within(card).getByText("main").tagName).toBe("CODE");
    expect(within(card).queryByText(/##/)).toBeNull();
    openExternalLink.mockClear();
    fireEvent.click(within(card).getByRole("link", { name: "the board" }));
    expect(openExternalLink).toHaveBeenCalledWith("https://example.com/board");
  }

  it("reads as markdown in the Inbox, its links opening outside Lotus", async () => {
    renderSurface(fakeClient({ drafts: vi.fn(async () => []), results: vi.fn(async () => [delivered]) }));
    await openInbox();
    const recent = await screen.findByRole("region", { name: "Recent results" });
    expectMarkdown(within(recent).getByRole("article", { name: "Morning brief result" }));
  });

  it("reads as markdown on its automation's own page", async () => {
    renderSurface(fakeClient({ drafts: vi.fn(async () => []), results: vi.fn(async () => [delivered]) }));
    await openAutomation("Morning brief");
    const recent = await screen.findByRole("region", { name: "Recent results" });
    expectMarkdown(within(recent).getByRole("article", { name: "Morning brief result" }));
  });
});

// ---------- Shell: views, channels, counts ----------

describe("Shell", () => {
  it("counts one Inbox row per PR: two rounds of the same PR are one thing waiting", async () => {
    const round2 = { ...draft, id: "d2", runId: "r3", createdAtMs: 5 };
    renderSurface(fakeClient({ drafts: vi.fn(async () => [draft, round2]) }));
    const side = await screen.findByRole("complementary", { name: "Automations sidebar" });
    await waitFor(() => expect(within(side).getByRole("button", { name: "Inbox" })).toHaveTextContent("1"));
    expect(within(screen.getByRole("listbox", { name: "Waiting items" })).getAllByRole("option")).toHaveLength(1);
  });

  it("splits a channel into Open, Waiting on you and Done", async () => {
    renderSurface(fakeClient());
    await openChannel("Review orbit PRs");
    const tabs = screen.getByRole("tablist", { name: "Channel views" });
    expect(within(tabs).getByRole("tab", { name: /Waiting on you/ })).toHaveTextContent("1");
    fireEvent.click(within(tabs).getByRole("tab", { name: "Done" }));
    expect(await screen.findByText("Nothing finished yet")).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Waiting items" })).toBeNull();
    fireEvent.click(within(tabs).getByRole("tab", { name: /Waiting on you/ }));
    expect(await screen.findByRole("listbox", { name: "Waiting items" })).toBeInTheDocument();
  });

  it("shows what runs now, and says so when nothing does", async () => {
    const running = { ...run, id: "r7", status: "running" as const, detail: null, finishedAtMs: null };
    const { unmount } = renderSurface(fakeClient({ runs: vi.fn(async () => [running]) }));
    await openInbox();
    const side = screen.getByRole("complementary", { name: "Automations sidebar" });
    await waitFor(() => expect(within(side).getByRole("button", { name: "Running now" })).toHaveTextContent("1"));
    fireEvent.click(within(side).getByRole("button", { name: "Running now" }));
    expect(await screen.findByRole("region", { name: "Running now" })).toBeInTheDocument();
    unmount();

    renderSurface(fakeClient());
    fireEvent.click(await screen.findByRole("button", { name: "Running now" }));
    expect(await screen.findByText("Nothing running")).toBeInTheDocument();
  });

  it("offers a filter once there are many automations", async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...brief, id: `b${i}`, name: `Brief ${i}` }));
    renderSurface(fakeClient({ list: vi.fn(async () => many) }));
    const filter = await screen.findByRole("searchbox", { name: "Find an automation" });
    fireEvent.change(filter, { target: { value: "brief 3" } });
    const channels = screen.getByRole("list", { name: "Automation channels" });
    expect(within(channels).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Brief 3"]);
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.getByText("No automation matches “zzz”.")).toBeInTheDocument();
  });

  it("says a channel is gone when its automation was deleted elsewhere", async () => {
    let list = [reviewer, brief];
    let notify = () => undefined as void;
    const subscribe = (onChange: () => void) => {
      notify = onChange;
      return () => undefined;
    };
    const client = fakeClient({ list: vi.fn(async () => list) });
    render(<AutomationSurface client={client} subscribe={subscribe} onClose={() => undefined} />);
    await openChannel("Morning brief");
    list = [reviewer];
    notify();
    expect(await screen.findByText("This automation no longer exists.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to automations" }));
    expect(await screen.findByRole("list", { name: "Automations" })).toBeInTheDocument();
  });
});

describe("Narrow hosts", () => {
  /** Makes every observed element report `width`, as a Chat column or a Canvas panel would. */
  function hostWidth(width: number) {
    class Fixed {
      constructor(private readonly cb: ResizeObserverCallback) {}
      observe(el: Element) {
        this.cb([{ target: el, contentRect: { width, height: 800 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", Fixed);
  }
  afterEach(() => vi.unstubAllGlobals());

  it("lays the pane over the feed only while something is open in it", async () => {
    hostWidth(700);
    renderSurface(fakeClient());
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    expect(screen.queryByRole("complementary", { name: "Automation pane" })).toBeNull();
    fireEvent.click(within(list).getAllByRole("option")[0]);
    const pane = await screen.findByRole("complementary", { name: "Automation pane" });
    expect(pane).toHaveAttribute("data-overlay");
    expect(await within(pane).findByRole("article", { name: "initech/orbit-app#42" })).toBeInTheDocument();
    fireEvent.click(within(pane).getByRole("button", { name: "Close pane" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Automation pane" })).toBeNull());
  });

  it("folds the sidebar into a drawer when even the list has no room beside it", async () => {
    hostWidth(500);
    renderSurface(fakeClient());
    await screen.findByRole("heading", { level: 1, name: "Inbox" });
    expect(screen.queryByRole("complementary", { name: "Automations sidebar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show automations sidebar" }));
    const side = await screen.findByRole("complementary", { name: "Automations sidebar" });
    fireEvent.click(within(side).getByRole("button", { name: "All automations" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Automations sidebar" })).toBeNull());
    expect(await screen.findByRole("list", { name: "Automations" })).toBeInTheDocument();
  });
});

describe("Settings pane footer", () => {
  it("says what no setting can change, pauses, and deletes only after a confirmation", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    const foot = screen.getByRole("contentinfo", { name: "Automation controls" });
    expect(within(foot).getByText(/Nothing posts until you press Send/)).toBeInTheDocument();
    fireEvent.click(within(foot).getByRole("button", { name: "Delete…" }));
    expect(client.deleteAutomation).not.toHaveBeenCalled();
    fireEvent.click(within(within(foot).getByRole("alertdialog", { name: "Delete automation" })).getByRole("button", { name: "Cancel" }));
    expect(within(foot).queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("pauses an automation that is on", async () => {
    const client = fakeClient();
    renderSurface(client);
    await openAutomation("Review orbit PRs");
    const foot = screen.getByRole("contentinfo", { name: "Automation controls" });
    fireEvent.click(within(foot).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(client.setEnabled).toHaveBeenCalledWith("a1", false));
  });
});

describe("Right pane, as a Slack thread", () => {
  const pane = () => screen.queryByRole("complementary", { name: "Automation pane" });

  it("starts closed, opens on a row, and closes with its X or Esc", async () => {
    renderSurface(fakeClient());
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    expect(pane()).toBeNull();
    fireEvent.click(within(list).getAllByRole("option")[0]);
    const open = await screen.findByRole("complementary", { name: "Automation pane" });
    expect(within(open).getByRole("heading", { level: 2, name: "Thread" })).toBeInTheDocument();
    expect(within(open).getByText("Inbox")).toBeInTheDocument();
    fireEvent.click(within(open).getByRole("button", { name: "Close pane" }));
    expect(pane()).toBeNull();

    fireEvent.keyDown(within(list).getAllByRole("option")[0], { key: "Enter" });
    expect(await screen.findByRole("complementary", { name: "Automation pane" })).toBeInTheDocument();
    fireEvent.keyDown(within(list).getAllByRole("option")[0], { key: "Escape" });
    await waitFor(() => expect(pane()).toBeNull());
  });

  it("moves the selection with j while closed, without opening the pane", async () => {
    const result: AutomationDraft = {
      ...draft,
      id: "res1",
      automationId: "a2",
      kind: "agent_prompt",
      subject: "Morning brief",
      content: null,
      createdAtMs: draft.createdAtMs + 1000,
      result: { text: "3 PRs.", dm: "off", channel: "C1" },
    };
    renderSurface(fakeClient({ results: vi.fn(async () => [result]) }));
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    fireEvent.keyDown(within(list).getAllByRole("option")[0], { key: "j" });
    expect(within(list).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    expect(pane()).toBeNull();
  });

  it("toggles Settings from the channel header", async () => {
    renderSurface(fakeClient());
    await openChannel("Morning brief");
    expect(pane()).toBeNull();
    const settings = screen.getByRole("button", { name: "Settings" });
    fireEvent.click(settings);
    expect(await screen.findByRole("heading", { level: 2, name: "Settings" })).toBeInTheDocument();
    fireEvent.click(settings);
    await waitFor(() => expect(pane()).toBeNull());
  });
});

describe("Sidebar in the host's rail", () => {
  function railNode() {
    const node = document.createElement("div");
    node.setAttribute("data-testid", "host-rail");
    document.body.appendChild(node);
    return node;
  }
  afterEach(() => document.querySelectorAll('[data-testid="host-rail"]').forEach((n) => n.remove()));

  it("draws its channels in the host's node, without a second title or close button", async () => {
    const node = railNode();
    renderSurface(fakeClient(), { navTarget: node, onOpenConnectors: () => undefined });
    const side = await within(node).findByRole("complementary", { name: "Automations sidebar" });
    expect(within(side).getByRole("button", { name: "Inbox" })).toBeInTheDocument();
    expect(await within(side).findByRole("button", { name: "Review orbit PRs" })).toBeInTheDocument();
    expect(within(side).queryByRole("button", { name: "Close automations" })).toBeNull();
    expect(within(side).getByRole("button", { name: "Connectors" })).toBeInTheDocument();
    expect(screen.queryByRole("separator", { name: "Resize automations sidebar" })).toBeNull();
    fireEvent.click(within(side).getByRole("button", { name: "All automations" }));
    expect(await screen.findByRole("list", { name: "Automations" })).toBeInTheDocument();
  });

  it("draws no sidebar while the host's node is not mounted yet", async () => {
    renderSurface(fakeClient(), { navTarget: null });
    await screen.findByRole("heading", { level: 1, name: "Inbox" });
    expect(screen.queryByRole("complementary", { name: "Automations sidebar" })).toBeNull();
  });

  it("still steps back with Esc from inside the host's rail", async () => {
    const node = railNode();
    renderSurface(fakeClient(), { navTarget: node });
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    fireEvent.click(within(list).getAllByRole("option")[0]);
    await screen.findByRole("complementary", { name: "Automation pane" });
    fireEvent.keyDown(within(node).getByRole("button", { name: "Inbox" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Automation pane" })).toBeNull());
  });
});

describe("AutomationSurface — waiting elsewhere (Factory intake, FI2)", () => {
  it("lists it at the top of Inbox, counts it in the badge, and opens it; even with no automation", async () => {
    const onOpen = vi.fn();
    renderSurface(fakeClient({ list: vi.fn(async () => []) }), {
      waitingElsewhere: [{ id: "factory:r1", source: "Factory", title: "#7 Copy button", line: "Questions for you", onOpen }],
    });
    const list = await screen.findByRole("list", { name: "Waiting elsewhere" });
    expect(list.textContent).toContain("#7 Copy button");
    expect(list.textContent).toContain("Questions for you");
    const side = await screen.findByRole("complementary", { name: "Automations sidebar" });
    // The fake client's one waiting draft, plus this run.
    expect(within(side).getByRole("button", { name: /Inbox/ }).textContent).toBe("Inbox2");
    fireEvent.click(within(list).getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});


describe("Dock variant — the quiet list (.pen 16 v2)", () => {
  const views = () => screen.getByRole("tablist", { name: "Automation views" });

  it("has no sidebar: the tabs are the header, with Inbox counting what waits", async () => {
    renderSurface(fakeClient(), { variant: "dock" });
    const tabs = within(views()).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual(["Inbox", "Automations", "Sent"]);
    await waitFor(() => expect(tabs[0].textContent).toBe("Inbox1"));
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("complementary", { name: "Automations sidebar" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(await screen.findByRole("listbox", { name: "Waiting items" })).toBeInTheDocument();
    // Each number once: no "Waiting for you · 1" heading under the tab that already says it.
    expect(screen.queryByRole("heading", { name: /Waiting for you/ })).toBeNull();
  });

  it("draws each waiting item as a quiet row: source and when, one line, one status", async () => {
    renderSurface(fakeClient(), { variant: "dock" });
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    const row = within(list).getAllByRole("option")[0];
    expect(row).toHaveClass("au-qrow");
    expect(row.querySelector(".au-qrow-source")?.textContent).toMatch(/Review orbit PRs · /);
    expect(row.querySelector(".au-qrow-status")?.textContent).toBeTruthy();
    // No day headings and no tag pills: one status in words.
    expect(within(list).queryByRole("presentation")).toBeNull();
    expect(row.querySelector(".au-triage-tag")).toBeNull();
    fireEvent.click(row);
    expect(await screen.findByRole("complementary", { name: "Automation pane" })).toBeInTheDocument();
  });

  it("shows Running as one live line that opens the steps when pressed", async () => {
    const running = { ...run, id: "r7", status: "running" as const, detail: null, finishedAtMs: null };
    const client = fakeClient({ runs: vi.fn(async () => [running]), runSteps: vi.fn(async () => [{ atMs: 1, text: "Read src/app.ts" }]) });
    renderSurface(client, { variant: "dock" });
    const line = await screen.findByRole("button", { name: /Review orbit PRs/, expanded: false });
    expect(screen.queryByRole("region", { name: "Running now" })).toBeNull();
    fireEvent.click(line);
    const now = await screen.findByRole("region", { name: "Running now" });
    expect(await within(now).findByText("Read src/app.ts")).toBeInTheDocument();
  });

  it("keeps finished work in Sent, not under Inbox", async () => {
    const client = fakeClient({ drafts: vi.fn(async () => []) });
    renderSurface(client, { variant: "dock" });
    await screen.findByRole("tab", { name: "Inbox" });
    expect(screen.queryByText("Nothing finished yet")).toBeNull();
    fireEvent.click(within(views()).getByRole("tab", { name: "Sent" }));
    expect(within(views()).getByRole("tab", { name: "Sent" })).toHaveAttribute("aria-selected", "true");
  });

  it("draws each automation as one line with its switch, and no search for a short list", async () => {
    renderSurface(fakeClient(), { variant: "dock" });
    fireEvent.click(within(views()).getByRole("tab", { name: "Automations" }));
    const list = await screen.findByRole("list", { name: "Automations" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveClass("au-arow");
    expect(rows[0].querySelector(".au-arow-next")?.textContent).toBeTruthy();
    expect(within(rows[0]).getByRole("switch")).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: /Search automations/ })).toBeNull();
    expect(screen.queryByPlaceholderText("Search automations")).toBeNull();
    expect(screen.getByRole("button", { name: "Browse examples" })).toBeInTheDocument();
  });

  it("lists automations under Automations, and a channel steps back to them", async () => {
    renderSurface(fakeClient(), { variant: "dock" });
    fireEvent.click(within(views()).getByRole("tab", { name: "Automations" }));
    const list = await screen.findByRole("list", { name: "Automations" });
    fireEvent.click(await within(list).findByRole("button", { name: "Review orbit PRs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to automations" }));
    expect(await screen.findByRole("list", { name: "Automations" })).toBeInTheDocument();
    expect(within(views()).getByRole("tab", { name: "Automations" })).toHaveAttribute("aria-selected", "true");
  });

  it("reads a review quietly: meta line, one verdict chip, findings as lines, Send names the action", async () => {
    renderSurface(fakeClient(), { variant: "dock" });
    const list = await screen.findByRole("listbox", { name: "Waiting items" });
    fireEvent.click(within(list).getAllByRole("option")[0]);
    const card = await screen.findByRole("article", { name: "initech/orbit-app#42" });
    expect(card).toHaveAttribute("data-quiet", "true");
    expect(card.querySelector(".au-qhead-meta")?.textContent).toMatch(/^initech\/orbit-app#42 · reviewed at abc1234/);
    // The verdict is a chip whose menu holds the choices; no segmented control.
    expect(card.querySelector(".au-segmented")).toBeNull();
    expect(within(card).getByLabelText(/^Verdict: Changes needed/)).toBeInTheDocument();
    expect(within(card).getByText("2 comments")).toBeInTheDocument();
    // Where it goes is one sentence and the caret; the button says what happens.
    expect(card.querySelector(".au-send-to")).toBeNull();
    expect(card.querySelector(".au-qfoot-where")?.textContent).toMatch(/^GitHub comment/);
    expect(within(card).getByRole("button", { name: "Comment on GitHub" })).toBeEnabled();
    const where = within(card).getByLabelText("Where it goes").closest("details")!;
    expect(within(where).getByRole("menuitemcheckbox", { name: /Post on GitHub/ })).toBeInTheDocument();
    expect(within(where).getByText(/No Slack thread/)).toBeInTheDocument();
  });

  it("opens one automation as its own page: what waits first, then facts with Edit, no channel tabs", async () => {
    renderSurface(fakeClient(), { variant: "dock" });
    fireEvent.click(within(views()).getByRole("tab", { name: "Automations" }));
    const list = await screen.findByRole("list", { name: "Automations" });
    fireEvent.click(await within(list).findByRole("button", { name: "Review orbit PRs" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Review orbit PRs" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Channel views" })).toBeNull();
    const waiting = await screen.findByRole("list", { name: "Waiting for you" });
    const row = within(waiting).getByRole("button", { expanded: false });
    fireEvent.click(row);
    expect(await within(waiting).findByRole("article", { name: "initech/orbit-app#42" })).toHaveAttribute("data-quiet", "true");
    const delivered = screen.getByRole("region", { name: "Delivered to" });
    expect(within(delivered).getByText("Inbox, waits for Send")).toBeInTheDocument();
    expect(within(delivered).getAllByRole("button", { name: /^Edit / }).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Runs" })).toBeInTheDocument();
  });

  it("New is one icon menu, the agent first", async () => {
    renderSurface(fakeClient(), { variant: "dock" });
    const items = within(screen.getByRole("menu", { hidden: true })).getAllByRole("menuitem", { hidden: true });
    expect(items[0]).toHaveTextContent("Describe it to an agent");
    expect(items.map((i) => i.textContent)).toEqual(expect.arrayContaining(["Scheduled prompt", "PR review"]));
    fireEvent.click(items[0]);
    // New is its own page in the Dock (16e), not the pane.
    expect(await screen.findByRole("textbox", { name: "Describe an automation" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Automation pane" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Examples" })).getAllByRole("button")).toHaveLength(3);
  });

  it("follows the agent it opens in three steps, and the saved one is the only action", async () => {
    let changed = () => {};
    const subscribe = ((cb: () => void) => {
      changed = cb;
      return () => {};
    }) as unknown as AutomationSurfaceProps["subscribe"];
    const list = vi.fn(async () => [reviewer, brief]);
    const client = fakeClient({ list });
    const host = {
      create: vi.fn(async () => ({ id: "n1", name: "Rex" })),
      show: vi.fn(),
      close: vi.fn(),
      alive: vi.fn(() => true),
    };
    render(<AutomationSurface client={client} subscribe={subscribe} onClose={() => undefined} projects={projects} variant="dock" agentWatch={host} />);
    await screen.findByRole("tab", { name: /Inbox/ });
    fireEvent.click(within(screen.getByRole("menu", { hidden: true })).getAllByRole("menuitem", { hidden: true })[0]);
    const field = await screen.findByRole("textbox", { name: "Describe an automation" });
    fireEvent.change(field, { target: { value: "Every Monday at 08:00, DM me the PRs I owe." } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });

    const steps = await screen.findByRole("list", { name: "Progress" });
    expect(host.create).toHaveBeenCalledWith(expect.stringContaining("Every Monday at 08:00"));
    expect(screen.getByLabelText("Your request")).toHaveTextContent("Sent to Rex");
    expect(within(steps).getByText("Rex is working")).toBeInTheDocument();
    fireEvent.click(within(steps).getByRole("button", { name: "Show on canvas" }));
    expect(host.show).toHaveBeenCalledWith("n1");

    const made = { ...brief, id: "new1", name: "PR reviews I owe", enabled: false };
    list.mockResolvedValue([reviewer, brief, made]);
    changed();
    expect(await within(steps).findByText("PR reviews I owe · saved")).toBeInTheDocument();
    fireEvent.click(within(steps).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(client.setEnabled).toHaveBeenCalledWith("new1", true));
  });

  it("says the agent is asking, and Answer hands it the keyboard", async () => {
    const host = {
      create: vi.fn(async () => ({ id: "n1", name: "Rex" })),
      show: vi.fn(),
      answer: vi.fn(),
      close: vi.fn(),
      alive: vi.fn(() => true),
      asking: vi.fn(() => true),
      kept: { request: "DM me the PRs I owe.", agent: { id: "n1", name: "Rex" }, sentAtMs: Date.now(), before: [reviewer.id, brief.id] },
      keep: vi.fn(),
    };
    renderSurface(fakeClient({ list: vi.fn(async () => [reviewer, brief]) }), { variant: "dock", agentWatch: host });
    // The kept watch survives a closed Dock: the surface opens back on New.
    const steps = await screen.findByRole("list", { name: "Progress" });
    expect(within(steps).getByText("Rex is asking you")).toBeInTheDocument();
    expect(within(steps).queryByRole("button", { name: "Show on canvas" })).toBeNull();
    fireEvent.click(within(steps).getByRole("button", { name: "Answer" }));
    expect(host.answer).toHaveBeenCalledWith("n1");
    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(host.close).toHaveBeenCalledWith("n1");
  });
});
