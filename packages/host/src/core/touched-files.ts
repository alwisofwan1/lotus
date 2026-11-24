const CANDIDATE_RE = /`?([A-Za-z0-9_.@~/-]+\.[A-Za-z0-9]{1,12})`?/g;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

export function extractTouchedFiles(text: string, limit = 20): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(CANDIDATE_RE)) {
    const candidate = normalizeCandidate(match[1] ?? "");
    if (!candidate) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    files.push(candidate);
    if (files.length >= limit) break;
  }

  return files;
}

function normalizeCandidate(value: string): string | null {
  const cleaned = value.replace(/[),.;:]+$/g, "");
  if (!cleaned) return null;
  if (URL_RE.test(cleaned)) return null;
  if (cleaned.startsWith("/") || cleaned.startsWith("../")) return null;
  if (cleaned.includes("/../") || cleaned.endsWith("/..")) return null;
  if (!cleaned.includes("/")) return null;
  return cleaned;
}
