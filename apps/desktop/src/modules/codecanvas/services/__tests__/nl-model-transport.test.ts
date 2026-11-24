import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createNlModelCaller, isCliAuthError } from "../nl-model-transport";
import type { AgentRunner, AgentStartOptions } from "@/lib/tauri/canvas-agent";

/** Fake CLI runner: captures onLine so tests can emit stream-json lines. */
function fakeRunner() {
  let onLine: ((line: string) => void) | null = null;
  const runner: AgentRunner = {
    start: vi.fn(async (opts: AgentStartOptions) => {
      onLine = opts.onLine;
      return "run-1";
    }),
    stop: vi.fn(async () => {}),
  };
  return {
    runner,
    emitResult(ok: boolean, text: string) {
      onLine?.(JSON.stringify({ type: "result", is_error: !ok, result: text }));
    },
    /** One `assistant` message carrying text — how the answer actually arrives, long before `result`. */
    emitText(text: string, id = "msg-1") {
      onLine?.(JSON.stringify({ type: "assistant", message: { id, content: [{ type: "text", text }] } }));
    },
    /** The extended-thinking block that precedes the answer; carries no text. */
    emitThinking(id = "msg-1") {
      onLine?.(JSON.stringify({ type: "assistant", message: { id, content: [{ type: "thinking", thinking: "…" }] } }));
    },
  };
}

