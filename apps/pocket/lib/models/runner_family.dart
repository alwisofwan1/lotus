/// Centralizes runner identity; transcript capabilities remain host-owned (`plans/pocket-chat-conversation-model/RESEARCH.md` §1.2).
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

  /// Normalizes known aliases and Claude-family names for consistent routing.
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
