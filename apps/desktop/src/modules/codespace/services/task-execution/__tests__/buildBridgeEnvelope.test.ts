import { describe, it, expect } from "vitest";
import { buildBridgeEnvelope, BRIDGE_KNOWLEDGE_CAP_BYTES } from "../buildBridgeEnvelope";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";

const baseTask: BridgeTask = {
  id: "task_42",
  workspaceId: "ws_1",
  title: "Wire OAuth",
  goal: "Token exchange + refresh.",
  knowledge: "stytch SDK; 12h TTL.",
  status: "todo",
  priority: "high",
  assignees: ["@codex"],
  createdAt: 1,
  updatedAt: 2,
};

describe("buildBridgeEnvelope", () => {
  it("emits a self-contained <bridge-task> XML element with task id + workspace attrs", () => {
    const out = buildBridgeEnvelope(baseTask);
    expect(out.startsWith("<bridge-task")).toBe(true);
    expect(out).toContain('id="task_42"');
    expect(out).toContain('workspace="ws_1"');
    expect(out.trim().endsWith("</bridge-task>")).toBe(true);
  });

  it("includes <title>, <goal>, <knowledge>, and <assignees> sub-nodes", () => {
    const out = buildBridgeEnvelope(baseTask);
    expect(out).toContain("<title>Wire OAuth</title>");
    expect(out).toContain("<goal>Token exchange + refresh.</goal>");
    expect(out).toContain("<knowledge>stytch SDK; 12h TTL.</knowledge>");
    expect(out).toContain("<assignees>@codex</assignees>");
  });

  it("escapes XML-special characters in user-controlled fields", () => {
    const out = buildBridgeEnvelope({ ...baseTask, title: "A & <b> \"c\" 'd'" });
    expect(out).toContain("<title>A &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;</title>");
  });

  it("omits empty optional fields entirely (no empty tags)", () => {
    const out = buildBridgeEnvelope({ ...baseTask, knowledge: "", assignees: [] });
    expect(out).not.toContain("<knowledge>");
    expect(out).not.toContain("<assignees>");
  });

  it("truncates knowledge above the bridge cap with a clear marker", () => {
    const big = "x".repeat(BRIDGE_KNOWLEDGE_CAP_BYTES + 4_000);
    const out = buildBridgeEnvelope({ ...baseTask, knowledge: big });
    expect(out).toContain("[truncated");
    const knowledgeChunk = out.split("<knowledge>")[1]?.split("</knowledge>")[0] ?? "";
    expect(Buffer.byteLength(knowledgeChunk, "utf8")).toBeLessThan(big.length);
  });

  it("includes optional ctx attrs (cwd, workspaceLabel) when provided", () => {
    const out = buildBridgeEnvelope(baseTask, { cwd: "/repo/app", workspaceLabel: "lotus" });
    expect(out).toContain('cwd="/repo/app"');
    expect(out).toContain('workspace-label="lotus"');
  });
});
