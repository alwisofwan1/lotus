export type TranscriptLanguageIntegrity = "unknown" | "match" | "mismatch";

export function languageMismatchMessage(requestedLanguages: readonly string[]): string {
  const selected = new Set(requestedLanguages.map(primary));
  if (selected.has("id")) {
    return "Bahasa transkrip tidak sesuai dengan bahasa suara yang dipilih. Teks ditahan untuk diperiksa.";
  }
  return "The transcript language did not match the selected speech language. Text was kept for review.";
}

function primary(language: string): string {
  return language.trim().toLowerCase().split("-")[0] ?? "";
}

const LANGUAGE_MARKERS: Readonly<Record<string, readonly RegExp[]>> = {
  tr: [
    /\b(?:ve|veya|için|ile|bir|bu|da|de|ilgili|buraya|ekleyin|kullanılmayan|kısayollarını|işlemle|tanımlanmadı|geçerli|cevabım|yok)\b/giu,
  ],
};

function inferredPrimary(text: string): string | null {
  const words = text.match(/[\p{L}\p{M}]+/gu) ?? [];
  if (words.length < 4) return null;
  let best: { language: string; hits: number } | null = null;
  for (const [language, patterns] of Object.entries(LANGUAGE_MARKERS)) {
    const hits = patterns.reduce((count, pattern) => count + (text.match(pattern)?.length ?? 0), 0);
    if (!best || hits > best.hits) best = { language, hits };
  }
  return best && best.hits >= 2 ? best.language : null;
}

/**
 * Fail-safe for confident cross-language STT output. Provider metadata is authoritative when present;
 * a tiny high-precision marker set covers known legacy models that omit detected-language metadata.
 */
export function assessTranscriptLanguageIntegrity(input: {
  text: string;
  requestedLanguages: readonly string[];
  detectedLanguages: readonly string[];
}): TranscriptLanguageIntegrity {
  const requested = new Set(input.requestedLanguages.map(primary).filter(Boolean));
  if (requested.size === 0) return "unknown";
  const detected = input.detectedLanguages.map(primary).filter(Boolean);
  if (detected.length > 0) return detected.some((language) => requested.has(language)) ? "match" : "mismatch";
  const inferred = inferredPrimary(input.text);
  return inferred && !requested.has(inferred) ? "mismatch" : "unknown";
}
