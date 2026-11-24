// Default registry state and event constant.
// Mirrors default_registry() in src-tauri/src/model_registry.rs.

import { MODEL_DEFAULTS } from "@/config/models/catalog";
import { getCodeChatModelOptions } from "@/config/models/presets";
import type { ModelRegistry } from "@/lib/model-registry-types";

const CLAUDE_MODELS = getCodeChatModelOptions("claude").map((model) => ({ id: model.value, label: model.label }));
const CODEX_MODELS = getCodeChatModelOptions("codex").map((model) => ({ id: model.value, label: model.label }));

export const MODEL_REGISTRY_CHANGED_EVENT = "lotus:model-registry-changed";

export const DEFAULT_REGISTRY: ModelRegistry = {
  activeProvider: "claude",
  // From the catalog, not a literal: this file mirrors `default_registry()` in Rust, and a
  // hardcoded id here is how the two drifted onto a retired model.
  activeModel: MODEL_DEFAULTS.teamBuilderMember,
  providers: [
    {
      id: "claude",
      name: "Claude",
      vendor: "Anthropic",
      type: "claude-cli",
      builtin: true,
      enabled: true,
      defaultModel: MODEL_DEFAULTS.codechat.claude,
      models: CLAUDE_MODELS,
    },
    {
      id: "codex",
      name: "Codex",
      vendor: "OpenAI",
      type: "codex-cli",
      builtin: true,
      enabled: false,
      defaultModel: MODEL_DEFAULTS.codechat.codex,
      models: CODEX_MODELS,
    },
  ],
};
