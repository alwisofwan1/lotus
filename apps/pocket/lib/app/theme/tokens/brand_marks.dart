import 'dart:ui';

import '../../../models/runner_family.dart';

/// A runner's own brand colour, or null for a runner Lotus has no brand for.
/// Fixed identity, not a theme slot; the invariant test checks it on every ground.
Color? brandColorFor(String agentType) => switch (RunnerFamily.of(agentType)) {
      RunnerFamily.claude => const Color(0xFFDA7756),
      RunnerFamily.codex => const Color(0xFF10A37F),
      RunnerFamily.cursor => const Color(0xFFF7F7F4),
      RunnerFamily.gemini => const Color(0xFF4285F4),
      RunnerFamily.grok => const Color(0xFFFFFFFF),
      RunnerFamily.kimi => const Color(0xFFAC33F2),
      RunnerFamily.opencode => const Color(0xFF8B7AB8),
      RunnerFamily.other => null,
    };
