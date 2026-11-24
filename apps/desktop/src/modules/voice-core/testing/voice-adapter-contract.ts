import { describe, expect, it } from "vitest";
import {
  CANCELLED_DELIVERY_REASON,
  EMPTY_DELIVERY_REASON,
  type VoiceAdapter,
  type VoiceDeliveryIntent,
  type VoiceTurnTarget,
} from "../voice-adapter";

/**
 * The one contract every Voice Adapter passes (plans/voice-core, Seam 2). Each mode runs it with a
 * harness built on its own fakes; mode-specific behaviour gets its own tests beside it.
 */
export interface VoiceAdapterContractHarness {
  adapter: VoiceAdapter;
  /** Display names of the targets the harness set up. */
  targetNames: string[];
  /** Text this setup must deliver (`sent`). */
  sendable: { text: string; intent?: Partial<VoiceDeliveryIntent> };
  /** Text this setup must keep for the user (`held`). Omit when the mode cannot hold text. */
  holdable?: { text: string; intent?: Partial<VoiceDeliveryIntent> };
  /** Count of observable side effects so far: writes, commands run, drafts changed. */
  effects: () => number;
  /**
   * The Composer Target locked at mic-open (ADR-0064). Omit until the mode honours it.
   * `target` has focus when the harness is built; `moveFocus` gives it to another target.
   */
  lockedTarget?: {
    target: VoiceTurnTarget;
    /** A message for `target` that this setup can deliver. */
    text: string;
    moveFocus: () => void;
    /** Ids of the targets that have received text so far. */
    deliveredTo: () => string[];
  };
  /**
   * A spoken message to a target that can take unsent text becomes a **Held Prompt** (ADR-0064).
   * Omit until the mode has one. `target` has focus when the harness is built.
   */
  heldPrompt?: {
    target: VoiceTurnTarget;
    /** A message for `target`. */
    text: string;
    /** Ids of the targets that were given text unsent, in their own prompt, so far. */
    prompted: () => string[];
    /** Ids of the targets that were sent text so far. */
    sent: () => string[];
    /** The composer already holds typed text. */
    typeInComposer: () => void;
    /** `target` can no longer take unsent text (e.g. its session is gone). */
    cannotTakeUnsent: () => void;
    setSendRightAway: (on: boolean) => void;
  };
}