describe("createNlModelCaller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the HTTP result without ever touching the CLI runner", async () => {
    const { runner } = fakeRunner();
    const caller = createNlModelCaller({
      nlComplete: vi.fn(async () => "http says hi"),
      runner,
      cwd: "/repo",
    });

    await expect(caller.call("parse this")).resolves.toBe("http says hi");
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("uses direct HTTP even when CLI fallback is disabled", async () => {
    const { runner } = fakeRunner();
    const caller = createNlModelCaller({
      nlComplete: vi.fn(async () => "openai direct result"),
      runner,
      cwd: "/repo",
    });

    await expect(caller.call("parse this", undefined, { allowCliFallback: false })).resolves.toBe("openai direct result");
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("does not spawn the CLI when fallback is disabled for latency-sensitive voice calls", async () => {
    const fake = fakeRunner();
    const notices: string[] = [];
    const caller = createNlModelCaller({
      nlComplete: vi.fn(async () => {
        throw new Error("nl_complete[no_key]: no BYOK NL model configured");
      }),
      runner: fake.runner,
      cwd: "/repo",
      onNotice: (n) => notices.push(n.kind),
    });

    await expect(caller.call("parse this", undefined, { allowCliFallback: false })).rejects.toThrow(/model is not configured/i);
    expect(fake.runner.start).not.toHaveBeenCalled();
    expect(notices).toEqual(["cli-fallback"]);
  });

  it("falls back to the CLI when HTTP rejects (no key) and reports the degradation", async () => {
    const fake = fakeRunner();
    const notices: string[] = [];
    const caller = createNlModelCaller({
      nlComplete: vi.fn(async () => {
        throw new Error("nl_complete[no_key]: no BYOK NL model configured");
      }),
      runner: fake.runner,
      cwd: "/repo",
      onNotice: (n) => notices.push(n.kind),
    });

    const pending = caller.call("parse this");
    await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));
    fake.emitResult(true, "cli says hi");

    await expect(pending).resolves.toBe("cli says hi");
    expect(notices).toEqual(["cli-fallback"]);
    // The CLI leg inherits the caller's cwd + fast model.
    const opts = (fake.runner.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(opts.cwd).toBe("/repo");
    expect(opts.model).toBe("claude-haiku-4-5");
    expect(opts.skipPermissions).toBe(true);
  });

  it("classifies a rejected BYOK key as an auth notice and stops there — no second provider", async () => {
    const fake = fakeRunner();
    const notices: Array<{ kind: string; detail: string }> = [];
    const caller = createNlModelCaller({
      nlComplete: vi.fn(async () => {
        throw new Error("nl_complete[auth]: HTTP 401");
      }),
      runner: fake.runner,
      cwd: "/repo",
      onNotice: (n) => notices.push(n),
    });

    await expect(caller.call("parse this")).rejects.toThrow(/key was rejected/i);
    // BYOK is configured (the key merely doesn't work), so the prompt must not be re-sent elsewhere.
    expect(fake.runner.start).not.toHaveBeenCalled();
    expect(notices.map((n) => n.kind)).toEqual(["auth"]);
  });

  it("surfaces a distinct quota notice when the BYOK model is out of credits, and fails rather than falling back", async () => {
    const fake = fakeRunner();
    const notices: Array<{ kind: string }> = [];
    const caller = createNlModelCaller({
      nlComplete: vi.fn(async () => {
        throw new Error("nl_complete[quota]: HTTP 429");
      }),
      runner: fake.runner,
      cwd: "/repo",
      onNotice: (n) => notices.push(n),
    });

    await expect(caller.call("parse this")).rejects.toThrow(/credits/i);
    expect(fake.runner.start).not.toHaveBeenCalled();
    // A permanent out-of-credits error is NOT a generic blip — the user must act, so it gets its own kind.
    expect(notices.map((n) => n.kind)).toEqual(["quota"]);
  });

  /**
   * The routing rule, stated once per code. `no_key` means BYOK is not configured and is the ONLY code
   * permitted to reach the CLI; every other code means a configured provider failed, which is terminal.
   */
  describe("BYOK is the sole path once configured", () => {
    const terminal: Array<[code: string, expected: RegExp]> = [
      ["auth", /key was rejected/i],
      ["quota", /credits/i],
      ["rate_limit", /rate limited/i],
      ["bad_request", /rejected the request/i],
      ["timeout", /timed out/i],
      ["network", /couldn't reach/i],
      ["bad_response", /couldn't read/i],
      ["something_new", /unavailable/i],
    ];

    for (const [code, expected] of terminal) {
      it(`never spawns the CLI for a \`${code}\` failure, and explains it`, async () => {
        const fake = fakeRunner();
        const caller = createNlModelCaller({
          nlComplete: vi.fn(async () => {
            throw new Error(`nl_complete[${code}]: HTTP 400`);
          }),
          runner: fake.runner,
          cwd: "/repo",
        });

        await expect(caller.call("parse this")).rejects.toThrow(expected);
        expect(fake.runner.start).not.toHaveBeenCalled();
      });
    }

    it("forwards the provider's own complaint for a refused request so it is debuggable", async () => {
      const fake = fakeRunner();
      const caller = createNlModelCaller({
        nlComplete: vi.fn(async () => {
          throw new Error("nl_complete[bad_request]: HTTP 400 — Invalid schema for response_format 'nl_intents'");
        }),
        runner: fake.runner,
        cwd: "/repo",
      });

      // A bare "HTTP 400" is what hid this class of bug for months — the detail has to reach the user.
      await expect(caller.call("parse this")).rejects.toThrow(/Invalid schema for response_format/);
      expect(fake.runner.start).not.toHaveBeenCalled();
    });

    it("routes a bad_request to the config notice class, so it earns a banner", async () => {
      const notices: string[] = [];
      const caller = createNlModelCaller({
        nlComplete: vi.fn(async () => {
          throw new Error("nl_complete[bad_request]: HTTP 404 — model not found");
        }),
        runner: fakeRunner().runner,
        cwd: "/repo",
        onNotice: (n) => notices.push(n.kind),
      });

      await expect(caller.call("parse this")).rejects.toThrow();
      expect(notices).toEqual(["config"]);
    });

    it("keeps transient failures out of the banner classes", async () => {
      const notices: string[] = [];
      const caller = createNlModelCaller({
        nlComplete: vi.fn(async () => {
          throw new Error("nl_complete[network]: connection reset");
        }),
        runner: fakeRunner().runner,
        cwd: "/repo",
        onNotice: (n) => notices.push(n.kind),
      });

      await expect(caller.call("parse this")).rejects.toThrow();
      expect(notices).toEqual(["transient"]);
    });
  });

  it("gives an actionable quota error when CLI fallback is disabled (voice), without spawning the CLI", async () => {
    const fake = fakeRunner();
    const caller = createNlModelCaller({
      nlComplete: vi.fn(async () => {
        throw new Error("nl_complete[quota]: HTTP 429");
      }),
      runner: fake.runner,
      cwd: "/repo",
    });

    await expect(caller.call("parse this", undefined, { allowCliFallback: false })).rejects.toThrow(/credit|quota/i);
    expect(fake.runner.start).not.toHaveBeenCalled();
  });

  /**
   * `--print` withholds `result` until the session's Stop hooks finish — measured at ~110s in this repo
   * (claude-mem's summarize pass), while the answer itself lands at ~7s. Waiting for `result` therefore
   * timed out with the correct reply already in hand.
   */
  describe("no-key CLI leg settles on the assistant text, not on `result`", () => {
    const noKey = () => ({
      nlComplete: vi.fn(async () => {
        throw new Error("nl_complete[no_key]: none");
      }),
    });

    it("resolves from the text event without ever seeing `result`", async () => {
      const fake = fakeRunner();
      const caller = createNlModelCaller({ ...noKey(), runner: fake.runner, cwd: "/repo", cliTimeoutMs: 15_000 });

      const pending = caller.call("parse this");
      await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));
      fake.emitThinking();
      fake.emitText('[{"action":"arrange"}]');
      await vi.advanceTimersByTimeAsync(400);

      // No `result` is ever emitted — the old code would have sat here until the 15s timeout.
      await expect(pending).resolves.toBe('[{"action":"arrange"}]');
    });

    it("kills the spawned process once the answer is in, so runs don't stack up", async () => {
      const fake = fakeRunner();
      const caller = createNlModelCaller({ ...noKey(), runner: fake.runner, cwd: "/repo" });

      const pending = caller.call("parse this");
      await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));
      fake.emitText("done");
      await vi.advanceTimersByTimeAsync(400);
      await pending;

      // Left alive, each command would leave another ~2-minute teardown running.
      expect(fake.runner.stop).toHaveBeenCalledWith("run-1");
    });

    it("does not truncate a reply split across two messages", async () => {
      const fake = fakeRunner();
      const caller = createNlModelCaller({ ...noKey(), runner: fake.runner, cwd: "/repo" });

      const pending = caller.call("parse this");
      await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));
      fake.emitText("first", "msg-1");
      await vi.advanceTimersByTimeAsync(100); // still inside the grace window
      fake.emitText("second", "msg-2");
      await vi.advanceTimersByTimeAsync(400);

      // The grace window restarts per text event, and the LAST message wins — matching what
      // `result.result` reports, so this returns exactly what waiting would have.
      await expect(pending).resolves.toBe("second");
    });

    it("still honours a `result` that arrives first, including a failure", async () => {
      const fake = fakeRunner();
      const caller = createNlModelCaller({ ...noKey(), runner: fake.runner, cwd: "/repo" });

      const pending = caller.call("parse this");
      pending.catch(() => {});
      await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));
      fake.emitResult(false, "model exploded");

      await expect(pending).rejects.toThrow(/model exploded/);
    });

    it("classifies a dead claude CLI session as cli-auth and gives an actionable /login remedy", async () => {
      const fake = fakeRunner();
      const notices: Array<{ kind: string; detail: string }> = [];
      const caller = createNlModelCaller({
        ...noKey(),
        runner: fake.runner,
        cwd: "/repo",
        onNotice: (n) => notices.push(n),
      });

      const pending = caller.call("parse this");
      pending.catch(() => {});
      await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));
      fake.emitResult(false, "Failed to authenticate: OAuth session expired and could not be refreshed");

      await expect(pending).rejects.toThrow(/claude \/login/i);
      await expect(pending).rejects.toThrow(/OAuth session expired and could not be refreshed/);
      // `cli-fallback` fires first (no BYOK key configured, so the CLI leg was reached at all);
      // `cli-auth` is the CLI leg's own failure classification once it ran.
      expect(notices).toEqual([
        { kind: "cli-fallback", detail: "nl_complete[no_key]: none" },
        { kind: "cli-auth", detail: "Failed to authenticate: OAuth session expired and could not be refreshed" },
      ]);
    });

    it("classifies other known auth-failure phrasings from the CLI as cli-auth too", async () => {
      const fake = fakeRunner();
      const notices: string[] = [];
      const caller = createNlModelCaller({
        ...noKey(),
        runner: fake.runner,
        cwd: "/repo",
        onNotice: (n) => notices.push(n.kind),
      });

      const pending = caller.call("parse this");
      pending.catch(() => {});
      await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));
      fake.emitResult(false, "Invalid API key · Please run /login");

      await expect(pending).rejects.toThrow(/claude \/login/i);
      expect(notices).toEqual(["cli-fallback", "cli-auth"]);
    });

    it("does not misclassify a non-auth CLI failure as cli-auth", async () => {
      const fake = fakeRunner();
      const notices: string[] = [];
      const caller = createNlModelCaller({
        ...noKey(),
        runner: fake.runner,
        cwd: "/repo",
        onNotice: (n) => notices.push(n.kind),
      });

      const pending = caller.call("parse this");
      pending.catch(() => {});
      await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));
      fake.emitResult(false, "model exploded");

      await expect(pending).rejects.toThrow(/^model exploded$/);
      // Non-auth failure: only the pre-existing `cli-fallback` notice, no `cli-auth` misclassification.
      expect(notices).toEqual(["cli-fallback"]);
    });

    it("prefers the authoritative `result` text when it beats the grace window", async () => {
      const fake = fakeRunner();
      const caller = createNlModelCaller({ ...noKey(), runner: fake.runner, cwd: "/repo" });

      const pending = caller.call("parse this");
      await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));
      fake.emitText("streamed");
      fake.emitResult(true, "authoritative");

      await expect(pending).resolves.toBe("authoritative");
    });

    it("a text event after the call already settled is a no-op", async () => {
      const fake = fakeRunner();
      const caller = createNlModelCaller({ ...noKey(), runner: fake.runner, cwd: "/repo", cliTimeoutMs: 1_000 });

      const pending = caller.call("parse this");
      pending.catch(() => {});
      await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).rejects.toThrow(/timed out/i);

      // A killed process may still flush a line; it must not resurrect the settled call.
      expect(() => fake.emitText("zombie")).not.toThrow();
      await vi.advanceTimersByTimeAsync(400);
    });
  });

  it("kills the spawned CLI process on timeout instead of orphaning it", async () => {
    const fake = fakeRunner();
    const caller = createNlModelCaller({
      nlComplete: vi.fn(async () => {
        throw new Error("nl_complete[no_key]: none");
      }),
      runner: fake.runner,
      cwd: "/repo",
      cliTimeoutMs: 30_000,
    });

    const pending = caller.call("parse this");
    pending.catch(() => {}); // assertion below; avoid unhandled-rejection noise
    await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).rejects.toThrow(/timed out/i);
    expect(fake.runner.stop).toHaveBeenCalledWith("run-1");
  });

  it("dispose cancels an in-flight CLI run and rejects the pending call", async () => {
    const fake = fakeRunner();
    const caller = createNlModelCaller({
      nlComplete: vi.fn(async () => {
        throw new Error("nl_complete[no_key]: none");
      }),
      runner: fake.runner,
      cwd: "/repo",
    });

    const pending = caller.call("parse this");
    pending.catch(() => {});
    await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));

    caller.dispose();
    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(fake.runner.stop).toHaveBeenCalledWith("run-1");
  });

  it("bounds a wedged HTTP round-trip with a clean timeout instead of hanging forever", async () => {
    const fake = fakeRunner();
    const notices: string[] = [];
    const caller = createNlModelCaller({
      // The IPC round-trip never settles — the classic hung case that used to pin the bar on "Thinking…".
      // Normally Rust's tighter deadline reports this; the safety net covers a round-trip that never
      // returns at all.
      nlComplete: vi.fn(() => new Promise<string>(() => {})),
      runner: fake.runner,
      cwd: "/repo",
      httpTimeoutMs: 15_000,
      onNotice: (n) => notices.push(n.kind),
    });

    const pending = caller.call("parse this");
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).rejects.toThrow(/timed out/i);
    // A stall is still a BYOK failure: no CLI spawn, and it is transient rather than a config problem.
    expect(fake.runner.start).not.toHaveBeenCalled();
    expect(notices).toEqual(["transient"]);
  });

  it("a resolved HTTP call before the timeout never touches the CLI", async () => {
    const { runner } = fakeRunner();
    const caller = createNlModelCaller({
      nlComplete: vi.fn(async () => "fast http"),
      runner,
      cwd: "/repo",
      httpTimeoutMs: 8_000,
    });
    await expect(caller.call("parse this")).resolves.toBe("fast http");
    expect(runner.start).not.toHaveBeenCalled();
  });

  it("a late result after timeout does not resurrect the settled call", async () => {
    const fake = fakeRunner();
    const caller = createNlModelCaller({
      nlComplete: vi.fn(async () => {
        throw new Error("nl_complete[no_key]: none");
      }),
      runner: fake.runner,
      cwd: "/repo",
      cliTimeoutMs: 1_000,
    });

    const pending = caller.call("parse this");
    pending.catch(() => {});
    await vi.waitFor(() => expect(fake.runner.start).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).rejects.toThrow(/timed out/i);

    // The killed process may still flush a final line — must be a no-op.
    expect(() => fake.emitResult(true, "zombie")).not.toThrow();
  });
});

