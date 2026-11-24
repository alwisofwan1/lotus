import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildSpeakPrompt, composeSpokenConfirmation, detectSpeechLanguage, spokenTextMatchesLanguage } from "../speak-composer";

describe("buildSpeakPrompt carries the shared narration policy", () => {
  const prompt = () => buildSpeakPrompt("close everything", "Closed 3 nodes.", [], "en");

  it("forbids speaking code, paths, and URLs aloud", () => {
    // The single most common slop in a spoken channel: reading `src/pages/pricing.tsx` letter by
    // letter instead of saying "the pricing page".
    expect(prompt()).toContain("Never speak code, commit hashes, file paths, command-line flags, or URLs");
  });

  it("requires aggregating homogeneous lists rather than enumerating them", () => {
    expect(prompt()).toContain("state how many and what they share");
  });

  it("ties tense to whether the work is finished", () => {
    expect(prompt()).toContain("Present tense for in-flight, past tense for done");
  });

  it("keeps pronouns and the first person — a collaborator, not a status feed", () => {
    expect(prompt()).toContain("Drop adverbs, but NOT pronouns");
  });

  it("puts the policy ahead of the persona style line", () => {
    const text = prompt();
    const policyAt = text.indexOf("Never speak code");
    const styleAt = text.indexOf("refined AI valet");
    // Assert presence before order: a missing needle gives indexOf -1, and -1 < anything passes
    // vacuously — the ordering claim would then hold even with no policy in the prompt at all.
    expect(policyAt).toBeGreaterThanOrEqual(0);
    expect(styleAt).toBeGreaterThanOrEqual(0);
    // Policy is what the voice may say; style is how it says it. A style line that lands first
    // reads as the stronger instruction and the model trades policy away to satisfy it.
    expect(policyAt).toBeLessThan(styleAt);
  });
});

describe("detectSpeechLanguage", () => {
  it("answers Indonesian input in English — Indonesian is dropped as a spoken-reply language", () => {
    expect(detectSpeechLanguage("buka dua agen claude", "en")).toBe("en");
    expect(detectSpeechLanguage("tolong tutup semuanya", "en")).toBe("en");
    // Even a configured Indonesian voice-input language yields an English reply.
    expect(detectSpeechLanguage("Rowan", "id-ID")).toBe("en");
    expect(detectSpeechLanguage("", "id")).toBe("en");
  });

  it("English for English input", () => {
    expect(detectSpeechLanguage("close everything", "en")).toBe("en");
    expect(detectSpeechLanguage("open two claude agents", undefined)).toBe("en");
    expect(detectSpeechLanguage("", undefined)).toBe("en");
  });

  it("detects Japanese by KANA — the only script unique to Japanese", () => {
    expect(detectSpeechLanguage("すべて閉じて", "en")).toBe("ja"); // hiragana present
    expect(detectSpeechLanguage("ターミナルを開いて", "id")).toBe("ja"); // katakana + hiragana
    expect(detectSpeechLanguage("Rowan を呼んで", "en")).toBe("ja"); // Latin name + kana
  });

  it("honors a Japanese voice-input language when the query carries no script signal", () => {
    expect(detectSpeechLanguage("Rowan", "ja")).toBe("ja");
    expect(detectSpeechLanguage("xyz", "ja-JP")).toBe("ja");
  });

  it("does NOT call Chinese Japanese — Han without kana is Chinese → English", () => {
    // A Mandarin query shares Han ideographs with Japanese but has no kana; never answer in Japanese.
    expect(detectSpeechLanguage("关闭所有", "ja")).toBe("en"); // STT=ja must NOT drag it to Japanese
    expect(detectSpeechLanguage("打开两个终端", "id")).toBe("en");
    expect(detectSpeechLanguage("Rowan 关闭", "en")).toBe("en"); // Latin name + Han, no kana
  });

  it("routes other scripts to English (Korean, Arabic, Cyrillic)", () => {
    expect(detectSpeechLanguage("모두 닫기", "id")).toBe("en"); // Hangul
    expect(detectSpeechLanguage("أغلق كل شيء", "id")).toBe("en"); // Arabic
    expect(detectSpeechLanguage("закрыть всё", "ja")).toBe("en"); // Cyrillic (STT=ja, no kana → en)
  });

  it("an unsupported STT fallback resolves to English", () => {
    expect(detectSpeechLanguage("xyz", "zh-CN")).toBe("en");
    expect(detectSpeechLanguage("xyz", "ko-KR")).toBe("en");
  });
});

