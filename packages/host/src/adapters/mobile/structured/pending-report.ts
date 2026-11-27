import type { BridgeConversation } from "../../../types/provider-bridge.js";
import type { PermissionResponse } from "../../../types/permission.js";
import type { UserQuestionOption } from "../../../types/question.js";

/**
 * What `/permission` says about a cell: a question, a permission, or neither. A question is
 * reported **whole**; the old `{key,label}` prompt rides along for older phones (ADR-4).
 */
export function permissionReport(paneId: string, conversation: BridgeConversation): PermissionResponse {
  const asked = conversation.pendingQuestion?.();
  if (asked !== undefined) {
    const options: UserQuestionOption[] = asked.questions[0]?.options ?? [];
    const title = asked.questions[0]?.question ?? "";
    return {
      paneId,
      awaiting: true,
      question: asked.questions,
      prompt: {
        question: title,
        ask: "question",
        options: options.map((o) => ({ key: o.key ?? "", label: o.label, selected: false })),
      },
      readback: `${title} ${options.map((o) => `${o.key ?? ""} ${o.label}`).join(", ")}`,
    };
  }
  const pending = conversation.pendingPermission();
  if (pending === undefined) return { paneId, awaiting: false, prompt: null };
  return {
    paneId,
    awaiting: true,
    prompt: {
      question: pending.title,
      ...(pending.ask === undefined ? {} : { ask: pending.ask }),
      options: pending.options.map((o) => ({ key: o.key, label: o.label, selected: false })),
    },
    readback: `${pending.title} ${pending.options.map((o) => `${o.key} ${o.label}`).join(", ")}`,
  };
}
