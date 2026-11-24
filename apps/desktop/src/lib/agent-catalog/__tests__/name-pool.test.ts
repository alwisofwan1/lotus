import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_NAME_POOL,
  ID_AGENT_NAME_POOL,
  JA_AGENT_NAME_POOL,
  UNIVERSAL_AGENT_NAME_POOL,
  nextAgentName,
  normalizeName,
  resolveNamePool,
  uniqueAgentName,
  validateAgentName,
} from "../name-pool";

describe("normalizeName", () => {
  it("trims and lowercases", () => {
    expect(normalizeName("  Sage  ")).toBe("sage");
    expect(normalizeName("ROWAN")).toBe("rowan");
    expect(normalizeName("\tIris\n")).toBe("iris");
  });

  it("matches the comparison used by resolveAgentByName (name.trim().toLowerCase())", () => {
    const name = "  Wren ";
    expect(normalizeName(name)).toBe(name.trim().toLowerCase());
  });
});

describe("name pools (curated + locale-aware)", () => {
  const POOLS: Record<string, readonly string[]> = {
    UNIVERSAL: UNIVERSAL_AGENT_NAME_POOL,
    JA: JA_AGENT_NAME_POOL,
    ID: ID_AGENT_NAME_POOL,
  };

  it("defaults to the universal (neutral/modern) pool", () => {
    expect(DEFAULT_AGENT_NAME_POOL).toBe(UNIVERSAL_AGENT_NAME_POOL);
  });

  for (const [label, pool] of Object.entries(POOLS)) {
    it(`${label} is a non-trivial, internally unique, curated roster`, () => {
      expect(pool.length).toBeGreaterThanOrEqual(16);
      const normalized = pool.map(normalizeName);
      expect(new Set(normalized).size).toBe(pool.length);
    });

    it(`${label} names are all valid handles (letters only, <=32 chars, no dictionary punctuation)`, () => {
      for (const name of pool) {
        expect(validateAgentName(name, [])).toEqual({ ok: true });
      }
    });
  }
});

describe("resolveNamePool (locale-aware personalization)", () => {
  it("returns the default (universal) pool for an unknown, empty, or missing locale", () => {
    expect(resolveNamePool(undefined)).toBe(DEFAULT_AGENT_NAME_POOL);
    expect(resolveNamePool(null)).toBe(DEFAULT_AGENT_NAME_POOL);
    expect(resolveNamePool("")).toBe(DEFAULT_AGENT_NAME_POOL);
    expect(resolveNamePool("fr-FR")).toBe(DEFAULT_AGENT_NAME_POOL);
  });

  it("maps Japanese locales to the Japanese-friendly pool (primary subtag, case/underscore-insensitive)", () => {
    expect(resolveNamePool("ja")).toBe(JA_AGENT_NAME_POOL);
    expect(resolveNamePool("ja-JP")).toBe(JA_AGENT_NAME_POOL);
    expect(resolveNamePool("JA_jp")).toBe(JA_AGENT_NAME_POOL);
    expect(resolveNamePool("  ja  ")).toBe(JA_AGENT_NAME_POOL);
  });

  it("maps Indonesian locales to the Indonesian-friendly pool", () => {
    expect(resolveNamePool("id")).toBe(ID_AGENT_NAME_POOL);
    expect(resolveNamePool("id-ID")).toBe(ID_AGENT_NAME_POOL);
  });

  it("maps English locales to the universal pool", () => {
    expect(resolveNamePool("en")).toBe(UNIVERSAL_AGENT_NAME_POOL);
    expect(resolveNamePool("en-US")).toBe(UNIVERSAL_AGENT_NAME_POOL);
  });
});

