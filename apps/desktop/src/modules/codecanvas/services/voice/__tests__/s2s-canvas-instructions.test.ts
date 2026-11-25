import { describe, expect, it } from "vitest";
import { buildS2sCanvasInstructions } from "../s2s-canvas-instructions";

describe("buildS2sCanvasInstructions guards the spawn brief", () => {
  it("tells the model a bare spawn request carries no first task", () => {
    // Without this the model fills the optional `brief` with the only text it has — the runner's
    // own name — and the new agent burns a model turn answering "cloud code agent".
    const text = buildS2sCanvasInstructions({ agentNames: [], nodeSummaries: [], projectName: "Acme" });

    expect(text).toContain("Only set brief when the user actually described work to do");
  });
});

describe("buildS2sCanvasInstructions does not contradict itself", () => {
  it("never tells the model to preserve paths verbatim while also forbidding paths aloud", () => {
    // The Language section means "don't translate technical terms when replying in the user's
    // language"; the delivery rules mean "don't read a path out character by character". Both are
    // right, but the word "paths" in the first one collides head-on with the second, and the model
    // gets to pick. Scope the preservation to terms that are actually spoken.
    const text = buildS2sCanvasInstructions({ agentNames: [], nodeSummaries: [], projectName: "Acme" });

    expect(text).toContain("Never speak code, commit hashes, file paths");
    expect(text).not.toContain("Preserve technical terms, names, paths, numbers, and versions verbatim");
  });
});

describe("buildS2sCanvasInstructions carries the persona register", () => {
  const base = { agentNames: ["Skye"], nodeSummaries: [], projectName: "Acme" };

  it("speaks in the persona's register when one is supplied", () => {
    const text = buildS2sCanvasInstructions({ ...base, personaBody: "You are Aria. Bottom-line first." });

    expect(text).toContain("You are Aria. Bottom-line first.");
  });

  it("omits the register section entirely for a raw or unset persona", () => {
    // Raw is pass-through: no heading, no empty section, nothing for the model to interpret.
    const text = buildS2sCanvasInstructions(base);

    expect(text).not.toContain("## Voice");
  });

  it("puts the delivery policy ahead of the register", () => {
    const text = buildS2sCanvasInstructions({ ...base, personaBody: "You are Aria." });
    const policyAt = text.indexOf("Never speak code");
    const personaAt = text.indexOf("You are Aria.");

    expect(policyAt).toBeGreaterThanOrEqual(0);
    expect(personaAt).toBeGreaterThanOrEqual(0);
    expect(policyAt).toBeLessThan(personaAt);
  });
});

describe("buildS2sCanvasInstructions carries the compact narration policy", () => {
  const text = () =>
    buildS2sCanvasInstructions({ agentNames: ["Skye"], nodeSummaries: [], projectName: "Acme" });

  it("forbids reading paths, code, and URLs aloud", () => {
    expect(text()).toContain("Never speak code, commit hashes, file paths, command-line flags, or URLs");
  });

  it("requires aggregating homogeneous lists", () => {
    expect(text()).toContain("state how many and what they share");
  });

  it("ties tense to whether the work is finished", () => {
    expect(text()).toContain("Present tense for in-flight, past tense for done");
  });

  it("stays compact — the realtime session pays for these instructions on every connect", () => {
    // The full policy's prose preamble and its long "points that ARE the substance" clause are
    // deliberately absent; only the delivery bullets ride along.
    expect(text()).not.toContain("You are speaking aloud to a developer who is working while you talk");
    expect(text()).not.toContain("Tell those apart from points that ARE the substance");
  });
});

