import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../models/bootstrap.dart';
import '../../shared/glyphs.dart';
import '../../shared/runner_mark.dart';
import '../permission_words.dart';
import '../spawn_choice.dart';
import '../../shared/encrypted_text.dart';
import 'start_button.dart';
import 'summon_controls.dart';
import 'scale_track.dart';
import 'spawn_runner_view.dart';

/// The second step of the runner sheet: what to set on the runner just picked.
///
/// Reached only for a runner the host described as tunable (`SpawnRunner.tunable`) —
/// a runner with nothing to set is chosen in one tap, exactly as before this step
/// existed, so an older host never sees a screen it cannot honour (ADR-14).
///
/// Three controls at most, top to bottom in the order they matter: which model, how hard it
/// thinks, how free it acts. Each is drawn only when the host said there is a choice to make.
/// Everything is resolved into one [SpawnChoice] on *Start*; nothing is sent from here.
///
/// **The posture was one tappable italic line until 2026-08-27, and it could only ever have
/// been.** A switch hidden inside a sentence holds two values, so the sheet offered `asks
/// first` or `does not` while `claude --permission-mode` was taking six. It is a track now,
/// for the same reason THINKING is one: permission *is* an ordered scale — plan, manual,
/// accept edits, bypass — running from *may change nothing* to *may do anything*.
///
/// The sentence did not go. It stopped being the control and became the control's caption,
/// which is also why it moved out from under *Start*: it sat there because it was the only
/// posture affordance on the screen and belonged near the commit. A caption belongs under the
/// thing it captions. What that leaves is *Start* as the last thing before the commit, and
/// [permissionBlurb] free to say something different for each stop instead of two things
/// forever.
class SummonStep extends StatefulWidget {
  const SummonStep({
    required this.initial,
    required this.onBack,
    required this.onStart,
    super.key,
  });

  /// Where the controls rest when the step opens — the last choice for this runner,
  /// or [SpawnChoice.resting] the first time.
  final SpawnChoice initial;
  final VoidCallback onBack;
  final ValueChanged<SpawnChoice> onStart;

  @override
  State<SummonStep> createState() => _SummonStepState();
}

class _SummonStepState extends State<SummonStep> {
  late SpawnChoice _choice = widget.initial;

  SpawnRunnerView get _r => SpawnRunnerView(_choice.runner);

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final runner = _choice.runner;