describe("nextAgentName", () => {
  it("returns the first pool name when nothing is taken", () => {
    expect(nextAgentName([])).toBe(DEFAULT_AGENT_NAME_POOL[0]);
  });

  it("skips taken names case-insensitively", () => {
    const first = DEFAULT_AGENT_NAME_POOL[0]; // e.g. "Sage"
    expect(nextAgentName([first.toLowerCase()])).toBe(DEFAULT_AGENT_NAME_POOL[1]);
    expect(nextAgentName([`  ${first.toUpperCase()}  `])).toBe(DEFAULT_AGENT_NAME_POOL[1]);
  });

  it("assigns sequentially across a growing taken set", () => {
    const taken: string[] = [];
    for (let i = 0; i < 4; i++) {
      const name = nextAgentName(taken);
      expect(name).toBe(DEFAULT_AGENT_NAME_POOL[i]);
      taken.push(name);
    }
  });

  it("respects a custom pool", () => {
    const pool = ["Alpha", "Beta"] as const;
    expect(nextAgentName([], pool)).toBe("Alpha");
    expect(nextAgentName(["alpha"], pool)).toBe("Beta");
  });

  it("falls back to 'Agent N' when the pool is exhausted", () => {
    const taken = DEFAULT_AGENT_NAME_POOL.map((n) => n);
    expect(nextAgentName(taken)).toBe("Agent 1");
  });

  it("picks the smallest unused 'Agent N' on exhaustion, skipping existing ones", () => {
    const taken = [...DEFAULT_AGENT_NAME_POOL, "Agent 1", "agent 2"];
    expect(nextAgentName(taken)).toBe("Agent 3");
  });

  it("never returns a duplicate of a taken fallback name", () => {
    const taken = [...DEFAULT_AGENT_NAME_POOL, "Agent 1"];
    expect(nextAgentName(taken)).toBe("Agent 2");
  });
});

describe("validateAgentName", () => {
  it("ok for a fresh, valid name", () => {
    expect(validateAgentName("Sky-walker_1", [])).toEqual({ ok: true });
  });

  it("rejects empty / whitespace-only as 'empty'", () => {
    expect(validateAgentName("", [])).toEqual({ ok: false, reason: "empty" });
    expect(validateAgentName("   ", [])).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects disallowed characters as 'invalid-char'", () => {
    expect(validateAgentName("Sage!", [])).toEqual({ ok: false, reason: "invalid-char" });
    expect(validateAgentName("a@b", [])).toEqual({ ok: false, reason: "invalid-char" });
    expect(validateAgentName("emoji🌿", [])).toEqual({ ok: false, reason: "invalid-char" });
  });

  it("allows letters, digits, space, hyphen, underscore", () => {
    expect(validateAgentName("Rowan Hazel-2_b", [])).toEqual({ ok: true });
  });

  it("rejects names longer than 32 chars as 'too-long'", () => {
    expect(validateAgentName("a".repeat(33), [])).toEqual({ ok: false, reason: "too-long" });
    expect(validateAgentName("a".repeat(32), [])).toEqual({ ok: true });
  });

  it("keeps a desired name when free, derives a unique one on collision", () => {
    const [first, second] = DEFAULT_AGENT_NAME_POOL;
    expect(uniqueAgentName("Rowan", ["Sage"])).toBe("Rowan"); // free → kept
    expect(uniqueAgentName(first, [first.toLowerCase()])).toBe(second); // collision → next pool entry
    expect(uniqueAgentName("", ["not-in-pool"])).toBe(first); // empty → first free pool entry
  });

  it("honours a custom pool for the fallback path (locale-aware naming)", () => {
    const pool = ["Rin", "Ren"] as const;
    expect(uniqueAgentName("", [], pool)).toBe("Rin"); // empty → first custom-pool entry
    expect(uniqueAgentName("", ["rin"], pool)).toBe("Ren"); // skips taken
    expect(uniqueAgentName("Kai", ["Rin"], pool)).toBe("Kai"); // desired still kept when free
  });

  it("yields distinct names for a same-batch spawn as taken accumulates", () => {
    const taken: string[] = [];
    const a = uniqueAgentName("Rowan", taken); taken.push(a);
    const b = uniqueAgentName("Rowan", taken); taken.push(b);
    const c = uniqueAgentName("Rowan", taken); taken.push(c);
    expect(new Set([a, b, c]).size).toBe(3); // no duplicates
    expect(a).toBe("Rowan");
  });

  it("rejects a normalized collision as 'duplicate'", () => {
    expect(validateAgentName("Sage", ["sage"])).toEqual({ ok: false, reason: "duplicate" });
    expect(validateAgentName("  ROWAN ", ["rowan"])).toEqual({ ok: false, reason: "duplicate" });
  });

  it("orders checks: empty before invalid-char before too-long before duplicate", () => {
    // invalid-char beats too-long
    expect(validateAgentName("!".repeat(40), [])).toEqual({ ok: false, reason: "invalid-char" });
    // too-long beats duplicate (a 33-char taken dup is reported too-long first)
    const long = "a".repeat(33);
    expect(validateAgentName(long, [long])).toEqual({ ok: false, reason: "too-long" });
  });
});
