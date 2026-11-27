import 'dart:ui';

import '../../../models/runner_family.dart';

/// A runner's own brand colour for a ground of [brightness], or null for an unknown runner.
/// Fixed identity, not a theme slot; the invariant test checks it on every registered ground.
Color? brandColorFor(String agentType, Brightness brightness) {
  final family = RunnerFamily.of(agentType);
  return brightness == Brightness.dark ? _onDark[family] : _onLight[family];
}

const Map<RunnerFamily, Color> _onDark = {
  RunnerFamily.claude: Color(0xFFDA7756),
  RunnerFamily.codex: Color(0xFF10A37F),
  RunnerFamily.cursor: Color(0xFFF7F7F4),
  RunnerFamily.gemini: Color(0xFF4285F4),
  RunnerFamily.grok: Color(0xFFFFFFFF),
  RunnerFamily.kimi: Color(0xFFAC33F2),
  RunnerFamily.opencode: Color(0xFF8B7AB8),
};

// Same hues, deep enough for 3:1 on a light raised surface; Cursor and Grok go dark.
const Map<RunnerFamily, Color> _onLight = {
  RunnerFamily.claude: Color(0xFFB4532F),
  RunnerFamily.codex: Color(0xFF0B7C60),
  RunnerFamily.cursor: Color(0xFF26251E),
  RunnerFamily.gemini: Color(0xFF1A62D6),
  RunnerFamily.grok: Color(0xFF000000),
  RunnerFamily.kimi: Color(0xFF9A22E0),
  RunnerFamily.opencode: Color(0xFF6E5E9E),
};