describe("isCliAuthError", () => {
  const authy = [
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "FAILED TO AUTHENTICATE",
    "oauth token expired",
    "OAuth session could not be refreshed",
    "Invalid API key",
    "Invalid api key · Please run /login",
    "Please run /login to continue",
    "Authentication failed",
    "API Error: 401",
  ];
  for (const text of authy) {
    it(`matches: ${text}`, () => expect(isCliAuthError(text)).toBe(true));
  }

  const notAuthy = ["model exploded", "Command timed out — try again.", "Network error", ""];
  for (const text of notAuthy) {
    it(`does not match: ${text || "(empty)"}`, () => expect(isCliAuthError(text)).toBe(false));
  }
});


describe("NL cancellation", () => {
  it("cancels a CLI fallback even when the run id arrives after cancellation", async () => {
    const { runner } = fakeRunner();
    let spawned!: (id: string) => void;
    vi.mocked(runner.start).mockImplementation(() => new Promise((resolve) => { spawned = resolve; }));
    const caller = createNlModelCaller({ nlComplete: async () => { throw new Error("nl_complete[no_key]: missing"); }, runner, cwd: "/repo" });
    const owner = new AbortController();
    const pending = caller.call("command", undefined, { signal: owner.signal });
    await vi.waitFor(() => expect(runner.start).toHaveBeenCalled());
    owner.abort();
    const result = await Promise.race([
      pending.then(() => "success", (error) => error.name),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(result).toBe("AbortError");
    spawned("late-run");
    await vi.waitFor(() => expect(runner.stop).toHaveBeenCalledWith("late-run"));
    caller.dispose();
  });
  it("aborts HTTP without showing provider errors or falling back to CLI", async () => {
    const { runner } = fakeRunner();
    const onNotice = vi.fn();
    let signal: AbortSignal | undefined;
    const caller = createNlModelCaller({
      nlComplete: (_prompt, _schema, requestSignal) => {
        signal = requestSignal;
        return new Promise<string>(() => {});
      }, runner, cwd: "/repo", onNotice,
    });
    const owner = new AbortController();
    const pending = caller.call("polish", undefined, { signal: owner.signal, allowCliFallback: false });
    await Promise.resolve();
    owner.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(true);
    expect(onNotice).not.toHaveBeenCalled();
    expect(runner.start).not.toHaveBeenCalled();
    caller.dispose();
  });
});
