/**
 * NL Model Transport — the one deep module owning how an NL utility prompt (parse /
 * dispatch-refine / dictation polish) reaches a model.
 *
 * **BYOK is the sole path once a key is configured.** The two adapters are alternatives chosen by
 * configuration, never a chain:
 *
 *   1. BYOK direct HTTP (`nl_complete`) — used exclusively whenever a key resolves.
 *   2. Cold `claude --print` via the canvas agent runner — used ONLY when no key is configured.
 *
 * `no_key` is therefore the single code that may cross between them. Every other BYOK failure is
 * terminal and surfaces as an actionable error, for three reasons:
 *
 *   * **The user's choice means something.** Configuring a key says "send my canvas prompts here".
 *     Quietly re-sending the same prompt to a second vendor on failure contradicts that, and doubles
 *     the disclosure — the prompt carries node names, project paths and diagram text.
 *   * **Speed.** The old chain paid the BYOK timeout *and then* a cold CLI spawn. Measured on this
 *     repo, that CLI leg takes ~117s (only ~4s of it model time; the rest is session boot and the
 *     project's Stop hooks), so the "fallback" reliably blew the budget and reported a bare timeout.
 *   * **Diagnosability.** A permanently broken request (a schema the provider rejects) used to hide
 *     behind a fallback forever. With one path, a 400 is reported as a 400.
 *
 * The transport still owns both timeouts, error classification, CLI run cancellation (timeout and
 * dispose kill the spawned process instead of orphaning it), and per-path latency logging. Callers see
 * only `call(prompt)`.
 */

import type { AgentRunner } from "@/lib/tauri/canvas-agent";
import { parseAgentStreamLine } from "./agent-stream-parser";

/** Fast/cheap model for the no-key CLI leg (the HTTP model is authoritative from the BYOK config). */
const DEFAULT_CLI_MODEL = "claude-haiku-4-5";
// Only reached when NO key is configured. A cold `claude --print` spawn is inherently several seconds,
// but a HUNG one must fail-fast to a retryable error rather than hold the bar indefinitely.
const DEFAULT_CLI_TIMEOUT_MS = 15_000;
// How long to wait after an assistant text event for a follow-up one before treating the reply as
// complete. Only needs to cover back-to-back messages within a turn (measured ~10ms apart), so it is
// imperceptible next to the seconds this saves.
const CLI_TEXT_GRACE_MS = 400;
// Safety net only, for a wedged IPC round-trip. Rust owns the real deadline (`NL_HTTP_TIMEOUT`, 10s)
// and this MUST stay strictly wider than it: whichever side fires first wins, and only Rust can report
// *why* it gave up. When the frontend won the race (the old 8s vs 20s inversion) the caller got an
// unclassified stall while the Rust request kept running to completion, unobserved.
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

export interface NlTransportNotice {
  /** Classes the UI treats differently. "auth", "quota", "config", and "cli-auth" are persistent,
   *  user-fixable problems worth a banner; the last two are informational (console only).
   *  - "auth"    — BYOK key rejected; fix the key in Settings → Model.
   *  - "quota"   — provider out of credits; top up or switch models.
   *  - "config"  — the provider refused the request itself (unknown model id, unsupported param).
   *  - "cli-auth" — the no-key CLI leg's claude CLI session is dead (OAuth expired/signed out). Fixed
   *    with `claude /login` in a terminal — NOT Settings → Model, which only affects the BYOK path.
   *  - "transient" — rate limit / timeout / network / malformed reply; retrying may just work.
   *  - "cli-fallback" — no BYOK key is configured, so the CLI leg handled it. */
  kind: "auth" | "quota" | "config" | "cli-auth" | "transient" | "cli-fallback";
  detail: string;
}

// These strings come verbatim from the claude CLI binary (stream-json `result.result` on failure),
// not from Lotus — so this is pattern-matching an external, unversioned surface. Kept narrow (known
// phrasings only) so a genuine model/task failure that happens to mention a keyword doesn't get
// misclassified as a session problem.
const CLI_AUTH_PATTERNS: RegExp[] = [
  /failed to authenticate/i,
  /oauth .*(expired|could not be refreshed)/i,
  /invalid api key/i,
  /please run \/login/i,
  /authentication failed/i,
  /API Error: 401/i,
];

/** True when a CLI-leg error text names a dead/missing claude CLI session rather than a task failure. */
export function isCliAuthError(text: string): boolean {
  return CLI_AUTH_PATTERNS.some((pattern) => pattern.test(text));
}

/** Map a coded failure to its user-facing notice class. */
function noticeKindFor(code: string): NlTransportNotice["kind"] {
  if (code === "auth") return "auth";
  if (code === "quota") return "quota";
  if (code === "bad_request") return "config";
  // The one code that means "BYOK isn't configured" — the CLI leg, not a BYOK failure at all.
  if (code === "no_key") return "cli-fallback";
  return "transient";
}

