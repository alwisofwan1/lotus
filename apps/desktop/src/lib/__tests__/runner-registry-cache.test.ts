import { describe, it, expect, vi } from "vitest";
import { createRunnerRegistryCache, wireRunnerRegistryCacheInvalidation, RUNNERS_CHANGED_EVENT } from "../runner-registry-cache";
import type { RunnerInfo, RunnerRegistry } from "../tauri-api";

const runner = (id: string): RunnerInfo => ({
  id,
  name: id,
  installed: true,
  path: null,
  command: id,
  skip_permissions: true,
  extra_flags: "",
  resume_on_reopen: true,
});

const registry = (...ids: string[]): RunnerRegistry => ({ runners: ids.map(runner) });

describe("createRunnerRegistryCache", () => {
  it("serves repeat listRunners calls from cache — one underlying fetch", async () => {
    const listRunners = vi.fn(async () => registry("claude", "codex"));
    const getRunner = vi.fn(async () => null);
    const cache = createRunnerRegistryCache({ listRunners, getRunner });

    const first = await cache.listRunners();
    const second = await cache.listRunners();

    expect(first.runners.map((r) => r.id)).toEqual(["claude", "codex"]);
    expect(second).toEqual(first);
    expect(listRunners).toHaveBeenCalledTimes(1);
  });

  it("caches getRunner per id — distinct ids fetch independently", async () => {
    const listRunners = vi.fn(async () => registry());
    const getRunner = vi.fn(async (id: string) => runner(id));
    const cache = createRunnerRegistryCache({ listRunners, getRunner });

    const claude1 = await cache.getRunner("claude");
    const claude2 = await cache.getRunner("claude");
    const codex = await cache.getRunner("codex");

    expect(claude1?.id).toBe("claude");
    expect(claude2).toEqual(claude1);
    expect(codex?.id).toBe("codex");
    expect(getRunner).toHaveBeenCalledTimes(2);
    expect(getRunner).toHaveBeenCalledWith("claude");
    expect(getRunner).toHaveBeenCalledWith("codex");
  });

  it("invalidate drops all cached reads so a runner mutation is visible on the next read", async () => {
    let flags = "";
    const listRunners = vi.fn(async () => ({ runners: [{ ...runner("claude"), extra_flags: flags }] }));
    const getRunner = vi.fn(async (id: string) => ({ ...runner(id), extra_flags: flags }));
    const cache = createRunnerRegistryCache({ listRunners, getRunner });

    await cache.listRunners();
    await cache.getRunner("claude");
    flags = "--verbose"; // user saved a config change in Settings
    cache.invalidate();

    const list = await cache.listRunners();
    const one = await cache.getRunner("claude");
    expect(list.runners[0].extra_flags).toBe("--verbose");
    expect(one?.extra_flags).toBe("--verbose");
    expect(listRunners).toHaveBeenCalledTimes(2);
    expect(getRunner).toHaveBeenCalledTimes(2);
  });

  it("does not cache an empty registry (tauri-api's error fallback) — next read re-fetches", async () => {
    // listRunners in tauri-api swallows IPC errors and returns { runners: [] }; if that transient
    // fallback stuck in the cache, custom-runner resolution would stay broken until app restart.
    const results = [registry(), registry("claude")];
    const listRunners = vi.fn(async () => results.shift() ?? registry("claude"));
    const cache = createRunnerRegistryCache({ listRunners, getRunner: async () => null });

    expect((await cache.listRunners()).runners).toEqual([]);
    expect((await cache.listRunners()).runners.map((r) => r.id)).toEqual(["claude"]);
    expect(listRunners).toHaveBeenCalledTimes(2);
  });

  it("does not cache a rejected read — next call retries", async () => {
    let fail = true;
    const listRunners = vi.fn(async () => {
      if (fail) throw new Error("ipc down");
      return registry("claude");
    });
    const getRunner = vi.fn(async (id: string) => {
      if (fail) throw new Error("ipc down");
      return runner(id);
    });
    const cache = createRunnerRegistryCache({ listRunners, getRunner });

    await expect(cache.listRunners()).rejects.toThrow("ipc down");
    await expect(cache.getRunner("claude")).rejects.toThrow("ipc down");
    fail = false;
    expect((await cache.listRunners()).runners.map((r) => r.id)).toEqual(["claude"]);
    expect((await cache.getRunner("claude"))?.id).toBe("claude");
  });

  it("invalidates when the runners-changed event fires (Settings mutation signal)", async () => {
    const listRunners = vi.fn(async () => registry("claude"));
    const cache = createRunnerRegistryCache({ listRunners, getRunner: async () => null });
    const target = new EventTarget();
    wireRunnerRegistryCacheInvalidation(cache, target);

    await cache.listRunners();
    await cache.listRunners();
    expect(listRunners).toHaveBeenCalledTimes(1);

    target.dispatchEvent(new Event(RUNNERS_CHANGED_EVENT));
    await cache.listRunners();
    expect(listRunners).toHaveBeenCalledTimes(2);
  });
});
