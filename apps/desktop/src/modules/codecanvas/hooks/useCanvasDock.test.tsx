import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearOpenAskRequest, openAskRequest, requestOpenAsk } from "@/modules/automation/services/open-ask-request";
import type { AutomationClient } from "@/modules/automation";
import { createFactoryRunsStore } from "@/modules/factory";
import { requestDockFactoryRun } from "../services/dock-factory-request";
import { openInCode } from "../services/open-in-code";
import { useCanvasDock } from "./useCanvasDock";

const client = { drafts: async () => [], results: async () => [] } as unknown as AutomationClient;
const subscribe = () => () => {};
const factoryStore = createFactoryRunsStore({ listAll: async () => [], onChanged: async () => () => {} } as never);

afterEach(() => clearOpenAskRequest());

describe("useCanvasDock — an Ask followed on the canvas", () => {
  it("opens the Dock on Automation with that Ask", () => {
    const { result } = renderHook(() => useCanvasDock({ automationClient: client, subscribe, factoryStore }));
    act(() => result.current.show("fleet"));
    act(() => result.current.close());

    act(() => requestOpenAsk("ask-1"));
    expect(result.current.open).toBe(true);
    expect(result.current.app).toBe("automation");
    expect(result.current.automation.openAsk?.id).toBe("ask-1");
  });

  it("ignores a request left over from before the canvas mounted", () => {
    requestOpenAsk("stale");
    const { result } = renderHook(() => useCanvasDock({ automationClient: client, subscribe, factoryStore }));
    expect(result.current.open).toBe(false);
    expect(result.current.automation.openAsk).toBeNull();
  });

  it("spends the request once Automation stops showing", () => {
    const { result } = renderHook(() => useCanvasDock({ automationClient: client, subscribe, factoryStore }));
    act(() => requestOpenAsk("ask-2"));
    expect(openAskRequest()?.id).toBe("ask-2");
    act(() => result.current.close());
    expect(openAskRequest()).toBeNull();
  });
});

describe("useCanvasDock — a Factory node's double-click (S3)", () => {
  it("opens the Dock on Factory at that run, and the rail's Factory goes back to the list", () => {
    const { result } = renderHook(() => useCanvasDock({ automationClient: client, subscribe, factoryStore }));
    act(() => requestDockFactoryRun({ repo: "o/r", issue: 6 }));
    expect(result.current.open).toBe(true);
    expect(result.current.app).toBe("factory");
    expect(result.current.factory.focusKey).toBeTruthy();
    act(() => result.current.show("factory"));
    expect(result.current.factory.focusKey).toBeNull();
  });
});

describe("useCanvasDock — the Code app (LOT2-229)", () => {
  beforeEach(() => {
    try {
      globalThis.localStorage?.removeItem("lotus.canvas.dock.wide");
    } catch {
      // storage unavailable: the default is narrow anyway
    }
  });

  it("opens widened by default when the rail shows Code, without remembering that for other apps", () => {
    const { result } = renderHook(() => useCanvasDock({ automationClient: client, subscribe, factoryStore }));
    expect(result.current.wide).toBe(false);
    act(() => result.current.show("code"));
    expect(result.current.app).toBe("code");
    expect(result.current.wide).toBe(true);
    expect(globalThis.localStorage?.getItem("lotus.canvas.dock.wide")).toBeNull();
  });

  it("an open-in-Code request opens the Dock on Code, widened, with that file and line", () => {
    const { result } = renderHook(() => useCanvasDock({ automationClient: client, subscribe, factoryStore }));
    expect(result.current.code.request).toBeNull();
    act(() => openInCode({ path: "/repo/src/a.ts", line: 12 }));
    expect(result.current.open).toBe(true);
    expect(result.current.app).toBe("code");
    expect(result.current.wide).toBe(true);
    expect(result.current.code.request).toMatchObject({ path: "/repo/src/a.ts", line: 12 });
  });

  it("the widened Code does not leak: other apps get the saved width back", () => {
    const { result } = renderHook(() => useCanvasDock({ automationClient: client, subscribe, factoryStore }));
    act(() => result.current.show("code"));
    expect(result.current.wide).toBe(true);
    act(() => result.current.show("tasks"));
    expect(result.current.wide).toBe(false);
    act(() => result.current.show("code"));
    expect(result.current.wide).toBe(true);
    act(() => result.current.close());
    act(() => result.current.show("automation"));
    expect(result.current.wide).toBe(false);
  });

  it("the user's own widen press is the only thing that saves a width", () => {
    const { result } = renderHook(() => useCanvasDock({ automationClient: client, subscribe, factoryStore }));
    act(() => result.current.show("code"));
    act(() => result.current.toggleWide());
    expect(result.current.wide).toBe(false);
    act(() => result.current.show("tasks"));
    act(() => result.current.toggleWide());
    expect(result.current.wide).toBe(true);
    expect(globalThis.localStorage?.getItem("lotus.canvas.dock.wide")).toBe("1");
  });

  it("an open-in-Code request is spent once Code stops showing, so a later visit does not replay it", () => {
    const { result } = renderHook(() => useCanvasDock({ automationClient: client, subscribe, factoryStore }));
    act(() => openInCode({ path: "/repo/a.ts" }));
    expect(result.current.code.request).not.toBeNull();
    act(() => result.current.show("tasks"));
    expect(result.current.code.request).toBeNull();
    act(() => result.current.show("code"));
    expect(result.current.code.request).toBeNull();
    act(() => openInCode({ path: "/repo/a.ts" }));
    act(() => result.current.close());
    act(() => result.current.toggle());
    expect(result.current.code.request).toBeNull();
  });

  it("a second request for the same file is a new request", () => {
    const { result } = renderHook(() => useCanvasDock({ automationClient: client, subscribe, factoryStore }));
    act(() => openInCode({ path: "/repo/a.ts" }));
    const first = result.current.code.request?.seq;
    act(() => openInCode({ path: "/repo/a.ts" }));
    expect(result.current.code.request?.seq).not.toBe(first);
  });
});

describe("useCanvasDock — the Dock apps' asks for the one Needs-you queue (S5)", () => {
  it("lists each waiting Automation row, and opening one opens the Dock's Inbox on it", async () => {
    const draft = { id: "d1", runId: "r", automationId: "a", kind: "pr_review", subject: "PR #7 Fix login", status: "pending", content: null, slack: null, result: null, sentUrl: null, createdAtMs: 5 };
    const waiting = { drafts: async () => [draft], results: async () => [] } as unknown as AutomationClient;
    const { result } = renderHook(() => useCanvasDock({ automationClient: waiting, subscribe, factoryStore }));
    await waitFor(() => expect(result.current.asks).toHaveLength(1));
    expect(result.current.asks[0]).toMatchObject({ id: "automation:d1", source: "automation", name: "PR #7 Fix login", line: "Review ready to send", askedAtMs: 5 });
    act(() => result.current.asks[0].onOpen());
    expect(result.current.open).toBe(true);
    expect(result.current.app).toBe("automation");
    expect(result.current.automation.openAsk?.id).toBe("d1");
  });
});