export interface NlModelTransportDeps {
  /** BYOK HTTP adapter — rejects with `nl_complete[<code>]: …` coded errors. `schema` (optional)
   *  grammar-enforces the reply via the provider's structured-output format. */
  nlComplete: (prompt: string, schema?: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
  /** CLI adapter — the headless claude runner (start resolves with a stoppable runId). Reached only
   *  when no BYOK key is configured. */
  runner: AgentRunner;
  cwd: string;
  cliModel?: string;
  cliTimeoutMs?: number;
  /** Safety net on the HTTP leg. Must stay strictly wider than Rust's own deadline — see
   *  {@link DEFAULT_HTTP_TIMEOUT_MS}. */
  httpTimeoutMs?: number;
  /** Configuration problems worth a banner (auth/quota/config) and informational signals for the
   *  console (transient/cli-fallback). */
  onNotice?: (notice: NlTransportNotice) => void;
}

export interface NlModelCallOptions {
  /** False for latency-sensitive voice turns: BYOK is allowed, but the cold CLI leg is not — so with no
   *  key configured the call errors instead of spawning a process. Has no effect when BYOK IS
   *  configured, since the CLI is then unreachable regardless. */
  allowCliFallback?: boolean;
  signal?: AbortSignal;
}

export interface NlModelCaller {
  /** `schema` (optional) grammar-enforces the BYOK reply via structured output; the no-key CLI leg
   *  ignores it (a cold `claude --print` can't enforce a grammar) and relies on free-form parsing. */
  call: (prompt: string, schema?: Record<string, unknown>, options?: NlModelCallOptions) => Promise<string>;
  /** Cancel in-flight CLI runs (kills the spawned process); pending calls reject. */
  dispose: () => void;
}

/** Pull the machine-readable code out of an `nl_complete[<code>]: …` rejection. */
function httpErrorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return /nl_complete\[(\w+)\]/.exec(msg)?.[1] ?? "unknown";
}

/** Strip the `nl_complete[<code>]: ` prefix so a provider's own complaint can be shown on its own. */
function bareDetail(detail: string): string {
  return detail.replace(/^nl_complete\[\w+\]:\s*/, "").trim();
}

/**
 * The message the user sees when the configured BYOK provider fails. Since nothing falls back any more,
 * this text is the entire remedy — so each code names both the cause and the fix, and the codes that
 * carry provider diagnostics (a refused request, a rate limit with a wait hint) pass them through.
 */
function byokError(code: string, detail: string): Error {
  const bare = bareDetail(detail);
  switch (code) {
    case "no_key":
      return new Error("NL command model is not configured — set an OpenAI, Anthropic, or Gemini key in Settings → Model, or use a local canvas command.");
    case "auth":
      return new Error("NL model key was rejected — check Settings → Model.");
    case "quota":
      return new Error("NL model is out of credits — top up the provider or switch models in Settings → Model.");
    case "rate_limit":
      return new Error(`NL model is rate limited — try again shortly.${bare ? ` (${bare})` : ""}`);
    case "bad_request":
      // The provider understood us and refused: almost always a wrong model id for the selected
      // provider. Its own message is the most useful thing we can show, so it is not swallowed.
      return new Error(`NL model rejected the request — check the model id in Settings → Model.${bare ? ` (${bare})` : ""}`);
    case "timeout":
      return new Error("NL model timed out — check your connection, then try again.");
    case "network":
      return new Error("Couldn't reach the NL model — check your connection, then try again.");
    case "bad_response":
      return new Error("NL model returned a reply Lotus couldn't read — try again, or switch models in Settings → Model.");
    default:
      return new Error("NL model is unavailable — try again, or use a local canvas command.");
  }
}

