export type S2sEndVoiceIntent =
  | { kind: "end"; phrase: string }
  | { kind: "none" };

const FILLER_PREFIX =
  /^(ok|okay|oke|baik|ya|yeah|yep|sip|alright|all right|please|tolong|lotus|thanks|thank you|thankyou|thx|ty|makasih|terima kasih|matur nuwun)[\s,.:;!-]+/i;

const TARGETED_AGENT_PATTERNS = [
  /\b(tell|ask|message|say to|send to)\s+\S+\s+to\s+go to sleep\b/i,
  /\b(suruh|minta|bilang ke|kirim ke)\s+\S+\s+(tidur|untuk tidur)\b/i,
];

const END_PHRASES = [
  "end live voice",
  "stop live voice",
  "close live voice",
  "turn off live voice",
  "stop listening",
  "go to sleep",
  "go to slepp",
  "sleep now",
  "lotus sleep",
  "matikan live voice",
  "akhiri live voice",
  "berhenti mendengarkan",
  "berhenti dengar",
  "tidur dulu",
  "sudah cukup",
  "udah cukup",
  "cukup dulu",
  "cukup segini",
  "selesai dulu",
  // Natural sign-offs (used as a deterministic backstop to the model-driven end_conversation tool).
  "bye",
  "bye bye",
  "goodbye",
  "good bye",
  "see you",
  "see ya",
  "dadah",
  "da da",
  "dah dulu",
  "sampai jumpa",
  "udahan",
  "udah dulu",
  "sudah dulu",
  "sudah selesai",
  "udah selesai",
  "thats all",
  "that is all",
  "thats it",
  "that is it",
  "we are done",
  "were done",
  "segitu aja",
  "segitu dulu",
  "gitu aja",
  "itu aja",
] as const;

function normalizeTranscript(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFillers(text: string): string {
  let current = text;
  for (let i = 0; i < 4; i += 1) {
    const next = current.replace(FILLER_PREFIX, "").trim();
    if (next === current) return current;
    current = next;
  }
  return current;
}

export function detectS2sEndVoiceIntent(transcript: string): S2sEndVoiceIntent {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) return { kind: "none" };
  if (TARGETED_AGENT_PATTERNS.some((pattern) => pattern.test(normalized))) return { kind: "none" };

  const withoutFillers = stripFillers(normalized);
  // Prefer the longest matching phrase so "bye bye" wins over its "bye" prefix.
  let best: string | null = null;
  for (const phrase of END_PHRASES) {
    if (withoutFillers === phrase || withoutFillers.startsWith(`${phrase} `)) {
      if (best === null || phrase.length > best.length) best = phrase;
    }
  }
  return best === null ? { kind: "none" } : { kind: "end", phrase: best };
}
