import type { DelegationFidelityFact } from "../../delegation-fidelity";

export interface DelegationFidelityFixture {
  id: string;
  language: "id" | "en" | "mixed";
  transcript: string;
  deliveredText: string;
  requiredFacts: readonly DelegationFidelityFact[];
  expectedScore: number;
  expectedMissing: readonly string[];
}

export const DELEGATION_FIDELITY_FIXTURES: readonly DelegationFidelityFixture[] = [
  {
    id: "mixed-voice-audit",
    language: "mixed",
    transcript: [
      "Kirim ke Codex: audit s2s-canvas-instructions.ts dan s2s-canvas-tool-executor.ts;",
      "analisis saja, jangan ubah kode; temukan 5 akar masalah;",
      "laporkan file:line dan prioritas P0–P2.",
    ].join(" "),
    deliveredText:
      "Audit s2s-canvas-instructions.ts and s2s-canvas-tool-executor.ts. Report five root causes.",
    requiredFacts: [
      { id: "instructions-file", label: "instructions file", allOf: [["s2s-canvas-instructions.ts"]] },
      { id: "executor-file", label: "executor file", allOf: [["s2s-canvas-tool-executor.ts"]] },
      { id: "five-findings", label: "five findings", allOf: [["5", "five"]] },
      {
        id: "analysis-only",
        label: "analysis only; no code changes",
        allOf: [
          ["analisis saja", "analysis only", "analyze only"],
          ["jangan ubah kode", "do not modify code", "do not edit code"],
        ],
      },
      { id: "file-line", label: "file:line evidence", allOf: [["file:line"]] },
      { id: "priority-range", label: "P0–P2 priority", allOf: [["p0–p2", "p0-p2"]] },
    ],
    expectedScore: 0.5,
    expectedMissing: ["analysis-only", "file-line", "priority-range"],
  },
  {
    id: "indonesian-auth-review",
    language: "id",
    transcript:
      "Minta Claude review auth.ts. Analisis saja, jangan edit kode. Laporkan risiko keamanan.",
    deliveredText: "Review auth.ts and report security risks.",
    requiredFacts: [
      { id: "auth-file", label: "auth file", allOf: [["auth.ts"]] },
      {
        id: "analysis-only",
        label: "analysis only; no code changes",
        allOf: [
          ["analisis saja", "analysis only", "analyze only"],
          ["jangan edit kode", "do not edit code", "do not modify code"],
        ],
      },
      {
        id: "security-risk",
        label: "security risks",
        allOf: [["risiko keamanan", "security risks", "security risk"]],
      },
    ],
    expectedScore: 2 / 3,
    expectedMissing: ["analysis-only"],
  },
  {
    id: "english-retry-review",
    language: "en",
    transcript:
      "Ask Codex to inspect retry.ts, do not modify files, and return exactly 3 race conditions with file:line evidence.",
    deliveredText: "Inspect retry.ts and find race conditions.",
    requiredFacts: [
      { id: "retry-file", label: "retry file", allOf: [["retry.ts"]] },
      { id: "no-modification", label: "do not modify files", allOf: [["do not modify files"]] },
      { id: "three-findings", label: "exactly three findings", allOf: [["3", "three"]] },
      { id: "race-conditions", label: "race conditions", allOf: [["race conditions"]] },
      { id: "file-line", label: "file:line evidence", allOf: [["file:line"]] },
    ],
    expectedScore: 0.4,
    expectedMissing: ["no-modification", "three-findings", "file-line"],
  },
];