export function createNlModelCaller(deps: NlModelTransportDeps): NlModelCaller {
  const cliModel = deps.cliModel ?? DEFAULT_CLI_MODEL;
  const cliTimeoutMs = deps.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const httpTimeoutMs = deps.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

  function callHttp(prompt: string, schema?: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const request = new AbortController();
      let settled = false;
      const id = Symbol();
      const finish = (work: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        inflight.delete(id);
        work();
      };
      const cancel = (error: Error) => finish(() => { request.abort(); reject(error); });
      const abort = () => cancel(new DOMException("NL model call cancelled", "AbortError"));
      const timer = setTimeout(() => cancel(new Error("nl_complete[timeout]: HTTP model timed out")), httpTimeoutMs);
      inflight.set(id, cancel);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      Promise.resolve().then(() => {
        request.signal.throwIfAborted();
        return deps.nlComplete(prompt, schema, request.signal);
      }).then(
        (out) => finish(() => resolve(out)),
        (error) => finish(() => reject(error)),
      );
    });
  }
  // In-flight CLI runs so timeout/dispose can KILL the spawned process (the old
  // component-local version discarded the runId — timed-out spawns ran on as orphans).
  const inflight = new Map<symbol, (reason: Error) => void>();
  let disposed = false;

  function stopRun(runId: string | null) {
    if (runId) void deps.runner.stop(runId).catch(() => {});
  }

  function callViaCli(prompt: string, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const key = Symbol("nl-cli-run");
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        inflight.delete(key);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      let runIdRef: string | null = null;
      const abort = (reason: Error) => settle(() => {
        stopRun(runIdRef);
        reject(reason);
      });
      const onAbort = () => abort(new DOMException("NL model call cancelled", "AbortError"));
      inflight.set(key, abort);

      // The answer arrives on an `assistant` text event; `result` can trail it by a very long time —
      // measured at ~110s in this repo, because `--print` withholds `result` until the session's Stop
      // hooks finish (claude-mem's summarize pass). Waiting for `result` therefore blew the timeout
      // while the correct reply had been in hand for seconds. So we settle on the text instead.
      //
      // `latestText` (not a concatenation) mirrors `result.result`, which reports the FINAL assistant
      // message — so this returns exactly what waiting would have, just sooner. The grace window
      // restarts on each text event, so a reply split across messages is never truncated.
      let latestText: string | null = null;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const settleWithText = () => {
        const text = latestText ?? "";
        settle(() => {
          // The answer is complete; the rest of that process's lifetime is session teardown we have no
          // use for. Left running, every NL command would stack another ~2-minute process.
          stopRun(runIdRef);
          resolve(text);
        });
      };

      const timer = setTimeout(() => abort(new Error("Command timed out — try again.")), cliTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      deps.runner
        .start({
          prompt,
          model: cliModel,
          cwd: deps.cwd,
          skipPermissions: true,
          onLine: (line) => {
            const ev = parseAgentStreamLine(line);
            if (!ev) return;
            if (ev.kind === "text") {
              latestText = ev.text;
              clearTimeout(graceTimer);
              graceTimer = setTimeout(settleWithText, CLI_TEXT_GRACE_MS);
              return;
            }
            // `result` still wins when it arrives first (or reports a failure) — it is authoritative.
            if (ev.kind !== "result") return;
            settle(() => {
              if (ev.ok) {
                resolve(ev.text ?? latestText ?? "");
                return;
              }
              const cliError = ev.text || "The command model returned an error.";
              if (isCliAuthError(cliError)) {
                deps.onNotice?.({ kind: "cli-auth", detail: cliError });
                reject(new Error(`Claude CLI session expired or signed out — run \`claude /login\` in a terminal, then try again. (${cliError})`));
                return;
              }
              reject(new Error(cliError));
            });
          },
        })
        .then((runId) => {
          runIdRef = runId;
          // The call settled (timeout/dispose/text) before start resolved — kill the late spawn.
          if (settled) stopRun(runId);
        })
        .catch((err) => settle(() => reject(err instanceof Error ? err : new Error(String(err)))));
    });
  }

  return {
    async call(prompt: string, schema?: Record<string, unknown>, options?: NlModelCallOptions) {
      if (disposed) throw new Error("NL model transport disposed (cancelled)");
      try {
        const t0 = performance.now();
        const out = await callHttp(prompt, schema, options?.signal);
        console.info(`[nl-model] byok ${Math.round(performance.now() - t0)}ms`);
        return out;
      } catch (err) {
        if (disposed || options?.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
          throw new DOMException("NL model call cancelled", "AbortError");
        }
        const code = httpErrorCode(err);
        const detail = err instanceof Error ? err.message : String(err);
        deps.onNotice?.({ kind: noticeKindFor(code), detail });

        // BYOK IS configured (any code but `no_key`) → this is the sole path, so the failure is final.
        // Reaching the CLI here would ship the same prompt to a second provider behind the user's back
        // and, on a cold spawn, cost far more time than it could ever save.
        if (code !== "no_key") {
          console.info(`[nl-model] byok failed (${code}) — no fallback by design`);
          throw byokError(code, detail);
        }

        // No key configured. The CLI leg is the only path left; a caller that forbids it (latency-
        // sensitive voice turns) gets the "configure a key" error instead.
        if (options?.allowCliFallback === false) {
          console.info("[nl-model] no key configured, cli not permitted here");
          throw byokError("no_key", detail);
        }
        console.info("[nl-model] no key configured → cli leg");
        const t0 = performance.now();
        const out = await callViaCli(prompt, options?.signal);
        console.info(`[nl-model] cli ${Math.round(performance.now() - t0)}ms`);
        return out;
      }
    },
    dispose() {
      disposed = true;
      for (const abort of [...inflight.values()]) abort(new Error("NL model call cancelled"));
      inflight.clear();
    },
  };
}
