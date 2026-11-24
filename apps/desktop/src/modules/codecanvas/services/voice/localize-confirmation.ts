/**
 * Localized spoken confirmations for the fallback (keyless) voice channel.
 *
 * The Intent Registry's spoken templates are English gerunds ("Spawning a Claude agent", "Closing
 * everything"). With a BYOK NL key the composer rephrases them naturally in the user's language, but
 * WITHOUT a key the composer fast-rejects and the raw template is spoken. English stays canonical:
 * `localizeConfirmation(batch, "en")` returns the existing {@link summarizeResolutions} output
 * byte-for-byte. Japanese is rendered here from each resolution's language-neutral
 * {@link SpokenAction} descriptor, so a Japanese user hears natural Japanese with no model in the
 * loop. (Indonesian is intentionally NOT a spoken-reply language — see `detectSpeechLanguage`.)
 * Pure and deterministic.
 */
import { summarizeResolutions, type NlResolution, type SpokenAction } from "../canvas-nl-command";
import type { SpeechLanguage } from "./speak-composer";

/** A run of consecutive same-runner spawns, counted (mirrors summarizeResolutions' grouping). */
interface SpawnRun {
  runner: string;
  count: number;
}

/** Render one spawn segment (already coalesced per runner) as a single natural Japanese sentence. */
function renderSpawnJa(runs: SpawnRun[]): string {
  const clauses = runs.map((r) => (r.count === 1 ? `${r.runner}エージェントを` : `${r.runner}エージェントを${r.count}つ`));
  return `${clauses.join("、")}用意しました。`;
}

/** Render a single non-spawn action as a natural, past-tense Japanese confirmation. */
function renderOneJa(a: Exclude<SpokenAction, { kind: "spawn" }>): string {
  switch (a.kind) {
    case "create":
      return `${a.nodeType}ノードを作成しました。`;
    case "arrange":
      return "キャンバスを整えました。";
    case "focus":
      return `${a.target}にフォーカスしました。`;
    case "dispatch":
      return `${a.target}に指示を送りました。`;
    case "say_to_agent":
      return `${a.target}に伝えました。`;
    case "close":
      return `${a.target}を閉じました。`;
    case "close_all":
      return "すべて閉じました。";
    case "run_task":
      return `${a.target}のタスクを実行しました${a.team ? "（チームで）" : ""}。`;
    case "open_browser":
      return a.target ? `${a.target}のブラウザを切り替えました。` : "ブラウザを開きました。";
    case "navigate_browser":
      return `${a.target}を${a.url}に移動しました。`;
    case "recover":
      return `${a.target}を復旧しました。`;
    case "make_lead":
      return `${a.target}をリーダーにしました。`;
    case "switch_project":
      return `${a.target}に切り替えました。`;
    case "open_page":
      return a.page === "settings" ? "設定を開きました。" : "キャンバス一覧を開きました。";
    case "new_project":
      return "新しいプロジェクトを作成しました。";
    case "close_project":
      return a.target ? `${a.target}を閉じました。` : "現在のプロジェクトを閉じました。";
  }
}

/** Walk the actions, coalescing consecutive same-runner spawns, and render each Japanese segment. */
function renderSegmentsJa(actions: SpokenAction[]): string[] {
  const segs: string[] = [];
  for (let i = 0; i < actions.length; ) {
    const a = actions[i];
    if (a.kind === "spawn") {
      const runs: SpawnRun[] = [];
      for (; i < actions.length && actions[i].kind === "spawn"; i++) {
        const runner = (actions[i] as { kind: "spawn"; runner: string }).runner;
        const last = runs[runs.length - 1];
        if (last && last.runner === runner) last.count += 1;
        else runs.push({ runner, count: 1 });
      }
      segs.push(renderSpawnJa(runs));
      continue;
    }
    segs.push(renderOneJa(a));
    i++;
  }
  return segs;
}

/**
 * The spoken confirmation for a resolved batch, in the given language. English is the canonical
 * {@link summarizeResolutions} output; Japanese is rendered from the structured descriptors. Falls
 * back to the English canonical if any resolution lacks a descriptor (defensive — an intent added
 * without a `spoken` mapping should degrade to today's behavior, never speak nothing).
 */
export function localizeConfirmation(batch: NlResolution[], language: SpeechLanguage): string {
  if (language === "en") return summarizeResolutions(batch).speak;
  const actions = batch.map((r) => r.spoken).filter((s): s is SpokenAction => s !== undefined);
  if (actions.length !== batch.length) return summarizeResolutions(batch).speak;
  // Japanese sentences already end in 。 — concatenate with no separator.
  return renderSegmentsJa(actions).join("");
}
