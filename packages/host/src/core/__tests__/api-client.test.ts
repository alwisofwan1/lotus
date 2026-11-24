import { describe, it, expect, vi } from "vitest";
import { ApiClient, decodeSseLine } from "../api-client.js";

describe("decodeSseLine", () => {
  it("returns null for non-data lines", () => {
    expect(decodeSseLine("")).toBeNull();
    expect(decodeSseLine(": comment")).toBeNull();
    expect(decodeSseLine("event: ping")).toBeNull();
    expect(decodeSseLine("id: 42")).toBeNull();
  });

  it("ignores keep-alive ping payloads", () => {
    expect(decodeSseLine("data: ping")).toBeNull();
  });

  it("decodes a JSON-encoded plain string", () => {
    expect(decodeSseLine('data: "hello"')).toBe("hello");
  });

  it("preserves newlines and CR after JSON decode (the regression we fixed)", () => {
    // Server-side: serde_json::to_string("line1\nline2\r\n") produces this.
    expect(decodeSseLine('data: "line1\\nline2\\r\\n"')).toBe("line1\nline2\r\n");
  });

  it("preserves ANSI escape sequences", () => {
    expect(decodeSseLine('data: "\\u001b[31mred\\u001b[0m"')).toBe(
      "\x1b[31mred\x1b[0m",
    );
  });

  it("falls back to raw string when payload is not valid JSON", () => {
    // Defensive: don't drop the chunk silently if encoding contract is broken.
    expect(decodeSseLine("data: plain-not-json")).toBe("plain-not-json");
  });
});

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ApiClient.listFleet", () => {
  it("sends bearer auth and returns the typed response", async () => {
    const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
      async () =>
        jsonResponse({
          items: [
            {
              paneId: "p-1",
              workspaceId: "ws-a",
              agentType: "claude",
              title: "Lead",
              status: "idle",
              isAlive: true,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 10,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("http://localhost:9877", "test-key");
    const result = await client.listFleet();

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("http://localhost:9877/api/fleet");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.agentType).toBe("claude");

    vi.unstubAllGlobals();
  });

  it("encodes pagination + workspace filter into the query string", async () => {
    const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
      async () => jsonResponse({ items: [], total: 0, page: 2, pageSize: 5 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("http://localhost:9877", "test-key");
    await client.listFleet({ workspaceId: "ws-a", page: 2, pageSize: 5 });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("workspaceId=ws-a");
    expect(url).toContain("page=2");
    expect(url).toContain("pageSize=5");

    vi.unstubAllGlobals();
  });
});

describe("ApiClient.bridgeChat — Remote Session Scope (ADR-0018)", () => {
  it("stamps remoteScoped:true on the request body by default", async () => {
    const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
      async () => jsonResponse({ sessionId: "s1", text: "ok", isError: false, provider: "claude" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("http://localhost:9877", "test-key");
    await client.bridgeChat({ text: "hello" });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ text: "hello", remoteScoped: true });

    vi.unstubAllGlobals();
  });

  it("lets an explicit remoteScoped:false on the request win", async () => {
    const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
      async () => jsonResponse({ sessionId: "s1", text: "ok", isError: false, provider: "claude" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("http://localhost:9877", "test-key");
    await client.bridgeChat({ text: "hi", remoteScoped: false });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body)).remoteScoped).toBe(false);

    vi.unstubAllGlobals();
  });

  it("parses a streamed body with leading whitespace heartbeats", async () => {
    // The route emits bare-newline heartbeats before the final JSON value.
    const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
      async () => new Response('\n\n\n{"sessionId":"s9","text":"done","isError":false,"provider":"claude"}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("http://localhost:9877", "test-key");
    const res = await client.bridgeChat({ text: "hi" });
    expect(res).toEqual({ sessionId: "s9", text: "done", isError: false, provider: "claude" });

    vi.unstubAllGlobals();
  });

  it("maps an error frame to an ApiError carrying its errorStatus", async () => {
    const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
      async () => new Response('\n{"error":"claude: binary not found","errorStatus":503}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("http://localhost:9877", "test-key");
    await expect(client.bridgeChat({ text: "hi" })).rejects.toMatchObject({ name: "ApiError", status: 503 });

    vi.unstubAllGlobals();
  });
});

describe("ApiClient.submitDirectorGoal", () => {
  it("POSTs the goal text to /api/director/goal and returns the accepted envelope", async () => {
    const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
      async () => jsonResponse({ ok: true, accepted: true }, { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("http://localhost:9877", "test-key");
    const result = await client.submitDirectorGoal("ship the feature");

    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("http://localhost:9877/api/director/goal");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ text: "ship the feature" });
    expect(result).toEqual({ ok: true, accepted: true });

    vi.unstubAllGlobals();
  });
});

describe("ApiClient.listProjects", () => {
  it("sends bearer auth and returns the typed response", async () => {
    const projects = [
      { id: "api", name: "API Service", path: "/srv/api" },
      { id: "web", name: "Web Frontend", path: "/srv/web" },
    ];
    const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
      async () => jsonResponse(projects),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("http://localhost:9877", "test-key");
    const result = await client.listProjects();

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("http://localhost:9877/api/projects");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(result).toEqual(projects);

    vi.unstubAllGlobals();
  });

  it("returns empty array when server has no projects", async () => {
    const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
      async () => jsonResponse([]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient("http://localhost:9877", "test-key");
    const result = await client.listProjects();
    expect(result).toEqual([]);

    vi.unstubAllGlobals();
  });
});