    // Scrollable since the permission track joined it: three knobs, a button and two
    // captions is more than a short phone's 82% sheet can hold, and a summon step that
    // overflows hides the one control that cannot be changed afterwards. The sheet is
    // already `isScrollControlled`, so this is the half that was missing.
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          _header(t),
          if (runner.models.isNotEmpty) ...[
            const SizedBox(height: 22),
            _label(t, 'MODEL'),
            const SizedBox(height: 10),
            ModelSegment(
              labels: runner.models.map((m) => m.label).toList(growable: false),
              selected: _r.modelIndex(_choice.model),
              onSelect: (i) => setState(() => _choice = _choice.copyWith(model: _r.modelAt(i))),
            ),
          ],
          // A row before Start, not a line under it: as that line the terminal was missed on a
          // real device (Fase 5 smoke, 2026-11-17). Only where both are possible; Chat rests first.
          if (runner.headless && runner.terminal) ...[
            const SizedBox(height: 22),
            _label(t, 'RUNS IN'),
            const SizedBox(height: 10),
            ModelSegment(
              labels: const ['Chat', 'Terminal'],
              selected: _choice.terminal ? 1 : 0,
              onSelect: (i) => setState(() => _choice = _choice.copyWith(terminal: i == 1)),
            ),
            const SizedBox(height: 7),
            Text(
              'Chat streams and asks you here. Terminal is the full CLI.',
              style: t.serif.copyWith(fontSize: 12.5, fontStyle: FontStyle.italic, color: t.muted),
            ),
          ],
          if (runner.profiles.isNotEmpty) ...[
            const SizedBox(height: 22),
            _label(t, 'ACCOUNT'),
            const SizedBox(height: 10),
            // `Auto` is the account the machine itself has chosen; nothing is sent for it.
            ModelSegment(
              labels: ['Auto', ...runner.profiles.map((p) => p.label)],
              selected: runner.profiles.indexWhere((p) => p.id == _choice.profile) + 1,
              onSelect: (i) => setState(
                () => _choice = _choice.copyWith(profile: i == 0 ? null : runner.profiles[i - 1].id),
              ),
            ),
          ],
          if (runner.efforts.isNotEmpty) ...[
            const SizedBox(height: 26),
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                _label(t, 'THINKING'),
                const Spacer(),
                // Ia berubah di bawah jempol operator, jadi ia mengumumkan dirinya
                // dengan mendekode — bukan dengan warna, yang di aplikasi ini punya arti.
                EncryptedText(
                  text: _choice.effort ?? 'auto',
                  style: t.serif.copyWith(fontSize: 21, fontWeight: FontWeight.w600, color: t.text),
                ),
              ],
            ),
            const SizedBox(height: 10),
            ScaleTrack(
              label: 'Thinking',
              stops: ['auto', ...runner.efforts],
              selected: _r.effortIndex(_choice.effort),
              onSelect: (i) => setState(() => _choice = _choice.copyWith(effort: _r.effortAt(i))),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                _label(t, 'AUTO'),
                const Spacer(),
                _label(t, runner.efforts.last.toUpperCase()),
              ],
            ),
          ],
          if (runner.permissions.isNotEmpty) ...[
            const SizedBox(height: 26),
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                _label(t, 'PERMISSION'),
                const Spacer(),
                EncryptedText(
                  text: _permission?.label ?? '',
                  style: t.serif.copyWith(fontSize: 21, fontWeight: FontWeight.w600, color: t.text),
                ),
              ],
            ),
            const SizedBox(height: 10),
            ScaleTrack(
              label: 'Permission',
              stops: runner.permissions.map((p) => p.label).toList(growable: false),
              selected: _postureIndex,
              onSelect: (i) => setState(
                () => _choice = _choice.copyWith(posture: runner.permissions[i].id),
              ),
            ),
            // No `PLAN … BYPASS` ends row under this one, unlike THINKING. The caption says
            // the direction better than two mono words would, and that row would have printed
            // the name of the most dangerous stop on screen permanently — this sheet does not
            // need to advertise it.
            _blurb(t),
          ],
          const SizedBox(height: 26),
          StartButton(
            semanticsLabel: 'Start ${_choice.summary}',
            onStart: () => widget.onStart(_choice),
          ),
        ],
      ),
    );
  }

  Widget _header(AppTokens t) => Row(
        children: [
          Semantics(
            button: true,
            label: 'Back to runners',
            child: InkWell(
              onTap: widget.onBack,
              customBorder: const CircleBorder(),
              child: SizedBox(
                width: kMinHitTarget,
                height: kMinHitTarget,
                child: Center(
                  child: Chevron(color: t.dim, direction: ChevronDirection.left, size: 13),
                ),
              ),
            ),
          ),
          SizedBox(
            width: 40,
            height: 40,
            child: Center(
              child: RunnerMarkGlyph(
                agentType: _choice.runner.isCustom ? _choice.runner.label : _choice.runner.id,
                color: brandColorFor(_choice.runner.id) ?? t.dim,
                size: 28,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                _choice.runner.label,
                style: t.serif.copyWith(fontSize: 19, fontWeight: FontWeight.w600, color: t.text),
              ),
              const SizedBox(height: 3),
              _label(t, 'SUMMON'),
            ],
          ),
        ],
      );

  Widget _label(AppTokens t, String text) => Text(
        text,
        style: t.mono.copyWith(fontSize: 10, letterSpacing: 0.2 * 10, color: t.muted),
      );

  /// The stop the knob is on, or null for a runner that advertises no scale.
  RunnerPermission? get _permission {
    final id = _choice.posture;
    for (final p in _choice.runner.permissions) {
      if (p.id == id) return p;
    }
    return null;
  }

  int get _postureIndex {
    final i = _choice.runner.permissions.indexWhere((p) => p.id == _choice.posture);
    return i < 0 ? 0 : i;
  }

  /// What the chosen stop means, in one line. **A caption, not a control** — the tap that
  /// used to live on this sentence is what kept the posture down to two values.
  ///
  /// A `liveRegion` so the consequence is announced when it changes without being read out
  /// again every time the knob is touched; the knob announces itself with one word
  /// ([ScaleTrack]), and hearing a full sentence per stop while dragging across four of them
  /// is how a screen reader turns a scale into a wall.
  Widget _blurb(AppTokens t) {
    final stop = _permission;
    final text = stop == null
        ? null
        : permissionBlurb(stop, gates: _choice.runner.gates, headless: !_choice.terminal);
    return Semantics(
      liveRegion: true,
      child: ConstrainedBox(
        // Reserved whether or not there are words, so moving the knob does not shift the
        // button underneath it out from under a thumb already on its way there.
        constraints: const BoxConstraints(minHeight: 34),
        child: Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Text(
            text ?? '',
            textAlign: TextAlign.center,
            style: t.serif.copyWith(fontSize: 12.5, fontStyle: FontStyle.italic, color: t.muted),
          ),
        ),
      ),
    );
  }
}
