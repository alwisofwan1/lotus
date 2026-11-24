// One API thread (#288): a text-only chat with an OpenAI-compatible `/chat/completions` endpoint
// (DeepSeek, Sumopod, OpenRouter, Ollama). No process and no session on the provider's side: the
// conversation lives here, seeded by the host from the stored thread, and each turn sends all of it.

import { ApiTranslator, httpError, sseData } from "../../src/modules/chat/providers/api/translate";
import type { ThreadEvent } from "../../src/modules/chat/domain/thread-event";
import type { AttachmentParams } from "./protocol";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ApiSessionOptions {
  threadId: string;
  cwd: string;
  baseUrl: string;
  apiKey: string | null;
  providerName: string;
  model: string | undefined;
  history: ChatMessage[];
  translator: ApiTranslator;
  emit: (events: ThreadEvent[]) => void;
  onEnded: (error: Error | null) => void;
}

export class ApiSession {
  readonly providerSessionId = null;
  private model: string | undefined;
  private readonly history: ChatMessage[];
  private running: AbortController | null = null;
  private ended = false;

  constructor(private readonly options: ApiSessionOptions) {
    this.model = options.model;
    this.history = [...options.history];
  }

  start(): void {
    const { translator, emit, apiKey, cwd } = this.options;
    emit(translator.configured(this.model ?? null, apiKey !== null, cwd));
  }

  async send(text: string, _uuid: string, attachments: AttachmentParams[]): Promise<void> {
    if (this.running) throw new Error("This chat answers one message at a time. Wait for the answer, or stop it, then send.");
    if (attachments.length > 0) throw new Error("API chats take text only; remove the attachments.");
    if (!this.model) throw new Error("Pick a model for this chat first.");
    this.history.push({ role: "user", content: text });
    void this.run(this.model);
  }

  async interrupt(): Promise<void> {
    this.running?.abort();
  }

  async setModel(model: string): Promise<void> {
    this.model = model;
  }

  stop(): void {
    if (this.ended) return;
    this.ended = true;
    this.running?.abort();
    this.options.onEnded(null);
  }

  private async run(model: string): Promise<void> {
    const { baseUrl, apiKey, providerName, translator, emit } = this.options;
    const abort = new AbortController();
    this.running = abort;
    emit(translator.turnStarted(`turn-${crypto.randomUUID()}`, Date.now()));
    let error: string | null = null;
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages: this.history, stream: true, stream_options: { include_usage: true } }),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) throw new Error(httpError(providerName, response.status, await response.text()));
      const decoder = new TextDecoder();
      let buffer = "";
      const reader = response.body.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        buffer += decoder.decode(chunk.value, { stream: true });
        const { data, rest } = sseData(buffer);
        buffer = rest;
        for (const payload of data) {
          const json = JSON.parse(payload) as { error?: { message?: string } };
          if (json.error) throw new Error(`${providerName}: ${json.error.message ?? JSON.stringify(json.error)}`);
          emit(translator.chunk(json));
        }
      }
    } catch (caught) {
      if (!abort.signal.aborted) error = caught instanceof Error ? caught.message : String(caught);
    }
    this.running = null;
    const { events, answer } = translator.turnEnded(error, Date.now());
    if (answer) this.history.push({ role: "assistant", content: answer });
    // A failed turn is not part of the conversation: the provider never answered it.
    else if (error) this.history.pop();
    emit(events);
  }
}
