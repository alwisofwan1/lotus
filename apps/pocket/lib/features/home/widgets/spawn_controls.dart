import 'package:flutter/material.dart';
import '../../../models/runner_family.dart';

import '../../../app/theme/app_tokens.dart';
import '../../../models/bootstrap.dart';
import '../../shared/glyphs.dart';
import '../../shared/runner_mark.dart';
import '../../shared/tactile.dart';
import '../spawn_choice.dart';
import 'runner_sheet.dart';

/// A runner the composer can offer: what to call it, and what to name in the request.
///
/// **This used to be a constant list of three and that was wrong in both directions.**
/// On the machine it was measured against it offered `gemini`, which was not installed,
/// and it could not offer `Pi` or `acme`, which were — a custom runner is a name and
/// a command the operator invented, and only that machine's registry knows it.
///
/// So the list comes from the host now ([HostRunner]), and [fallback] is what a host
/// too old to say gets: the two runners every Lotus machine has had. Never an empty
/// picker, which would read as *your machine has no agents on it*.
class SpawnRunner {
  const SpawnRunner(
    this.id, {
    required this.label,
    required this.gates,
    this.models = const [],
    this.efforts = const [],
    this.permissions = const [],
    this.profiles = const [],
    this.headless = false,
    this.terminal = true,
    this.chatInTerminal = true,
  });

  /// Whether this host can run it with no terminal at all (`tui: false`). Decided per host
  /// and per runner where the runner list is built, never from the id alone: the host says
  /// `structured-spawn`, and only Codex has a structured mode today.
  final bool headless;

  /// Whether a terminal cell of this runner would have a Chat page. False for codex, whose
  /// steps only reach Lotus over its bridge — see [SpawnChoice.resting].
  final bool chatInTerminal;

  /// Whether this runner can be started with a terminal at all. False for a provider the host
  /// reaches only through a bridge (`cursor`): the sheet then rests on Chat and never offers a
  /// terminal the spawn would fail to give it.
  final bool terminal;

  /// What the request names — `claude`, or `custom-acme`.
  final String id;

  /// What the operator sees. Equal to [id] for native runners, and the operator's own
  /// word for a custom one.
  final String label;

  /// Whether this runner has a permission gate to be asked for at all. `codex` and
  /// friends have none (`agent-gating.ts` calls it `runner_cannot`), so no posture is
  /// claimed on their behalf.
  final bool gates;

  /// What `--model` may be set to, as the host advertised it (`spawn-tuning`). Empty
  /// from an older host, a runner Lotus does not know the flags of, or a runner whose own
  /// command already fixes one — and the sheet then ends at the runner's name. A custom
  /// runner is not automatically one of those: a second-account `claude` wrapper carries
  /// the same picker the native runner does.
  final List<RunnerModel> models;

  /// The runner's own effort scale, lowest first. Empty: no slider.
  final List<String> efforts;

  /// The stops this runner's permission scale offers, least free first. Empty: no control —
  /// the host either is older than the scale or cannot honour a posture on this runner, and
  /// either way a brake with nothing on the other end must not be drawn (ADR-14).
  final List<RunnerPermission> permissions;

  /// The accounts this runner can run as on that machine (`runners[].profiles`). Empty: no picker.
  final List<RunnerProfile> profiles;

  /// Whether picking this runner opens a second step at all.
  bool get tunable => models.isNotEmpty || efforts.isNotEmpty || permissions.isNotEmpty || profiles.isNotEmpty || headless;

  /// The model alias the picker rests on: what the host marked, or the first it advertised
  /// when it marked none. Null when this runner has no picker at all.
  ///
  /// Resolved here rather than left to *absence* on the wire — see [SpawnRunnerView.modelAt]
  /// for the phone that showed `sonnet` and spawned `opus`.
  String? get restingModel {
    for (final m in models) {
      if (m.isDefault) return m.id;
    }
    return models.isEmpty ? null : models.first.id;
  }

  /// Where the permission knob rests, for a cell born with a terminal or without one.
  ///
  /// **Two answers because Codex genuinely has two**, and it has had them since before this
  /// scale existed: a Codex in a terminal is launched bypassing everything, a headless one is
  /// started asking. Resting a headless session on *never asks* would throw away the only
  /// reason it can put an approval in front of this phone. Every other runner marks one stop
  /// and gets the same answer either way.
  ///
  /// Null when this runner advertises no scale at all.
  RunnerPermission? restingPermission({required bool headless}) {
    if (permissions.isEmpty) return null;
    if (headless) {
      for (final p in permissions) {
        if (p.isDefaultHeadless) return p;
      }
    }
    for (final p in permissions) {
      if (p.isDefault) return p;
    }
    // A host that marked none still gets a knob position rather than none: the least free
    // stop, because an unmarked scale is a host being vague about safety and this is the
    // reading that cannot hurt.
    return permissions.first;
  }

