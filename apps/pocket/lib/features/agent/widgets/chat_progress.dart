import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/tactile.dart';
import '../turn_progress.dart';

/// `3m 10s`: whole seconds under an hour, whole minutes above it.
String tookLabel(Duration d) {
  final s = d.inSeconds;
  if (s < 60) return '${s}s';
  if (s < 3600) return s % 60 == 0 ? '${s ~/ 60}m' : '${s ~/ 60}m ${s % 60}s';
  return '${s ~/ 3600}h ${(s % 3600) ~/ 60}m';
}

/// The one progress signal of a running turn: done ✓, current bold, next dim.
class ProgressCard extends StatelessWidget {
  const ProgressCard({required this.progress, super.key});

  final TurnProgress progress;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Container(
      margin: const EdgeInsets.only(bottom: 20),
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      decoration: BoxDecoration(
        color: t.raise,
        border: Border.all(color: t.line),
        borderRadius: context.shape.radius(ShapeRole.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ProgressSteps(steps: progress.steps),
        ],
      ),
    );
  }
}

class ProgressSteps extends StatelessWidget {
  const ProgressSteps({required this.steps, super.key});

  final List<ProgressStep> steps;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [for (final s in steps) _StepRow(step: s)],
      );
}

class _StepRow extends StatelessWidget {
  const _StepRow({required this.step});

  final ProgressStep step;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final now = step.state == ProgressState.now;
    final style = t.ui.copyWith(
      fontSize: 15,
      height: 20 / 15,
      fontWeight: now ? FontWeight.w600 : FontWeight.w400,
      color: switch (step.state) {
        ProgressState.done => t.dim,
        ProgressState.now => t.text,
        ProgressState.next => t.muted,
      },
    );
    final mark = switch (step.state) {
      ProgressState.done => Text('✓', style: style.copyWith(fontWeight: FontWeight.w600)),
      ProgressState.now => Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(shape: BoxShape.circle, color: t.live),
        ),
      ProgressState.next => Text('·', style: style),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 22, height: 20, child: Align(alignment: Alignment.centerLeft, child: mark)),
          // Sized to the word, so the line moves under it instead of across the card.
          Flexible(
            child: IntrinsicWidth(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(step.label, style: style),
                  if (now) const Padding(padding: EdgeInsets.only(top: 4), child: _Sweep()),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// A thin line moving under the current step — the only motion on the page.
class _Sweep extends StatefulWidget {
  const _Sweep();

  @override
  State<_Sweep> createState() => _SweepState();
}

class _SweepState extends State<_Sweep> with SingleTickerProviderStateMixin {
  late final AnimationController _run =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1600));

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      _run.stop();
    } else if (!_run.isAnimating) {
      _run.repeat();
    }
  }

  @override
  void dispose() {
    _run.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return SizedBox(
      key: const ValueKey('progress-sweep'),
      height: 2,
      child: ColoredBox(
        color: t.line,
        child: AnimatedBuilder(
          animation: _run,
          builder: (context, _) => FractionallySizedBox(
            widthFactor: 0.4,
            alignment: Alignment(-1 + 2 * Curves.easeInOut.transform(_run.value), 0),
            child: ColoredBox(color: t.dim),
          ),
        ),
      ),
    );
  }
}

/// `▭ 4 steps · 3m 10s ›` — a finished turn's work as one small pill, opened on tap.
class SummaryLine extends StatelessWidget {
  const SummaryLine({required this.progress, required this.open, required this.onToggle, super.key});

  final TurnProgress progress;
  final bool open;
  final VoidCallback onToggle;

  String get label {
    final n = progress.count;
    final took = progress.took;
    return '${['$n ${n == 1 ? 'step' : 'steps'}', if (took != null) tookLabel(took)].join(' · ')} ›';
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () {
              Tactile.chose();
              onToggle();
            },
            borderRadius: context.shape.radius(ShapeRole.pill),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: kMinHitTarget),
              child: Align(
                alignment: Alignment.centerLeft,
                widthFactor: 1,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: t.raise2,
                    borderRadius: context.shape.radius(ShapeRole.pill),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Container(
                          width: 12,
                          height: 9,
                          decoration: BoxDecoration(
                            border: Border.all(color: t.muted, width: 1.3),
                            borderRadius: BorderRadius.circular(2),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          label,
                          style: t.ui.copyWith(
                              fontSize: 13,
                              color: t.muted,
                              fontFeatures: const [FontFeature.tabularFigures()]),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          if (open) ProgressSteps(steps: progress.steps),
        ],
      ),
    );
  }
}
