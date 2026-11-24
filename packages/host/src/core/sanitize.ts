/**
 * Strips sensitive `key=value` pairs from a free-form argument string before
 * audit-logging it. Recognises `password|token|key|secret|apikey` (any case).
 */
export function sanitizeArgs(raw: string): string {
  return raw.replace(/\b(password|token|key|secret|apikey)=\S+/gi, "$1=***");
}
