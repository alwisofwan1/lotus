import { describe, expect, it } from "vitest";
import {
  bundledPersonaSource,
  loadPersona,
  parsePersonaFile,
  personaNameForTone,
  type PersonaSource,
} from "../canvas-persona";

describe("bundled personas cover every shipped tone", () => {
  // "custom" is the one tone with no file — it is built from the user's own instructions.
  const FILE_BACKED_TONES = ["jarvis", "warm", "formal", "brisk"] as const;

  it.each(FILE_BACKED_TONES)("resolves the %s tone to a real bundled persona", (tone) => {
    // Table-driven on purpose: adding a VoiceTone without shipping its file would otherwise
    // degrade silently to raw pass-through and the picker would quietly stop working.
    const persona = loadPersona(personaNameForTone(tone), [bundledPersonaSource()]);

    expect(persona.isRaw).toBe(false);
    expect(persona.body.length).toBeGreaterThan(0);
  });

  it("defaults to the jarvis persona when no tone is set", () => {
    expect(personaNameForTone(undefined)).toBe("jarvis");
  });

  it("leaves the default tone's callouts byte-identical to the shipped phrasing", () => {
    // jarvis is the DEFAULT tone. Giving it a distinctive pool would silently change what every
    // existing user hears the moment personas are wired in — a settings change nobody made. The
    // phrasing shipped today IS the default register, so jarvis owns it verbatim; the other tones
    // are where the register becomes audible.
    const jarvis = loadPersona("jarvis", [bundledPersonaSource()]);

    expect(jarvis.callouts.en).toEqual([
      "{name} is done.",
      "{name} just finished.",
      "{name} wrapped up its task.",
      "All done from {name}.",
    ]);
    expect(jarvis.callouts.ja).toEqual([
      "{name}が完了しました。",
      "{name}の作業が終わりました。",
      "{name}が一段落つきました。",
    ]);
  });

  it("exposes the persona's callout pools so the finish channel can speak in its register", () => {
    const persona = loadPersona("jarvis", [bundledPersonaSource()]);

    expect(persona.callouts.en?.[0]).toContain("{name}");
    expect(persona.callouts.ja?.length).toBeGreaterThan(0);
  });

  it("gives a persona with no pools an empty one rather than undefined", () => {
    // Callers spread this straight into buildFinishCallout; an absent key must mean "fall back",
    // not "crash on .en of undefined".
    const persona = loadPersona("plain", [sourceOf({ plain: "---\nname: plain\n---\nBody." })]);

    expect(persona.callouts).toEqual({});
  });
});

/** A source backed by a plain record, standing in for a directory of persona files. */
const sourceOf = (files: Record<string, string>): PersonaSource => ({
  read: (name) => files[name] ?? null,
});

describe("loadPersona", () => {
  it("takes the first source that has the persona — a user fork shadows the bundled one", () => {
    const persona = loadPersona("aria", [
      sourceOf({ aria: "---\nname: aria\n---\nMy own Aria." }),
      sourceOf({ aria: "---\nname: aria\n---\nBundled Aria." }),
    ]);

    expect(persona.body).toBe("My own Aria.");
  });

  it("falls through to the next source when the first has nothing", () => {
    const persona = loadPersona("aria", [sourceOf({}), sourceOf({ aria: "---\nname: aria\n---\nBundled Aria." })]);

    expect(persona.body).toBe("Bundled Aria.");
  });

  it("prefers the declared name over the requested one, so a fork can rename itself", () => {
    const persona = loadPersona("my-aria", [sourceOf({ "my-aria": "---\nname: Aria Prime\n---\nBody." })]);

    expect(persona.name).toBe("Aria Prime");
  });

  it("resolves an unknown persona to raw pass-through rather than throwing", () => {
    // Raw is the honest floor: no register is applied and the surface keeps its own wording.
    // Throwing here would take the whole voice channel down over a typo in a settings field.
    const persona = loadPersona("nonexistent", [sourceOf({}), sourceOf({})]);

    expect(persona.isRaw).toBe(true);
    expect(persona.body).toBe("");
  });
});

describe("parsePersonaFile", () => {
  it("splits frontmatter metadata from the prompt body", () => {
    const parsed = parsePersonaFile(
      ["---", "name: aria", "ttsVoice: nova", "address: sir", "---", "You are Aria.", "", "Calm and direct."].join("\n"),
    );

    expect(parsed.meta).toEqual({ name: "aria", ttsVoice: "nova", address: "sir" });
    expect(parsed.body).toBe("You are Aria.\n\nCalm and direct.");
  });

  it("reads a list value into an array — pooled phrasings need more than one line", () => {
    const parsed = parsePersonaFile(
      ["---", "name: aria", "calloutsEn:", "  - '{name} is done.'", "  - 'All done from {name}.'", "---", "Body."].join(
        "\n",
      ),
    );

    expect(parsed.meta.calloutsEn).toEqual(["{name} is done.", "All done from {name}."]);
  });

  // A persona must never be load-blocking. Every malformed shape degrades to "this file is all
  // prompt body" rather than throwing — a broken fork should sound wrong, not break the voice.
  it.each([
    ["no frontmatter at all", "You are Aria, and nothing else."],
    ["an opening delimiter with no closing one", "---\nname: aria\nYou are Aria."],
  ])("treats %s as pure prompt body", (_case, text) => {
    const parsed = parsePersonaFile(text);

    expect(parsed.meta).toEqual({});
    expect(parsed.body).toBe(text.trim());
  });

  it("skips unparseable frontmatter lines instead of throwing", () => {
    const parsed = parsePersonaFile(["---", "name: aria", ":::garbage:::", "!!not a pair", "---", "Body."].join("\n"));

    expect(parsed.meta).toEqual({ name: "aria" });
    expect(parsed.body).toBe("Body.");
  });
});