export function describeVoiceAdapterContract(
  name: string,
  makeHarness: () => VoiceAdapterContractHarness,
): void {
  describe(`Voice Adapter contract — ${name}`, () => {
    const intentOf = (extra?: Partial<VoiceDeliveryIntent>): VoiceDeliveryIntent => ({ source: "typed", ...extra });

    it("lists its targets with unique ids and their display names", () => {
      const h = makeHarness();
      const targets = h.adapter.targets();
      expect(new Set(targets.map((t) => t.id)).size).toBe(targets.length);
      expect(targets.map((t) => t.name).sort()).toEqual([...h.targetNames].sort());
    });

    it("holds empty text without any side effect", async () => {
      const h = makeHarness();
      for (const text of ["", "   "]) {
        const result = await h.adapter.deliver(text, intentOf());
        expect(result).toMatchObject({ status: "held", reason: EMPTY_DELIVERY_REASON });
      }
      expect(h.effects()).toBe(0);
    });

    it("applies nothing for a turn that is already cancelled", async () => {
      const h = makeHarness();
      const controller = new AbortController();
      controller.abort();
      const result = await h.adapter.deliver(h.sendable.text, intentOf({ ...h.sendable.intent, signal: controller.signal }));
      expect(result).toMatchObject({ status: "failed", reason: CANCELLED_DELIVERY_REASON });
      expect(h.effects()).toBe(0);
    });

    it("delivers text it can route", async () => {
      const h = makeHarness();
      const result = await h.adapter.deliver(h.sendable.text, intentOf(h.sendable.intent));
      expect(result.status).toBe("sent");
      expect(h.effects()).toBeGreaterThan(0);
    });

    it("keeps text it cannot deliver, with the reason", async () => {
      const h = makeHarness();
      if (!h.holdable) return;
      const result = await h.adapter.deliver(h.holdable.text, intentOf(h.holdable.intent));
      expect(result.status).toBe("held");
      if (result.status !== "held") return;
      expect(result.reason.trim()).not.toBe("");
      expect(result.text.trim()).not.toBe("");
    });

    it("keeps a spoken turn in the composer when focus moved during it, sending nothing", async () => {
      const h = makeHarness();
      const locked = h.lockedTarget;
      if (!locked) return;
      locked.moveFocus();
      const result = await h.adapter.deliver(locked.text, intentOf({ source: "voice", target: locked.target, sendNow: true }));
      expect(result).toMatchObject({ status: "held", route: "composer" });
      if (result.status !== "held") return;
      expect(result.reason).toContain(locked.target.name);
      expect(locked.deliveredTo()).toEqual([]);
    });

    it("delivers to the locked target even though focus changed", async () => {
      const h = makeHarness();
      const locked = h.lockedTarget;
      if (!locked) return;
      locked.moveFocus();
      const result = await h.adapter.deliver(locked.text, intentOf({ source: "typed", target: locked.target }));
      expect(result.status).toBe("sent");
      expect(locked.deliveredTo()).toEqual([locked.target.id]);
    });

    describe("a spoken message", () => {
      const spoken = (h: VoiceAdapterContractHarness, extra?: Partial<VoiceDeliveryIntent>) =>
        h.adapter.deliver(h.heldPrompt!.text, intentOf({ source: "voice", target: h.heldPrompt!.target, ...extra }));

      it("waits, unsent, in the target's own prompt", async () => {
        const h = makeHarness();
        const held = h.heldPrompt;
        if (!held) return;
        const result = await spoken(h);
        expect(result).toMatchObject({ status: "prompted", target: held.target });
        expect(held.prompted()).toEqual([held.target.id]);
        expect(held.sent()).toEqual([]);
      });

      it("is added to the composer instead when the composer already holds typed text", async () => {
        const h = makeHarness();
        const held = h.heldPrompt;
        if (!held) return;
        held.typeInComposer();
        expect(await spoken(h)).toMatchObject({ status: "held", route: "composer" });
        expect(held.prompted()).toEqual([]);
        expect(held.sent()).toEqual([]);
      });

      it("waits in the composer, with the reason, when the target cannot take unsent text", async () => {
        const h = makeHarness();
        const held = h.heldPrompt;
        if (!held) return;
        held.cannotTakeUnsent();
        const result = await spoken(h);
        expect(result).toMatchObject({ status: "held", route: "composer" });
        if (result.status === "held") expect(result.reason.trim()).not.toBe("");
        expect(held.prompted()).toEqual([]);
      });

      it("is sent when the turn was ended with ⌘Enter", async () => {
        const h = makeHarness();
        const held = h.heldPrompt;
        if (!held) return;
        expect((await spoken(h, { sendNow: true })).status).toBe("sent");
        expect(held.sent()).toEqual([held.target.id]);
        expect(held.prompted()).toEqual([]);
      });

      it("is sent when Send Right Away is on", async () => {
        const h = makeHarness();
        const held = h.heldPrompt;
        if (!held) return;
        held.setSendRightAway(true);
        expect((await spoken(h)).status).toBe("sent");
        expect(held.sent()).toEqual([held.target.id]);
        expect(held.prompted()).toEqual([]);
      });
    });

    it("offers Live Voice tools with unique names, or none at all", async () => {
      const h = makeHarness();
      const live = h.adapter.liveTools;
      if (!live) return;
      expect(live.instructions.trim()).not.toBe("");
      expect(live.tools.length).toBeGreaterThan(0);
      expect(new Set(live.tools.map((t) => t.name)).size).toBe(live.tools.length);
      for (const tool of live.tools) expect(tool.parameters).toMatchObject({ type: "object" });
    });

    it("answers an unknown Live Voice tool without throwing", async () => {
      const h = makeHarness();
      const live = h.adapter.liveTools;
      if (!live) return;
      await expect(live.execute({ callId: "c1", name: "no_such_tool", args: {} })).resolves.toBeDefined();
    });
  });
}