describe("buildS2sCanvasInstructions", () => {
  it("instructs the realtime model to use tools for canvas actions and wait for tool results", () => {
    const text = buildS2sCanvasInstructions({
      agentNames: ["Skye", "Nova"],
      nodeSummaries: ["Browser 1 (browser)", "Task Alpha (task)"],
      projectName: "Acme",
    });

    expect(text).toContain("You are Lotus Live Voice");
    expect(text).toContain("use a tool");
    expect(text).toContain("Do not claim that an action is done until the tool result says it succeeded");
    expect(text).toContain("Skye, Nova");
    expect(text).toContain("Browser 1 (browser)");
    expect(text).toContain("Acme");
  });

  it("uses adaptive spoken depth instead of a global caveman word limit", () => {
    const text = buildS2sCanvasInstructions({
      agentNames: ["Codex"],
      nodeSummaries: [],
      projectName: "Acme",
      verbosity: "expressive",
    });

    expect(text).toContain("## Personality and Tone");
    expect(text).toContain("Natural, warm, and direct");
    expect(text).toContain("Routine acknowledgements: at most 1 sentence and 14 words");
    expect(text).toContain("Evidence-bearing results: up to 5 sentences");
    expect(text).toContain("key evidence and the next action");
    expect(text).toContain("Reply in the user's language");
    expect(text).toContain("Preserve technical terms");
    expect(text).not.toContain("caveman-simple");
    expect(text).not.toContain("Most replies should be 6–14 words");
    expect(text).not.toContain("No long explanations");
    expect(text).not.toContain("One sentence is best");
    expect(text).toContain("If the tool result includes a speak field, use that phrasing");
    expect(text).toContain("If a tool asks which target, ask that exact short question and wait");
    expect(text).toContain("call choose_target with that visible name");
  });

  it("lets agent-output and memory answers use the adaptive result budget", () => {
    const text = buildS2sCanvasInstructions({
      agentNames: ["Codex"],
      nodeSummaries: [],
      verbosity: "expressive",
    });

    expect(text).toContain("Synthesize useful evidence and the next action according to the result budget");
    expect(text).not.toContain("gist in one or two sentences");
    expect(text).not.toContain("what you found in one short sentence");
  });

  it("keeps spoken verbosity limits separate from worker delegation payloads", () => {
    const build = (verbosity: "brief" | "expressive") =>
      buildS2sCanvasInstructions({ agentNames: ["Codex"], nodeSummaries: [], verbosity });
    const delegationContract =
      "Spoken length limits apply only to spoken replies, never tool arguments or worker task payloads.";

    expect(build("brief")).toContain(delegationContract);
    expect(build("expressive")).toContain(delegationContract);
  });

  it("tells the model to end only on the user's own sign-off, never on a request starting with 'itu aja'", () => {
    const text = buildS2sCanvasInstructions({ agentNames: [], nodeSummaries: [], projectName: null });
    expect(text).toContain("end_conversation");
    expect(text).toMatch(/tidur dulu/);
    expect(text).toMatch(/itu aja/);
    expect(text).toMatch(/If the app refuses, keep helping/);
  });

  it("allows explicit close commands without confirmation while preserving ambiguity clarification", () => {
    const text = buildS2sCanvasInstructions({ agentNames: [], nodeSummaries: [], projectName: null });

    expect(text).toContain("Close explicit targets directly");
    expect(text).toContain("close everything");
    expect(text).toContain("Only ask a follow-up when the close target is ambiguous");
    expect(text).not.toContain("Do not close, delete, or remove canvas items");
    expect(text).not.toContain("regular command bar");
  });

  it("tells the realtime model to use grouped spawn_agent items for mixed multi-agent requests", () => {
    const text = buildS2sCanvasInstructions({ agentNames: [], nodeSummaries: [], projectName: null });

    expect(text).toContain("For multiple agent spawns");
    expect(text).toContain("items");
    expect(text).toContain("two Claude and three Codex");
  });

  // Instructions must never promise a capability the realtime tool list doesn't actually advertise
  // (buildS2sCanvasRealtimeTools gates switch_project/navigate_browser/snapshot_browser/dispatch/
  // say_to_agent/make_lead on live board state) — otherwise the model confidently attempts a tool
  // call that isn't in its list and the session either errors or the model apologizes mid-conversation.
  describe("capability sentences match the gated realtime tool list", () => {
    it("does not mention switching projects when no other project is open", () => {
      const text = buildS2sCanvasInstructions({ agentNames: [], nodeSummaries: [], projectName: "Acme" });
      expect(text).not.toMatch(/switch/i);
    });

    it("mentions switching projects only when hasOpenProjects is true", () => {
      const text = buildS2sCanvasInstructions({
        agentNames: [],
        nodeSummaries: [],
        projectName: "Acme",
        hasOpenProjects: true,
      });
      expect(text).toMatch(/switch/i);
    });

    it("still mentions always-available app navigation (settings/canvases/new project) with no other project open", () => {
      const text = buildS2sCanvasInstructions({ agentNames: [], nodeSummaries: [], projectName: "Acme" });
      expect(text).toMatch(/settings/i);
      expect(text).toMatch(/canvases/i);
      expect(text).toMatch(/new project/i);
    });

    it("does not mention browser navigate/snapshot when no browser node is on the board", () => {
      const text = buildS2sCanvasInstructions({ agentNames: [], nodeSummaries: [], projectName: "Acme" });
      expect(text).not.toMatch(/navigate|snapshot/i);
    });

    it("mentions browser navigate/snapshot only when hasBrowserNodes is true", () => {
      const text = buildS2sCanvasInstructions({
        agentNames: [],
        nodeSummaries: [],
        projectName: "Acme",
        hasBrowserNodes: true,
      });
      expect(text).toMatch(/navigate/i);
      expect(text).toMatch(/snapshot/i);
    });

    it("does not mention dispatching to or leading agents when no agent is on the board", () => {
      const text = buildS2sCanvasInstructions({ agentNames: [], nodeSummaries: [], projectName: "Acme" });
      expect(text).not.toMatch(/lead orchestrator/i);
    });

    it("mentions dispatch/lead orchestrator only when agents are present", () => {
      const text = buildS2sCanvasInstructions({ agentNames: ["Skye"], nodeSummaries: [], projectName: "Acme" });
      expect(text).toMatch(/lead orchestrator/i);
    });
  });

  it("tells the model to pass a short intent + constraints instead of re-dictating the request, only when live agents exist", () => {
    const withAgents = buildS2sCanvasInstructions({ agentNames: ["Skye"], nodeSummaries: [], projectName: "Acme" });
    expect(withAgents).toContain("Never re-dictate the user's full request into tool arguments");
    expect(withAgents).toContain("Call lightweight tools such as dispatch immediately");
    expect(withAgents).toContain("Only use one short spoken preamble when the tool is expected to take noticeable time");

    const withoutAgents = buildS2sCanvasInstructions({ agentNames: [], nodeSummaries: [], projectName: "Acme" });
    expect(withoutAgents).not.toContain("Never re-dictate the user's full request into tool arguments");
    expect(withoutAgents).not.toContain("Call lightweight tools such as dispatch immediately");
  });

  it("always tells the model to confirm a request that sounds cut off before acting, regardless of live agents", () => {
    const text = buildS2sCanvasInstructions({ agentNames: [], nodeSummaries: [], projectName: "Acme" });
    expect(text).toContain(
      "If the user's speech seems cut off mid-sentence, confirm the request in one short sentence before acting on it.",
    );
  });

  it("bounds large canvas context", () => {
    const text = buildS2sCanvasInstructions({
      agentNames: Array.from({ length: 20 }, (_, i) => `Agent ${i}`),
      nodeSummaries: Array.from({ length: 80 }, (_, i) => `Node ${i} (note)`),
      projectName: "Big",
    });

    expect(text).toContain("Agent 0");
    expect(text).not.toContain("Agent 19");
    expect(text).toContain("Node 0 (note)");
    expect(text).not.toContain("Node 79 (note)");
  });
});
