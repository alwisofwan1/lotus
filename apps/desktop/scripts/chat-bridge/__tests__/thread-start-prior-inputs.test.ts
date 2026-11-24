import { describe, expect, it } from "vitest";

import { threadStartParams } from "../protocol";

describe("thread/start priorInputs", () => {
  const base = { threadId: "t", cwd: "/w/repo" };

  it("takes the host's stored inputs, keeping only what the read rules need", () => {
    const stored = { kind: "file", path: "/p/spec.pdf", name: "spec.pdf", mimeType: null, sizeBytes: 3 };
    const parsed = threadStartParams.parse({ ...base, priorInputs: [{ text: "read `/x/a.md`", attachments: [stored] }] });
    expect(parsed.priorInputs).toEqual([{ text: "read `/x/a.md`", attachments: [{ kind: "file", path: "/p/spec.pdf" }] }]);
  });

  it("is empty for a fresh chat", () => {
    expect(threadStartParams.parse(base).priorInputs).toEqual([]);
  });
});
