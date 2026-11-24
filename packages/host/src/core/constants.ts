// Transport-agnostic constants. Values dictated by one adapter's protocol belong
// with that adapter, so `core/` never inherits a transport's message limits.

/** Chunk ceiling for OutputStreamer — a quarter of the 64 KB PTY ring buffer. */
export const DEFAULT_MAX_CHUNK_SIZE = 16 * 1024;

/** Default debounce window for OutputStreamer batching (ms). */
export const DEFAULT_DEBOUNCE_MS = 500;

/** Exponential backoff config for stream reconnect. */
export const RECONNECT_INITIAL_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const RECONNECT_MAX_RETRIES = 5;

/** Stream registry TTL — streams inactive beyond this are auto-evicted. */
export const STREAM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Session store TTL — attachments older than this are pruned on load. */
export const SESSION_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
