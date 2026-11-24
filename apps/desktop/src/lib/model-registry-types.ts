// Model registry — shared TypeScript types.
// Mirrors the Rust structs in src-tauri/src/model_registry.rs.

export type ProviderType =
  | "claude-cli"
  | "codex-cli"
  | "qwen-cli"
  | "openai-compat"
  | "ollama";

export interface ModelEntry {
  id: string;
  label: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  vendor: string;
  /** Determines which CLI binary / HTTP client is used for this provider. */
  type: ProviderType;
  /** Built-in providers ship with Lotus and cannot be deleted. */
  builtin: boolean;
  enabled: boolean;
  /** Required for qwen-cli and openai-compat providers. */
  baseUrl?: string;
  /**
   * Plaintext API key stored in ~/.lotus/model-registry.json (chmod 0600).
   * The backend redacts this to "***" before returning it to the frontend.
   * Send "***" back to preserve the existing key; send "" to clear it.
   */
  apiKey?: string;
  defaultModel: string;
  models: ModelEntry[];
}

export interface ModelRegistry {
  activeProvider: string;
  activeModel: string;
  providers: ProviderConfig[];
}

export interface ActiveModel {
  provider: string;
  model: string;
}