describe("spokenTextMatchesLanguage (anti-slop output guard)", () => {
  it("accepts a Japanese reply only when it actually contains kana", () => {
    expect(spokenTextMatchesLanguage("全部閉じました。", "ja")).toBe(true);
    expect(spokenTextMatchesLanguage("All nodes closed.", "ja")).toBe(false); // model ignored the ja command
  });

  it("rejects CJK contamination in an English reply", () => {
    expect(spokenTextMatchesLanguage("Two agents opened.", "en")).toBe(true);
    expect(spokenTextMatchesLanguage("关闭了", "en")).toBe(false); // Han in an English reply = slop
    expect(spokenTextMatchesLanguage("閉じました", "en")).toBe(false); // kana in an English reply = slop
  });
});

describe("buildSpeakPrompt — tone + verbosity (Settings → Voice)", () => {
  it("defaults to the poised JARVIS valet register — courteous, max 12 words", () => {
    const p = buildSpeakPrompt("close everything", "Closing everything", [], "en");
    expect(p.toLowerCase()).toContain("courteous");
    expect(p.toLowerCase()).toContain("jarvis");
    // Not the eager "friendly teammate" of the warm preset.
    expect(p.toLowerCase()).not.toContain("teammate");
    expect(p.toLowerCase()).toContain("max 12 words");
  });

  it("the JARVIS default is poised and gracious, never servile or robotic", () => {
    const p = buildSpeakPrompt("tutup semua", "Closing everything", [], "en", { tone: "jarvis" });
    expect(p.toLowerCase()).toContain("valet");
    expect(p.toLowerCase()).toContain("gracious");
    expect(p.toLowerCase()).toContain("never");
  });

  it("the warm preset stays available for users who opt into the friendly-teammate voice", () => {
    const p = buildSpeakPrompt("close everything", "Closing everything", [], "en", { tone: "warm" });
    expect(p.toLowerCase()).toContain("teammate");
    expect(p.toLowerCase()).not.toContain("jarvis");
  });

  it("verbosity scales the word budget: brief tightens, expressive allows real sentences", () => {
    const brief = buildSpeakPrompt("close everything", "Closing everything", [], "en", { verbosity: "brief" });
    expect(brief.toLowerCase()).toContain("max 8 words");
    const expressive = buildSpeakPrompt("close everything", "Closing everything", [], "en", { verbosity: "expressive" });
    expect(expressive.toLowerCase()).toContain("max 26 words");
    expect(expressive.toLowerCase()).not.toContain("max 12 words");
  });

  it("a formal tone preset replaces the warm style line", () => {
    const p = buildSpeakPrompt("close everything", "Closing everything", [], "en", { tone: "formal" });
    expect(p.toLowerCase()).toContain("professional");
    expect(p.toLowerCase()).not.toContain("warm");
  });

  it("custom tone instructions are threaded verbatim", () => {
    const p = buildSpeakPrompt("tutup semua", "Closing everything", [], "en", {
      tone: "custom",
      toneInstructions: "Bicara santai seperti teman dekat.",
    });
    expect(p).toContain("Bicara santai seperti teman dekat.");
  });

  it("custom tone with empty instructions falls back to the JARVIS default", () => {
    const p = buildSpeakPrompt("close everything", "Closing everything", [], "en", { tone: "custom", toneInstructions: "  " });
    expect(p.toLowerCase()).toContain("courteous");
    expect(p.toLowerCase()).toContain("jarvis");
  });
});

