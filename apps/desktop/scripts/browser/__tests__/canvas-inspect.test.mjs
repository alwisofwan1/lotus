// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "canvas-inspect.js"), "utf8");

// The file is a plain (non-module) IIFE that assigns globalThis.__lotusInspect.
// Eval it once into the jsdom global so the builders are callable, exactly as a
// webview.eval() injection would make them available on the page.
function loadInspect() {
  // eslint-disable-next-line no-eval
  (0, eval)(source);
  return globalThis.__lotusInspect;
}

describe("canvas-inspect builder", () => {
  beforeAll(() => {
    loadInspect();
  });

  beforeEach(() => {
    document.body.innerHTML = "";
    globalThis.__lotusRefs = undefined;
    globalThis.__lotusRefEpoch = 0;
  });

  it("emits a Playwright-style accessibility tree with headings and refs", () => {
    document.body.innerHTML = `
      <h1>Paket Umroh</h1>
      <nav>
        <a href="/beranda">Beranda</a>
        <a href="/paket">Paket</a>
      </nav>
      <form>
        <label for="q">Cari paket</label>
        <input id="q" type="text" />
        <button type="submit">Cari</button>
      </form>
      <p>Deskripsi singkat paket perjalanan.</p>
    `;
    const snap = globalThis.__lotusInspect.buildSnapshot("req-1");

    expect(snap.action).toBe("snapshot");
    expect(snap.tree).toContain(`heading "Paket Umroh" [level=1]`);
    expect(snap.tree).toMatch(/link "Beranda" \[ref=e\d+\]/);
    expect(snap.tree).toMatch(/textbox "Cari paket" \[ref=e\d+\]/);
    expect(snap.tree).toMatch(/button "Cari" \[ref=e\d+\]/);
    // Refs are only on interactive elements — the heading has none.
    expect(snap.tree).not.toMatch(/heading "Paket Umroh" \[level=1\] \[ref=/);
  });

  it("registers a ref for every interactive element and bumps the epoch", () => {
    document.body.innerHTML = `<button>A</button><a href="/x">B</a>`;
    const first = globalThis.__lotusInspect.buildSnapshot("r1");
    expect(first.refCount).toBe(2);
    expect(globalThis.__lotusRefs.size).toBe(2);
    const epoch1 = globalThis.__lotusRefEpoch;

    // A re-snapshot mints a fresh epoch and a fresh registry (old refs invalid).
    const second = globalThis.__lotusInspect.buildSnapshot("r2");
    expect(second.refEpoch).toBe(epoch1 + 1);
    expect(second.refCount).toBe(2);
  });

  it("never exposes password input values in the tree", () => {
    document.body.innerHTML = `
      <label for="pw">Password</label>
      <input id="pw" type="password" value="hunter2" />
    `;
    const snap = globalThis.__lotusInspect.buildSnapshot("r");
    expect(snap.tree).toContain(`textbox "Password"`);
    expect(snap.tree).not.toContain("hunter2");
    expect(JSON.stringify(snap)).not.toContain("hunter2");
  });

  it("search ranks interactive matches above raw text and caps results", () => {
    document.body.innerHTML = `
      <p>Please sign in to continue signing in now</p>
      <a href="/login">Sign in</a>
    `;
    const out = globalThis.__lotusInspect.buildSearch("r", "sign in", 3);
    expect(out.action).toBe("search");
    expect(out.results.length).toBeLessThanOrEqual(3);
    expect(out.results.length).toBeGreaterThan(0);
    // The link (element) should outrank plain text matches.
    expect(out.results[0].kind).toBe("element");
    expect(out.results[0].text.toLowerCase()).toContain("sign in");
  });

  it("redactSecrets removes high-confidence secrets and leaves ordinary text", () => {
    const r = globalThis.__lotusInspect.redactSecrets;
    expect(r("Authorization: Bearer abcdef1234567890TOKEN")).toBe("Authorization: Bearer [REDACTED]");
    expect(r("api_key=SUPERSECRETVALUE123")).toBe("api_key=[REDACTED]");
    expect(r("password: hunter2hunter2")).toBe("password: [REDACTED]");
    expect(r("token=eyJhbGciOiJI.eyJzdWIiOiIxMjM.dBjftJeZ4CVP")).toContain("[REDACTED");
    expect(r("key sk-abcdefghij0123456789")).toBe("key sk-[REDACTED]");
    expect(r("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED_AWS_KEY]");
    expect(r("ghp_0123456789abcdefghijABCDEF")).toBe("[REDACTED_GH_TOKEN]");
    // Ordinary marketing copy is untouched.
    const copy = "Paket umroh 9 hari mulai Rp 25 juta, hubungi tim kami sekarang.";
    expect(r(copy)).toBe(copy);
  });

  it("redacts a secret embedded in an interactive element's accessible name", () => {
    document.body.innerHTML = `
      <a href="/reset" aria-label="Reset link token=eyJhbGciOiJI.eyJzdWIiOiIxMjM.dBjftJeZ4CVP">Reset</a>
      <a href="/guide">Read our travel guide</a>
    `;
    const snap = globalThis.__lotusInspect.buildSnapshot("r");
    expect(JSON.stringify(snap)).not.toContain("eyJhbGciOiJI.eyJzdWIiOiIxMjM.dBjftJeZ4CVP");
    expect(snap.tree).toContain("[REDACTED");
    // Ordinary link name survives.
    expect(snap.tree).toContain(`link "Read our travel guide"`);
  });

  // ── Action executor (slice I3) ──────────────────────────────────────────

  function snapshotRef(role, needle) {
    const snap = globalThis.__lotusInspect.buildSnapshot("s");
    const line = snap.tree.split("\n").find((l) => l.includes(role) && l.includes(needle));
    return line?.match(/\[ref=(e\d+)\]/)?.[1];
  }

  it("click dispatches a native click and returns a fresh snapshot", () => {
    document.body.innerHTML = `<button id="b" type="button">Cari</button>`;
    let clicked = 0;
    document.getElementById("b").addEventListener("click", () => {
      clicked += 1;
    });
    const ref = snapshotRef("button", "Cari");
    const res = globalThis.__lotusInspect.performAction("a1", { type: "click", ref });
    expect(res.ok).toBe(true);
    expect(clicked).toBe(1);
    expect(res.snapshot.action).toBe("snapshot");
    expect(res.snapshot.requestId).toBe("a1");
  });

  it("type sets the value and fires input/change; submit triggers form submit", () => {
    document.body.innerHTML = `<form id="f"><input id="q" type="text" aria-label="Cari paket" /></form>`;
    const input = document.getElementById("q");
    let inputs = 0;
    let submitted = 0;
    input.addEventListener("input", () => {
      inputs += 1;
    });
    document.getElementById("f").addEventListener("submit", (e) => {
      e.preventDefault();
      submitted += 1;
    });
    const ref = snapshotRef("textbox", "Cari paket");
    const res = globalThis.__lotusInspect.performAction("a2", {
      type: "type",
      ref,
      text: "umroh",
      submit: true,
    });
    expect(res.ok).toBe(true);
    expect(input.value).toBe("umroh");
    expect(inputs).toBeGreaterThanOrEqual(1);
    expect(submitted).toBe(1);
  });

  it("fill_form types into every field in one call", () => {
    document.body.innerHTML = `
      <input id="a" aria-label="Nama" />
      <input id="b" aria-label="Email" />
    `;
    const refA = snapshotRef("textbox", "Nama");
    // buildSnapshot inside snapshotRef reset the epoch; grab both refs from ONE snapshot.
    const snap = globalThis.__lotusInspect.buildSnapshot("s2");
    const refFor = (label) =>
      snap.tree.split("\n").find((l) => l.includes(label))?.match(/\[ref=(e\d+)\]/)?.[1];
    const res = globalThis.__lotusInspect.performAction("a3", {
      type: "fill_form",
      fields: [
        { ref: refFor("Nama"), value: "Alwi" },
        { ref: refFor("Email"), value: "a@b.co" },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.filled).toBe(2);
    expect(document.getElementById("a").value).toBe("Alwi");
    expect(document.getElementById("b").value).toBe("a@b.co");
    expect(refA).toBeTruthy();
  });

  it("select_option selects by value and reports matches", () => {
    document.body.innerHTML = `
      <select id="s" aria-label="Kota"><option value="jkt">Jakarta</option><option value="bdg">Bandung</option></select>
    `;
    const snap = globalThis.__lotusInspect.buildSnapshot("s3");
    const ref = snap.tree.split("\n").find((l) => l.includes("Kota"))?.match(/\[ref=(e\d+)\]/)?.[1];
    const res = globalThis.__lotusInspect.performAction("a4", { type: "select_option", ref, values: ["bdg"] });
    expect(res.ok).toBe(true);
    expect(res.matched).toBe(1);
    expect(document.getElementById("s").value).toBe("bdg");
  });

  it("rejects an unknown or stale ref without throwing, still returning a snapshot", () => {
    document.body.innerHTML = `<button aria-label="Go">Go</button>`;
    const stale = globalThis.__lotusInspect.performAction("a5", { type: "click", ref: "e999" });
    expect(stale.ok).toBe(false);
    expect(stale.error).toMatch(/unknown or stale ref/);
    expect(stale.snapshot).toBeTruthy();

    // A ref from an old epoch is rejected once a newer snapshot supersedes it.
    const ref = snapshotRef("button", "Go");
    globalThis.__lotusInspect.buildSnapshot("newer"); // bumps epoch, invalidating `ref`
    const old = globalThis.__lotusInspect.performAction("a6", { type: "click", ref });
    expect(old.ok).toBe(false);
    expect(old.error).toMatch(/stale ref/);
  });

  it("press_key without a ref targets the document", () => {
    document.body.innerHTML = `<div></div>`;
    let key = "";
    document.addEventListener("keydown", (e) => {
      key = e.key;
    });
    const res = globalThis.__lotusInspect.performAction("a7", { type: "press_key", key: "Escape" });
    expect(res.ok).toBe(true);
    expect(key).toBe("Escape");
  });

  it("truncates an oversized tree instead of blowing the payload budget", () => {
    // ~1200 buttons ≈ 22k chars of tree — comfortably over the 12k cap while
    // staying cheap enough to build under full-suite load.
    const many = Array.from({ length: 1200 }, (_, i) => `<button>btn ${i}</button>`).join("");
    document.body.innerHTML = many;
    const snap = globalThis.__lotusInspect.buildSnapshot("r");
    expect(snap.tree.length).toBeLessThanOrEqual(12000 + 64);
    expect(snap.truncated).toBe(true);
    expect(snap.tree).toContain("tree truncated");
  });
});
