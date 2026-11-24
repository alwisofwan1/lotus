import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConnectorsSurface } from "../ConnectorsSurface";
import { describeHealth } from "@/modules/tasks/services/source-health";
import type {
  AutomationUse,
  ConnectorsClient,
  GoogleStatus,
  NotionStatus,
  SlackEmojiView,
  SlackReactionsView,
  SlackStatus,
  StatusReactions,
} from "../../services/connectors-api";

const notSetUp: SlackStatus = { state: "not_set_up", detail: null, userId: null, team: null };
const connected: SlackStatus = { state: "connected", detail: null, userId: "U0REVIEWER1", team: "Initech" };
const defaultReactions: StatusReactions = {
  taken: "eyes",
  queued: "hourglass_flowing_sand",
  running: "",
  done: "",
  failed: "",
  asked: "",
  skipped: "black_right_pointing_double_triangle_with_vertical_bar",
  sent: { looksGood: [], questions: [], changesNeeded: [] },
};
const reactionsView: SlackReactionsView = { reactions: defaultReactions, defaults: defaultReactions, lastError: null };
const emojiView: SlackEmojiView = {
  state: "ok",
  emoji: [{ name: "shipit", url: "https://emoji.slack-edge.com/T1/shipit/a.png", aliasOf: null }],
};
const googleOff: GoogleStatus = { state: "not_connected", email: null, scopes: [], connectedAtMs: null, detail: null };
const googleOn: GoogleStatus = {
  state: "connected",
  email: "you@company.com",
  scopes: ["openid", "https://www.googleapis.com/auth/drive.file"],
  connectedAtMs: Date.UTC(2026, 8, 28, 4, 40),
  detail: null,
};

const notionOff: NotionStatus = { state: "not_connected", kind: null, name: null, email: null, workspace: null, connectedAtMs: null };
const notionOn: NotionStatus = {
  state: "connected",
  kind: "personal",
  name: "Alwi",
  email: "alwi@company.com",
  workspace: null,
  connectedAtMs: Date.UTC(2026, 8, 28, 11, 0),
};

const uses: AutomationUse[] = [
  { id: "a1", name: "Orbit reviews", enabled: true, triggerKind: "slack", actionKind: "pr_review", config: { account: "alwisofwan1" }, prompt: null },
  {
    id: "a2",
    name: "Morning brief",
    enabled: false,
    triggerKind: "schedule",
    actionKind: "agent_prompt",
    config: null,
    prompt: { dmSelf: false, slackChannel: null, account: "alwisofwan1" },
  },
];

function fakeClient(overrides: Partial<ConnectorsClient> = {}): ConnectorsClient {
  return {
    slackStatus: vi.fn(async () => notSetUp),
    slackConnect: vi.fn(async () => connected),
    slackDisconnect: vi.fn(async () => undefined),
    slackCheckNow: vi.fn(async () => connected),
    slackManifest: vi.fn(async () => "display_information: {}"),
    slackSetBotToken: vi.fn(async () => ({ ...connected, bot: true })),
    slackTestBot: vi.fn(async () => undefined),
    slackReactions: vi.fn(async () => reactionsView),
    slackSetReactions: vi.fn(async (reactions: StatusReactions) => ({ ...reactionsView, reactions })),
    slackEmoji: vi.fn(async () => emojiView),
    ghAccounts: vi.fn(async () => [
      { login: "alwisofwan1", active: true },
      { login: "masjidubk13", active: false },
    ]),
    googleStatus: vi.fn(async () => googleOff),
    googleConnect: vi.fn(async () => googleOn),
    googleCancelConnect: vi.fn(async () => undefined),
    googleDisconnect: vi.fn(async () => undefined),
    notionStatus: vi.fn(async () => notionOff),
    notionConnect: vi.fn(async () => notionOn),
    notionDisconnect: vi.fn(async () => undefined),
    automations: vi.fn(async () => uses),
    ...overrides,
  };
}

const noSubscribe = () => () => undefined;

function renderSurface(client: ConnectorsClient, onOpenAutomation?: (id: string) => void) {
  render(
    <ConnectorsSurface client={client} subscribe={noSubscribe} onClose={() => undefined} onOpenAutomation={onOpenAutomation} />,
  );
}