describe("composeSpokenConfirmation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("commands English for an Indonesian query — Indonesian is dropped as a reply language", async () => {
    let prompt = "";
    const complete = vi.fn(async (p: string) => {
      prompt = p;
      return "Two agents are ready.";
    });

    const spoken = await composeSpokenConfirmation({
      query: "buka 1 claude dan 1 codex",
      fallback: "Spawning a Claude agent and a Codex agent",
      facts: [],
      complete,
    });

    expect(spoken).toBe("Two agents are ready.");
    expect(prompt).toContain("buka 1 claude dan 1 codex");
    // Deterministic: code resolved "en" for the Indonesian request; the prompt commands it hard.
    expect(prompt).toContain("Reply in English");
    expect(prompt.toLowerCase()).toContain("never reply in any other language");
    // The template rides along as ground truth of what actually happened.
    expect(prompt).toContain("Spawning a Claude agent and a Codex agent");
  });

  it("commands English for an English query — 'close everything' must never come back Spanish", async () => {
    let prompt = "";
    await composeSpokenConfirmation({
      query: "close everything",
      fallback: "Closing everything",
      facts: [],
      complete: async (p) => {
        prompt = p;
        return "All nodes closed.";
      },
    });
    expect(prompt).toContain("Reply in English");
  });

  it("a terse query with an Indonesian STT language still replies in English", async () => {
    let prompt = "";
    await composeSpokenConfirmation({
      query: "Rowan",
      fallback: "Focusing Rowan",
      facts: [],
      sttLanguage: "id-ID",
      complete: async (p) => {
        prompt = p;
        return "Focused on Rowan.";
      },
    });
    expect(prompt).toContain("Reply in English");
  });

  it("asks for the poised JARVIS register by default — courteous, economical, never robotic", async () => {
    let prompt = "";
    await composeSpokenConfirmation({
      query: "close everything",
      fallback: "Closing everything",
      facts: [],
      complete: async (p) => {
        prompt = p;
        return "Everything is closed.";
      },
    });
    expect(prompt.toLowerCase()).toContain("courteous");
    expect(prompt.toLowerCase()).toContain("jarvis");
    expect(prompt.toLowerCase()).toContain("max 12 words");
  });

  it("commands Japanese for a Japanese query", async () => {
    let prompt = "";
    await composeSpokenConfirmation({
      query: "すべて閉じて",
      fallback: "Closing everything",
      facts: [],
      complete: async (p) => {
        prompt = p;
        return "全部閉じました。";
      },
    });
    expect(prompt).toContain("Reply in Japanese");
    expect(prompt.toLowerCase()).toContain("never reply in any other language");
  });

  it("commands English for an unsupported-language query (Chinese) — never Japanese", async () => {
    let prompt = "";
    await composeSpokenConfirmation({
      query: "关闭所有终端",
      fallback: "Closing everything",
      facts: [],
      sttLanguage: "ja-JP", // even with a Japanese STT setting, a Chinese query stays English
      complete: async (p) => {
        prompt = p;
        return "All terminals closed.";
      },
    });
    expect(prompt).toContain("Reply in English");
    expect(prompt).not.toContain("Reply in Japanese");
  });

  it("falls back to the template when the model replies in the wrong script (anti-slop guard)", async () => {
    // Commanded English, but the model returned Chinese — speak the honest English template
    // instead of a language the user didn't ask for.
    const spoken = await composeSpokenConfirmation({
      query: "close everything",
      fallback: "Closing everything",
      facts: [],
      complete: async () => "关闭了所有终端",
    });
    expect(spoken).toBe("Closing everything");
  });

  it("falls back to the template on any model failure (no BYOK key = today's behavior)", async () => {
    const spoken = await composeSpokenConfirmation({
      query: "buka terminal",
      fallback: "Creating a terminal node",
      facts: [],
      complete: async () => {
        throw new Error("nl_complete[no_key]: no BYOK NL model configured");
      },
    });
    expect(spoken).toBe("Creating a terminal node");
  });

  it("falls back on empty or runaway model output instead of speaking garbage", async () => {
    const empty = await composeSpokenConfirmation({
      query: "q",
      fallback: "Fallback line",
      facts: [],
      complete: async () => "   \n  ",
    });
    expect(empty).toBe("Fallback line");

    const runaway = await composeSpokenConfirmation({
      query: "q",
      fallback: "Fallback line",
      facts: [],
      complete: async () => "x".repeat(1000),
    });
    expect(runaway).toBe("Fallback line");
  });

  it("keeps only the first line and strips surrounding quotes", async () => {
    const spoken = await composeSpokenConfirmation({
      query: "q",
      fallback: "Fallback",
      facts: [],
      complete: async () => '"Beres, terminal baru sudah siap."\n\nExtra paragraph the TTS must never read.',
    });
    expect(spoken).toBe("Beres, terminal baru sudah siap.");
  });

  it("times out to the fallback so speech never trails the action by long", async () => {
    const never = new Promise<string>(() => {});
    const pending = composeSpokenConfirmation({
      query: "q",
      fallback: "Fallback",
      facts: [],
      complete: () => never,
      timeoutMs: 4_000,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(pending).resolves.toBe("Fallback");
  });

  it("threads outcome facts into the prompt so speech stays honest (queued, undelivered)", async () => {
    let prompt = "";
    await composeSpokenConfirmation({
      query: "suruh Skye refactor",
      fallback: "Dispatching to Skye",
      facts: ["queued until the agent is ready"],
      complete: async (p) => {
        prompt = p;
        return "Oke, pesannya menunggu Skye siap.";
      },
    });
    expect(prompt).toContain("queued until the agent is ready");
  });
});
