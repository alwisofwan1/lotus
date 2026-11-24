import { describe, expect, it } from "vitest";

import { copyProgress, draftFromPath, formatBytes, isCopy, linkIsDown, MAX_IMAGE_BYTES, MAX_REMOTE_FILE_BYTES, remoteProblem } from "../attachments";

const file = (name: string, size = 10, isDirectory = false) => ({ path: `/u/${name}`, name, size, isDirectory });

describe("draftFromPath", () => {
  it("makes images pictures and anything else a file sent by path", () => {
    expect(draftFromPath(file("Shot.PNG")).attachment).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(draftFromPath(file("notes.pdf"))).toMatchObject({ attachment: { kind: "file", mimeType: null }, problem: null });
  });

  it("says why a file cannot go", () => {
    expect(draftFromPath(file("big.jpg", MAX_IMAGE_BYTES + 1)).problem).toBe("Too large · max 5 MB");
    expect(draftFromPath(file("phone.heic")).problem).toBe("Not supported · PNG, JPEG, GIF or WebP");
    expect(draftFromPath(file("src", 0, true)).problem).toBe("A folder · attach files");
    // Any size is fine for a file Claude reads by path.
    expect(draftFromPath(file("log.txt", MAX_IMAGE_BYTES * 4)).problem).toBeNull();
  });
});

it("formatBytes", () => {
  expect([formatBytes(512), formatBytes(2048), formatBytes(5 * 1024 * 1024), formatBytes(null)]).toEqual(["512 B", "2 KB", "5 MB", ""]);
});

describe("on another machine (ADR-0069)", () => {
  it("copies files up to 10 MB", () => {
    const big = draftFromPath(file("dump.log", MAX_REMOTE_FILE_BYTES + 1)).attachment;
    expect(remoteProblem(big)).toBe("Too large · max 10 MB on another machine");
    expect(remoteProblem(draftFromPath(file("notes.txt")).attachment)).toBeNull();
  });

  it("knows a file already on the machine is not a copy", () => {
    const there = { kind: "file" as const, path: "/srv/app/a.ts", name: "a.ts", mimeType: null, sizeBytes: 3, remote: "/srv/app/a.ts" };
    expect(isCopy(there)).toBe(false);
    expect(isCopy({ ...there, path: "/Users/me/a.ts" })).toBe(true);
    expect(isCopy({ ...there, remote: undefined })).toBe(false);
  });

  it("tells a link that is down from a refusal", () => {
    expect(linkIsDown("waiting for vps · connection refused")).toBe(true);
    expect(linkIsDown("a.txt arrived damaged; send it again")).toBe(false);
  });
});

describe("copyProgress", () => {
  const draft = (size: number | null, pending: string | null, progress?: number | null) => ({
    id: String(size),
    attachment: { kind: "file" as const, path: "/u/a", name: "a", mimeType: null, sizeBytes: size },
    problem: null,
    pending,
    progress,
  });

  it("weighs each copy by its size and leaves finished files out", () => {
    expect(copyProgress([draft(300, "Copying 100%", 100), draft(100, "Copying 0%", 0), draft(900, null)])).toBe(75);
  });

  it("is null when no copy can say how far it is", () => {
    expect(copyProgress([])).toBeNull();
    expect(copyProgress([draft(10, "Waiting for the machine…", null), draft(10, "Copying…")])).toBeNull();
  });
});
