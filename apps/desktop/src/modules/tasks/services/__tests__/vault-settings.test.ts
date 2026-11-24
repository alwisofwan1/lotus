import { describe, expect, it } from "vitest";
import {
  canConnectVault,
  describeVaultProbe,
  resolveVaultSettings,
} from "@/modules/tasks/services/vault-settings";
import type { ClaudeSettings } from "@/modules/settings/types";

describe("reading the vault path out of settings", () => {
  const withVault = (vault: unknown) => ({ vault }) as unknown as ClaudeSettings;

  it("reads a path somebody set", () => {
    expect(resolveVaultSettings(withVault({ path: "/Users/a/vault" })).path).toBe("/Users/a/vault");
  });

  it("treats a missing key, a null file and a wrong type as no vault", () => {
    // This file is written by users, by older builds, and by whatever else edits ~/.claude. None
    // of those are errors worth throwing on boot; they are just not a vault path.
    expect(resolveVaultSettings(undefined).path).toBe("");
    expect(resolveVaultSettings(null).path).toBe("");
    expect(resolveVaultSettings({} as ClaudeSettings).path).toBe("");
    expect(resolveVaultSettings(withVault({ path: 42 })).path).toBe("");
    expect(resolveVaultSettings(withVault("/not/an/object")).path).toBe("");
  });

  it("treats a path of only whitespace as no vault", () => {
    // Pasting into the field and clearing it leaves "   ", and a path made of spaces would be
    // probed, fail, and report an error for a vault nobody asked for.
    expect(resolveVaultSettings(withVault({ path: "   " })).path).toBe("");
  });

  it("trims a pasted path", () => {
    expect(resolveVaultSettings(withVault({ path: "  /Users/a/vault  " })).path).toBe(
      "/Users/a/vault",
    );
  });
});

describe("when connecting is allowed", () => {
  it("refuses until a path has actually been read", () => {
    expect(canConnectVault({ kind: "unset" })).toBe(false);
    expect(canConnectVault({ kind: "failed", reason: "no such directory: /x" })).toBe(false);
  });

  /*
    A folder with a `tickets/` directory and nothing in it is a real vault that happens to be
    empty — tickets arrive later. Refusing it would make the button argue with a path that is
    already correct.
  */
  it("allows a vault that reads, even when it holds nothing yet", () => {
    expect(canConnectVault({ kind: "read", ticketCount: 0 })).toBe(true);
    expect(canConnectVault({ kind: "read", ticketCount: 78 })).toBe(true);
  });
});

describe("saying what was found at the vault path", () => {
  it("tells somebody with an empty field what to do, not what is missing", () => {
    // They opened the field; they know there is no vault yet. Reporting that back is noise.
    expect(describeVaultProbe({ kind: "unset" })).toEqual({
      tone: "neutral",
      message: "Pick a folder to check it.",
    });
  });

  it("answers with the number it read", () => {
    expect(describeVaultProbe({ kind: "read", ticketCount: 78 })).toEqual({
      tone: "ok",
      message: "78 tickets read.",
    });
  });

  it("counts one ticket in the singular", () => {
    expect(describeVaultProbe({ kind: "read", ticketCount: 1 }).message).toBe("1 ticket read.");
  });

  /*
    A folder that IS a vault but holds nothing readable is not a failure — it is a true answer
    that happens to be zero, and saying "could not read the vault" would send someone fixing a
    path that is already right.
  */
  it("separates an empty tickets folder from a broken path", () => {
    expect(describeVaultProbe({ kind: "read", ticketCount: 0 })).toEqual({
      tone: "warn",
      message: "No tickets found. Files in tickets/ need a ticket: field in their frontmatter.",
    });
  });

  it("repeats the reader's own sentence rather than inventing one", () => {
    // The reader already names the path and what was wrong with it; rewording it here would be a
    // second vocabulary for the same fact, and the vaguer of the two.
    expect(describeVaultProbe({ kind: "failed", reason: "no such directory: /typo/vault" })).toEqual({
      tone: "error",
      message: "no such directory: /typo/vault",
    });
  });
});