  /// Whether this names a runner the host did not describe, which is what decides
  /// between sending it as a provider and sending it as a runner id.
  bool get isCustom => id.startsWith('custom-');

  factory SpawnRunner.of(HostRunner runner, {bool headless = false}) => SpawnRunner(
        runner.id,
        label: runner.name,
        gates: runner.gates,
        models: runner.models,
        efforts: runner.efforts,
        permissions: runner.permissions,
        profiles: runner.profiles,
        headless: headless,
        terminal: runner.terminal,
        chatInTerminal: runner.chatInTerminal,
      );

  /// For a host that named none. Deliberately shorter than the old constant: these two
  /// are the runners Lotus itself has always shipped against, and guessing at a third
  /// is how the list came to offer something that was not installed.
  static final List<SpawnRunner> fallback = [
    SpawnRunner('claude', label: 'claude', gates: RunnerFamily.claude.gatesBeforeActing),
    SpawnRunner('codex', label: 'codex', gates: RunnerFamily.codex.gatesBeforeActing),
  ];
}

/// The one choice above the field when the composer is starting an agent rather than
/// talking to one: which runner. A button that **names** the choice, and opens the sheet
/// that explains the options ([showRunnerSheet]).
///
/// **It was a row of pills until 2026-08-12, and the mockup is right that it should not be**
/// (`design/revamp-modern.html` M4). A pill holds one word, so the row offered a choice
/// without ever saying what was being chosen: `claude` and `codex` looked interchangeable
/// there, while one asks before acting and the other never does. A pill row also grows with
/// the machine — eight runners scrolled sideways inside a slot 8px from the composer chip.
///
/// **The permission posture was a second row here and is not any more (2026-08-09).**
/// It offered `ASKS FIRST · yes / no`, and it went because a screen read at arm's
/// length should ask one question, not two. What did **not** go is the posture itself:
/// a cell born from the phone is still born `safe` wherever its runner can gate — see
/// [SpawnRunner.gates] and the composer that reads it. That default is not a shrug, it
/// is the only coherent one here: a gated cell asks by raising `needs-input`, and the
/// phone is the thing standing by to answer. An ungated cell is still a spawn away on
/// the machine, where the choice belongs to someone sitting in front of it.
class SpawnControls extends StatelessWidget {
  const SpawnControls({
    required this.choice,
    required this.runners,
    required this.onChoice,
    required this.projectPath,
    super.key,
  });

  /// What would be born: the runner, and whatever was moved off its defaults. The
  /// button prints all of it (`claude · sonnet · high`), because this chip is the last
  /// place the whole choice is visible before the send button.
  final SpawnChoice choice;

  /// What this project's host says it can launch, in the host's own order.
  final List<SpawnRunner> runners;

  final void Function(SpawnChoice choice) onChoice;

  /// Named in the sheet's header, so the operator reads *where* before choosing *what*.
  final String projectPath;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Align(
      alignment: Alignment.centerRight,
      child: Semantics(
        button: true,
        // Ia menyebut pekerjaannya, bukan bentuknya: label yang berbunyi nama runner akan
        // membuat pembaca layar mengumumkan pilihan yang sedang berlaku sebagai perintah.
        label: 'Choose a runner',
        child: Material(
          color: t.raise,
          borderRadius: BorderRadius.circular(999),
          child: InkWell(
            onTap: () async {
              Tactile.chose();
              final picked = await showRunnerSheet(
                context,
                runners: runners,
                projectPath: projectPath,
                current: choice,
              );
              if (picked != null) onChoice(picked);
            },
            borderRadius: BorderRadius.circular(999),
            // Isinya dikecualikan dari semantik seluruhnya, dan itu diukur hari ini di
            // tempat lain: tanpa ini node tombolnya berlabel `Choose a runner\nclaude` —
            // pembaca layar mengumumkan pilihan yang berlaku sebagai bagian dari perintah,
            // dan nama runner-nya sudah dibacakan lagi di dalam sheet.
            child: ExcludeSemantics(
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 36),
                child: Padding(
                  padding: const EdgeInsets.only(left: 10, right: 8),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      RunnerMarkGlyph(
                        agentType: choice.runner.isCustom ? choice.runner.label : choice.runner.id,
                        color: t.dim,
                        size: 13,
                      ),
                      const SizedBox(width: 7),
                      Flexible(
                        child: Text(
                          choice.summary,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: t.mono.copyWith(fontSize: 12, color: t.text),
                        ),
                      ),
                      const SizedBox(width: 5),
                      Chevron(color: t.muted, size: 10),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