async function open(name: "Slack" | "GitHub" | "Google" | "Notion") {
  const row = await screen.findByRole("listitem", { name });
  fireEvent.click(within(row).getByRole("button", { name }));
  return screen.findByRole("heading", { level: 1, name });
}

/** Shows one tab of a connector page and returns its panel. */
function showTab(name: "Overview" | "Status reactions" | "Alerts") {
  fireEvent.click(screen.getByRole("tab", { name }));
  return screen.getByRole("tabpanel", { name });
}

async function openReactions() {
  await open("Slack");
  showTab("Status reactions");
  return screen.findByRole("form", { name: "Status reactions" });
}

/** The row of one reaction, so an emoji the preview also shows is not found twice. */
function reactionRow(section: HTMLElement, label: RegExp) {
  return within(section).getByLabelText(label).closest("li") as HTMLElement;
}

describe("Connectors", () => {
  it("lists each connector with its state and how many automations lean on it", async () => {
    renderSurface(fakeClient());
    const slack = await screen.findByRole("listitem", { name: "Slack" });
    expect(within(slack).getByText("Not connected")).toBeInTheDocument();
    expect(within(slack).getByText(/Used by 1 automation$/)).toBeInTheDocument();
    const github = screen.getByRole("listitem", { name: "GitHub" });
    expect(within(github).getByText("alwisofwan1 and 1 more via gh")).toBeInTheDocument();
    expect(within(github).getByText(/Used by 2 automations/)).toBeInTheDocument();
  });

  it("connects Slack with the two tokens typed into hidden fields", async () => {
    const client = fakeClient();
    renderSurface(client);
    await open("Slack");
    const appToken = screen.getByLabelText("App-level token");
    const userToken = screen.getByLabelText("User OAuth token");
    expect(appToken).toHaveAttribute("type", "password");
    expect(userToken).toHaveAttribute("type", "password");
    fireEvent.change(appToken, { target: { value: "xapp-1-A" } });
    fireEvent.change(userToken, { target: { value: "xoxp-1-B" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(client.slackConnect).toHaveBeenCalledWith("xapp-1-A", "xoxp-1-B"));
  });

  it("shows who Slack acts as, and disconnects only after confirming", async () => {
    const client = fakeClient({ slackStatus: vi.fn(async () => connected) });
    renderSurface(client);
    await open("Slack");
    expect(screen.getByText("Connected to Initech")).toBeInTheDocument();
    expect(screen.getByText("U0REVIEWER1")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Slack actions"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    expect(client.slackDisconnect).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Disconnect Slack" })).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(client.slackDisconnect).toHaveBeenCalled());
  });

  it("explains the reinstall step for Factory alerts and saves the bot token", async () => {
    const client = fakeClient({ slackStatus: vi.fn(async () => connected) });
    renderSurface(client);
    await open("Slack");
    showTab("Alerts");
    const alerts = screen.getByRole("region", { name: "Factory alerts" });
    expect(within(alerts).getByText("macOS only")).toBeInTheDocument();
    expect(within(alerts).getByText(/Install App, Reinstall to Workspace/)).toBeInTheDocument();
    const bot = within(alerts).getByLabelText("Bot User OAuth token");
    expect(bot).toHaveAttribute("type", "password");
    fireEvent.change(bot, { target: { value: "xoxb-1-C" } });
    fireEvent.click(within(alerts).getByRole("button", { name: "Save bot token" }));
    await waitFor(() => expect(client.slackSetBotToken).toHaveBeenCalledWith("xoxb-1-C"));
  });

  it("with the bot saved, alerts DM you and a test DM can be sent", async () => {
    const client = fakeClient({ slackStatus: vi.fn(async () => ({ ...connected, bot: true })) });
    renderSurface(client);
    await open("Slack");
    showTab("Alerts");
    const alerts = screen.getByRole("region", { name: "Factory alerts" });
    expect(within(alerts).getByText("macOS + Slack DM")).toBeInTheDocument();
    expect(within(alerts).queryByLabelText("Bot User OAuth token")).not.toBeInTheDocument();
    fireEvent.click(within(alerts).getByRole("button", { name: "Send a test DM" }));
    await waitFor(() => expect(client.slackTestBot).toHaveBeenCalled());
    expect(await within(alerts).findByText(/Sent\. Check that your phone pinged/)).toBeInTheDocument();
  });

  it("shows the status reactions in use, and saves a changed one", async () => {
    const client = fakeClient({ slackStatus: vi.fn(async () => connected) });
    renderSurface(client);
    const section = await openReactions();
    expect(within(section).getByLabelText(/^Taken in hand/)).toHaveValue("eyes");
    expect(within(section).getByLabelText(/^Done/)).toHaveValue("");
    // Nothing to save yet, so there is no save bar.
    expect(within(section).queryByRole("button", { name: "Save reactions" })).toBeNull();

    fireEvent.change(within(section).getByLabelText(/^Done/), { target: { value: "white_check_mark" } });
    expect(await within(reactionRow(section, /^Done/)).findByText("✅")).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "Save reactions" }));
    await waitFor(() =>
      expect(client.slackSetReactions).toHaveBeenCalledWith({ ...defaultReactions, done: "white_check_mark" }),
    );
    expect(await within(section).findByText(/The next review request uses them/)).toBeInTheDocument();
  });

  it("sets several emoji for a sent verdict, typed or picked, and saves them as a list", async () => {
    const client = fakeClient({ slackStatus: vi.fn(async () => connected) });
    renderSurface(client);
    const section = await openReactions();
    const changes = within(section).getByLabelText(/^Changes needed/);
    expect(changes).toHaveValue("");

    fireEvent.change(changes, { target: { value: "eyes " } });
    expect(changes).toHaveValue("eyes ");
    fireEvent.click(within(section).getByRole("button", { name: "Choose emoji for Changes needed" }));
    const search = within(section).getByRole("combobox", { name: "Search emoji" });
    fireEvent.change(search, { target: { value: "shipit" } });
    fireEvent.click(within(section).getByRole("option", { name: "shipit" }));
    expect(changes).toHaveValue("eyes shipit");

    fireEvent.change(within(section).getByLabelText(/^Looks good/), { target: { value: "white_check_mark" } });
    fireEvent.click(within(section).getByRole("button", { name: "Save reactions" }));
    await waitFor(() =>
      expect(client.slackSetReactions).toHaveBeenCalledWith({
        ...defaultReactions,
        sent: { looksGood: ["white_check_mark"], questions: [], changesNeeded: ["eyes", "shipit"] },
      }),
    );
  });

  it("picks an emoji by search, with the workspace's own emoji and their images", async () => {
    const client = fakeClient({ slackStatus: vi.fn(async () => connected) });
    renderSurface(client);
    const section = await openReactions();

    fireEvent.click(within(section).getByRole("button", { name: "Choose emoji for Done" }));
    const search = within(section).getByRole("combobox", { name: "Search emoji" });
    expect(search).toHaveFocus();
    expect(await within(section).findByRole("group", { name: "Workspace" })).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "shipit" } });
    const custom = within(section).getByRole("option", { name: "shipit" });
    expect(custom.querySelector("img")).toHaveAttribute("src", "https://emoji.slack-edge.com/T1/shipit/a.png");

    fireEvent.change(search, { target: { value: "white_check" } });
    fireEvent.keyDown(search, { key: "ArrowRight" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(within(section).getByLabelText(/^Done/)).toHaveValue("white_check_mark");
    expect(within(section).queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.click(within(section).getByRole("button", { name: "Save reactions" }));
    await waitFor(() =>
      expect(client.slackSetReactions).toHaveBeenCalledWith({ ...defaultReactions, done: "white_check_mark" }),
    );
  });

  it("closes the picker on Escape and shows a custom emoji's image as the preview", async () => {
    renderSurface(fakeClient({ slackStatus: vi.fn(async () => connected) }));
    const section = await openReactions();
    fireEvent.change(within(section).getByLabelText(/^Done/), { target: { value: "shipit" } });
    await waitFor(() => expect(section.querySelector(".cn-reaction-preview img")).not.toBeNull());

    fireEvent.click(within(section).getByRole("button", { name: "Choose emoji for Done" }));
    fireEvent.keyDown(within(section).getByRole("combobox", { name: "Search emoji" }), { key: "Escape" });
    expect(within(section).queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("warns, without blocking, about a name that is neither standard nor the workspace's", async () => {
    renderSurface(fakeClient({ slackStatus: vi.fn(async () => connected) }));
    const section = await openReactions();
    fireEvent.change(within(section).getByLabelText(/^Done/), { target: { value: "no_such_emoji_xyz" } });
    expect(await within(section).findByText(/Slack will probably refuse it/)).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Save reactions" })).toBeEnabled();
    fireEvent.change(within(section).getByLabelText(/^Done/), { target: { value: "shipit" } });
    expect(within(section).queryByText(/Slack will probably refuse it/)).not.toBeInTheDocument();
  });

  it("tells you to reconnect Slack when the app lacks emoji:read, and still lists standard emoji", async () => {
    const client = fakeClient({
      slackStatus: vi.fn(async () => connected),
      slackEmoji: vi.fn(async () => ({ state: "missing_scope" as const, emoji: [] })),
    });
    renderSurface(client);
    const section = await openReactions();
    fireEvent.click(within(section).getByRole("button", { name: "Choose emoji for Done" }));
    expect(await within(section).findByText(/Reconnect Slack to allow emoji:read/)).toBeInTheDocument();
    expect(await within(section).findByRole("option", { name: "eyes" })).toBeInTheDocument();
    fireEvent.change(within(section).getByLabelText(/^Done/), { target: { value: "anything_custom" } });
    expect(within(section).queryByText(/Slack will probably refuse it/)).not.toBeInTheDocument();
  });

  it("shows why Slack or Lotus refused a reaction", async () => {
    const client = fakeClient({
      slackStatus: vi.fn(async () => connected),
      slackReactions: vi.fn(async () => ({ ...reactionsView, lastError: "Slack does not know :tada2:." })),
      slackSetReactions: vi.fn(async () => {
        throw new Error("Each state needs its own emoji.");
      }),
    });
    renderSurface(client);
    const section = await openReactions();
    expect(within(section).getByText("Slack does not know :tada2:.")).toBeInTheDocument();
    fireEvent.change(within(section).getByLabelText(/^Running/), { target: { value: "eyes" } });
    fireEvent.click(within(section).getByRole("button", { name: "Save reactions" }));
    expect(await within(section).findByText(/Each state needs its own emoji/)).toBeInTheDocument();
  });

  it("puts the default reactions back with one button", async () => {
    const custom = { ...defaultReactions, taken: "mag" };
    const client = fakeClient({
      slackStatus: vi.fn(async () => connected),
      slackReactions: vi.fn(async () => ({ ...reactionsView, reactions: custom })),
    });
    renderSurface(client);
    const section = await openReactions();
    expect(within(section).getByLabelText(/^Taken in hand/)).toHaveValue("mag");
    fireEvent.click(within(section).getByRole("button", { name: "Use the defaults" }));
    expect(within(section).getByLabelText(/^Taken in hand/)).toHaveValue("eyes");
    expect(within(section).getByRole("button", { name: "Save reactions" })).toBeEnabled();
  });

  it("warns when Slack messages reach Lotus only through the periodic catch-up", async () => {
    const detail = "2 message(s) did not arrive live; the 5-minute check picked them up.";
    renderSurface(fakeClient({ slackStatus: vi.fn(async () => ({ ...connected, detail })) }));
    const slack = await screen.findByRole("listitem", { name: "Slack" });
    expect(within(slack).getByText("Connected to Initech · missing live events")).toBeInTheDocument();
    await open("Slack");
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it("shows when Slack was last read for missed messages, and checks again on request", async () => {
    const listening: SlackStatus = { ...connected, checkEveryMs: 300_000, checkedAtMs: Date.now() - 2 * 60_000 };
    const client = fakeClient({
      slackStatus: vi.fn(async () => listening),
      slackCheckNow: vi.fn(async () => ({ ...listening, checkedAtMs: Date.now() })),
    });
    renderSurface(client);
    await open("Slack");
    expect(screen.getByText("Every 5 min · last checked 2 min ago")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Nothing missed. Every request so far arrived live.")).toBeInTheDocument();
    expect(client.slackCheckNow).toHaveBeenCalledTimes(1);
  });

  it("explains a check that could not run", async () => {
    const listening: SlackStatus = { ...connected, checkEveryMs: 300_000, checkedAtMs: null };
    const client = fakeClient({
      slackStatus: vi.fn(async () => listening),
      slackCheckNow: vi.fn(async () => Promise.reject("Slack is reconnecting")),
    });
    renderSurface(client);
    await open("Slack");
    expect(screen.getByText("Every 5 min · runs once connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Slack is reconnecting")).toBeInTheDocument();
  });

  it("says a dev build is not listening, and why", async () => {
    const detail = "Not listening in this dev build, so the installed Lotus gets every Slack event.";
    renderSurface(fakeClient({ slackStatus: vi.fn(async () => ({ ...connected, state: "standby", detail })) }));
    const slack = await screen.findByRole("listitem", { name: "Slack" });
    expect(within(slack).getByText("Initech · not listening in dev")).toBeInTheDocument();
    await open("Slack");
    expect(screen.getByText(detail)).toBeInTheDocument();
  });

  it("lists gh's accounts and how to add one; never asks for a GitHub token", async () => {
    renderSurface(fakeClient());
    await open("GitHub");
    const accounts = screen.getByRole("list", { name: "GitHub accounts" });
    expect(within(accounts).getByRole("listitem", { name: "alwisofwan1" })).toHaveTextContent("Active in gh");
    expect(screen.getByText("gh auth login")).toBeInTheDocument();
    expect(screen.queryByLabelText(/token/i)).toBeNull();
  });

  it("names the automations that use a connector", async () => {
    renderSurface(fakeClient());
    await open("Slack");
    const usedBy = screen.getByRole("list", { name: "Automations using this connector" });
    expect(within(usedBy).getAllByRole("listitem").map((r) => r.getAttribute("aria-label"))).toEqual(["Orbit reviews"]);
    // An icon fills the row's leading slot, so the name is not squeezed into it.
    expect(within(usedBy).getByRole("listitem").querySelector(".rs-row-leading svg")).not.toBeNull();
  });

  it("opens an automation from its Used by row", async () => {
    const onOpenAutomation = vi.fn();
    renderSurface(fakeClient({ slackStatus: vi.fn(async () => connected) }), onOpenAutomation);
    await open("Slack");
    const usedBy = await screen.findByRole("list", { name: "Automations using this connector" });
    fireEvent.click(within(usedBy).getByRole("button", { name: "Orbit reviews" }));
    expect(onOpenAutomation).toHaveBeenCalledWith("a1");
  });

  it("splits a connected Slack into Overview, Status reactions and Alerts", async () => {
    renderSurface(fakeClient({ slackStatus: vi.fn(async () => connected) }));
    await open("Slack");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    const glance = screen.getByRole("group", { name: "Slack at a glance" });
    expect(within(glance).getByText("1 automation")).toBeInTheDocument();
    expect(within(glance).getByText("1 on, 0 off")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Status reactions" })).toBeNull();
    showTab("Alerts");
    expect(screen.getByRole("tab", { name: "Alerts" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("group", { name: "Slack at a glance" })).toBeNull();
  });

  it("counts unsaved reactions in a save bar, and Discard puts them back", async () => {
    const client = fakeClient({ slackStatus: vi.fn(async () => connected) });
    renderSurface(client);
    const section = await openReactions();
    fireEvent.change(within(section).getByLabelText(/^Done/), { target: { value: "white_check_mark" } });
    fireEvent.change(within(section).getByLabelText(/^Looks good/), { target: { value: "tada" } });
    const bar = within(section).getByRole("region", { name: "Unsaved reactions" });
    expect(within(bar).getByText("2 unsaved changes")).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole("button", { name: "Discard" }));
    expect(within(section).getByLabelText(/^Done/)).toHaveValue("");
    expect(within(section).queryByRole("region", { name: "Unsaved reactions" })).toBeNull();
    expect(client.slackSetReactions).not.toHaveBeenCalled();
  });

  it("keeps an unsaved reaction while another tab is open", async () => {
    renderSurface(fakeClient({ slackStatus: vi.fn(async () => connected) }));
    const section = await openReactions();
    fireEvent.change(within(section).getByLabelText(/^Done/), { target: { value: "white_check_mark" } });
    showTab("Overview");
    const again = showTab("Status reactions");
    expect(within(again).getByLabelText(/^Done/)).toHaveValue("white_check_mark");
    expect(within(again).getByText("1 unsaved change")).toBeInTheDocument();
  });

  it("previews the reactions a request shows at the chosen state", async () => {
    renderSurface(fakeClient({ slackStatus: vi.fn(async () => connected) }));
    const section = await openReactions();
    const preview = within(section).getByRole("group", { name: "Preview in Slack" });
    const chips = () => preview.querySelector(".cn-preview-chips") as HTMLElement;
    fireEvent.click(within(preview).getByRole("radio", { name: "Waiting" }));
    expect(within(chips()).getByText("👀")).toBeInTheDocument();
    expect(within(chips()).getByText("⏳")).toBeInTheDocument();
    fireEvent.change(within(section).getByLabelText(/^Taken in hand/), { target: { value: "" } });
    fireEvent.click(within(preview).getByRole("radio", { name: "Taken" }));
    expect(within(chips()).getByText("No reaction")).toBeInTheDocument();
  });

  it("lists Google as not connected until the user signs in", async () => {
    renderSurface(fakeClient());
    const google = await screen.findByRole("listitem", { name: "Google" });
    expect(within(google).getByText("Not connected")).toBeInTheDocument();
    expect(within(google).getByText(/Only files Lotus makes or you pick/)).toBeInTheDocument();
  });

  it("connects Google with one button, shows the wait for the browser, and can cancel it", async () => {
    let finish: (s: GoogleStatus) => void = () => undefined;
    const client = fakeClient({
      googleConnect: vi.fn(() => new Promise<GoogleStatus>((resolve) => (finish = resolve))),
    });
    renderSurface(client);
    await open("Google");
    expect(screen.queryByLabelText(/token|secret/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect with Google" }));
    expect(client.googleConnect).toHaveBeenCalledTimes(1);
    const waiting = await screen.findByRole("status");
    expect(waiting).toHaveTextContent("Waiting for your browser…");
    fireEvent.click(within(waiting).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(client.googleCancelConnect).toHaveBeenCalled());
    finish(googleOn);
  });

  it("does not show a cancelled sign-in as an error", async () => {
    const cancelled = fakeClient({ googleConnect: vi.fn(async () => Promise.reject(new Error("Google sign-in was cancelled"))) });
    renderSurface(cancelled);
    await open("Google");
    fireEvent.click(screen.getByRole("button", { name: "Connect with Google" }));
    await screen.findByRole("button", { name: "Connect with Google" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the Google failure the sign-in gave", async () => {
    const failing = fakeClient({
      googleConnect: vi.fn(async () => Promise.reject(new Error("Google did not give Drive access; connect again"))),
    });
    renderSurface(failing);
    await open("Google");
    fireEvent.click(screen.getByRole("button", { name: "Connect with Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Google did not give Drive access");
  });

  it("shows which Google account is connected, and disconnects only after confirming", async () => {
    const client = fakeClient({ googleStatus: vi.fn(async () => googleOn) });
    renderSurface(client);
    const row = await screen.findByRole("listitem", { name: "Google" });
    expect(within(row).getByText("Connected as you@company.com")).toBeInTheDocument();
    await open("Google");
    expect(screen.getByText("you@company.com")).toBeInTheDocument();
    expect(screen.getByText("Only files Lotus made or you picked")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(client.googleDisconnect).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Disconnect Google" })).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(client.googleDisconnect).toHaveBeenCalled());
  });

  it("says why Google cannot connect in a build without a client", async () => {
    const detail = "this build has no Google client; put the Desktop client JSON at ~/.lotus/google-oauth-client.json";
    renderSurface(fakeClient({ googleStatus: vi.fn(async () => ({ ...googleOff, state: "unavailable", detail })) }));
    await open("Google");
    expect(screen.getByText("Not available in this build", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect with Google" })).toBeNull();
  });

  it("goes back to the list from the breadcrumb", async () => {
    renderSurface(fakeClient());
    await open("GitHub");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Connectors" }));
    expect(await screen.findByRole("list", { name: "Connectors" })).toBeInTheDocument();
  });
});

describe("Notion", () => {
  it("is listed as not connected until a token is pasted", async () => {
    renderSurface(fakeClient());
    const row = await screen.findByRole("listitem", { name: "Notion" });
    expect(within(row).getByText("Not connected")).toBeInTheDocument();
  });

  it("connects with a token typed into a hidden field, and never keeps it on screen", async () => {
    const client = fakeClient();
    renderSurface(client);
    await open("Notion");
    const field = screen.getByLabelText("Token") as HTMLInputElement;
    expect(field.type).toBe("password");
    const connect = screen.getByRole("button", { name: "Connect" });
    expect(connect).toBeDisabled();

    fireEvent.change(field, { target: { value: "  ntn_abc123  " } });
    fireEvent.click(connect);

    await waitFor(() => expect(client.notionConnect).toHaveBeenCalledWith("  ntn_abc123  "));
    await waitFor(() => expect(field.value).toBe(""));
  });

  it("shows Notion's reason when the token is refused", async () => {
    const reason = "Notion did not accept this token: it is wrong, expired or revoked. Make a new one and connect again";
    renderSurface(fakeClient({ notionConnect: vi.fn(async () => Promise.reject(reason)) }));
    await open("Notion");
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "ntn_x" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(reason);
  });

  it("shows who a personal token acts as, and disconnects only after confirming", async () => {
    const client = fakeClient({ notionStatus: vi.fn(async () => notionOn) });
    renderSurface(client);
    const row = await screen.findByRole("listitem", { name: "Notion" });
    expect(within(row).getByText("Connected as alwi@company.com")).toBeInTheDocument();
    await open("Notion");
    expect(screen.getByText("Personal access token")).toBeInTheDocument();
    expect(screen.getByText("alwi@company.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(client.notionDisconnect).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Disconnect Notion" })).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(client.notionDisconnect).toHaveBeenCalled());
  });

  it("names the workspace of an integration token, and says pages must be shared with it", async () => {
    const integration: NotionStatus = { ...notionOn, kind: "integration", email: null, name: "Lotus", workspace: "Initech" };
    renderSurface(fakeClient({ notionStatus: vi.fn(async () => integration) }));
    const row = await screen.findByRole("listitem", { name: "Notion" });
    expect(within(row).getByText("Connected as Initech")).toBeInTheDocument();
    await open("Notion");
    expect(screen.getByText("Integration token — pages must be shared with it")).toBeInTheDocument();
  });

  it("lists each Notion ticket source in the same words as the Tasks nav row (SOURCES 06)", async () => {
    const at = new Date(2026, 8, 29, 13, 40).getTime();
    const health = describeHealth({ label: "Notion", name: "Orbit board", health: { state: "lost_access", why: "unshared" }, syncing: false, syncedAtMs: at, nowMs: at });
    render(
      <ConnectorsSurface
        client={fakeClient({ notionStatus: vi.fn(async () => notionOn) })}
        subscribe={noSubscribe}
        onClose={() => undefined}
        notionSources={[{ id: "notion-abc", name: "Orbit board", health }]}
      />,
    );
    await open("Notion");
    const source = within(screen.getByRole("listitem", { name: "Orbit board" }));
    expect(source.getByText("Notion · no access")).toBeInTheDocument();
    expect(source.getByText("Lotus can no longer see Orbit board. It was unshared or moved to trash.")).toBeInTheDocument();
  });

  it("says the token never reaches an agent", async () => {
    renderSurface(fakeClient());
    await open("Notion");
    expect(screen.getByText(/This token never reaches an agent/)).toBeInTheDocument();
  });
});
