/// The one table of what this app knows about a runner by its `agentType`.
///
/// **Replaces five.** Until 2026-08-27 the same fact was written in five places with four
/// different key sets: a brand colour map, a description map, a hardcoded `gates` flag per
/// runner in the summon sheet, a substring test (`provider.contains('claude')`) deciding the
/// whole key-bar layout, and the generated marks. Each was right on its own and no two
/// agreed on which runners existed. Consolidating them is item E of the coupling smells in
/// `plans/pocket-chat-conversation-model/RESEARCH.md` §1.2.
///
/// What is **not** here, on purpose: the SVG marks (`runner_marks.g.dart` is generated from
/// the vendor files and stays that way) and colours (a `Color` is UI). Both key on
/// [RunnerFamily] now rather than on a raw string, so an unknown spelling lands in one place.
///
/// Also not here: whether a runner reports a transcript. That is the host's to say, per
/// pane, through `transcriptOutlook` and `RunnerTranscriptCaps` — a phone-side table of it
/// is exactly the stale claim Fase 0 had to fix on the desktop.
enum RunnerFamily {
  claude,
  codex,
  cursor,
  gemini,
  grok,
  kimi,
  opencode,

  /// A custom runner, or one this app has never heard of. Draws with the fallbacks.
  other;

  /// Matched on the trimmed, lowercased `agentType`.
  ///
  /// `ccs` and `csp` are `claude --profile …`; a custom Claude-family runner arrives from the
  /// desktop already collapsed to `claude`, and a spelling this app does not know that still
  /// says `claude` somewhere (`claude-code`, `my-claude`) is Claude — the substring rule the
  /// key bar used, now stated once.
  static RunnerFamily of(String? agentType) {
    final key = (agentType ?? '').trim().toLowerCase();
    return switch (key) {
      'claude' || 'ccs' || 'csp' => RunnerFamily.claude,
      'codex' => RunnerFamily.codex,
      'cursor' => RunnerFamily.cursor,
      'gemini' => RunnerFamily.gemini,
      'grok' => RunnerFamily.grok,
      'kimi' => RunnerFamily.kimi,
      'opencode' => RunnerFamily.opencode,
      // A host's legacy `ccs:<account>` runner id: the claude binary on that account.
      _ when key.startsWith('ccs:') || key.contains('claude') => RunnerFamily.claude,
      _ => RunnerFamily.other,
    };
  }

  /// Runs the `claude` binary, so it takes Claude's keys, flags and permission gate.
  bool get isClaudeFamily => this == RunnerFamily.claude;

  /// Asks before acting when spawned `safe` (ADR-8). Only the Claude family has a gate
  /// Lotus can hold; every other runner is `runner_cannot` on the host.
  bool get gatesBeforeActing => isClaudeFamily;

  /// What the operator calls it, or null for a runner this app cannot name — the caller
  /// already has the host's own label for those and must not invent one.
  String? get displayName => switch (this) {
        RunnerFamily.claude => 'Claude Code',
        RunnerFamily.codex => 'Codex',
        RunnerFamily.cursor => 'Cursor',
        RunnerFamily.gemini => 'Gemini CLI',
        RunnerFamily.grok => 'Grok CLI',
        RunnerFamily.kimi => 'Kimi CLI',
        RunnerFamily.opencode => 'OpenCode',
        RunnerFamily.other => null,
      };
}
