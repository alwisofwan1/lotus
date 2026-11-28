import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import 'intro_glyphs.dart';

/// One intro pane's layout, so the three of them cannot drift apart.
///
/// Everything optional, because the three panes genuinely differ: the first carries
/// the mark and a paragraph, the second three glyph rows, the third two sample rows
/// and a closing line. What they share — the vertical rhythm, the type ramp, the
/// centred block that grows from the middle rather than the top — is here, once.
class IntroPane extends StatelessWidget {
  const IntroPane({
    required this.title,
    this.eyebrow,
    this.body,
    this.mark,
    this.rows = const [],
    this.samples = const [],
    super.key,
  });

  final String title;
  final String? eyebrow;
  final String? body;
  final Widget? mark;
  final List<IntroRow> rows;
  final List<IntroSample> samples;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    // The scroll view's own height, not a fraction of the screen's. Measured against
    // the screen the block centres inside a box shorter than the pane and so lands
    // high, with a hand's width of dead space under it — which is what the first
    // version did. Scrollable rather than fixed because three glyph rows at the
    // largest system text size do overflow a small phone, and a pane that clips its
    // own explanation is worse than one the operator has to nudge.
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(22, 8, 22, 18),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight - 26),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (mark != null) ...[mark!, const SizedBox(height: 20)],
              if (eyebrow != null) ...[
                Text(
                  eyebrow!.toUpperCase(),
                  style: t.mono.copyWith(fontSize: 9.5, letterSpacing: 1.5, color: t.faint),
                ),
                const SizedBox(height: 12),
              ],
              Text(
                title,
                style: t.ui.copyWith(
                  fontSize: 23,
                  height: 1.22,
                  fontWeight: FontWeight.w500,
                  letterSpacing: -0.55,
                  color: t.text,
                ),
              ),
              if (rows.isNotEmpty) ...[
                const SizedBox(height: 22),
                for (final row in rows) ...[row, const SizedBox(height: 16)],
              ],
              if (samples.isNotEmpty) ...[
                const SizedBox(height: 18),
                for (final sample in samples) sample,
              ],
              if (body != null) ...[
                const SizedBox(height: 14),
                Text(
                  body!,
                  style: t.ui.copyWith(fontSize: 13, height: 1.5, color: t.muted),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// A glyph, a claim, and the sentence that qualifies it.
class IntroRow extends StatelessWidget {
  const IntroRow({required this.glyph, required this.title, required this.body, super.key});

  final IntroGlyph glyph;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: IntroGlyphMark(glyph: glyph, color: t.dim),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: t.ui.copyWith(
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  color: t.text,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                body,
                style: t.ui.copyWith(fontSize: 12.5, height: 1.45, color: t.muted),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// A stand-in for a Home row, drawn so the third pane can point at one.
///
/// It is the real row's shape rather than a picture of it: a dot, a name, and the
/// question underneath. If Home's row changes, this one being stale is a visible bug
/// rather than a stale screenshot nobody notices.
class IntroSample extends StatelessWidget {
  const IntroSample({
    required this.dot,
    required this.title,
    required this.body,
    super.key,
  });

  final Color dot;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 13),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: t.line)),
      ),
      child: Row(
        children: [
          DecoratedBox(
            decoration: BoxDecoration(color: dot, shape: BoxShape.circle),
            child: const SizedBox.square(dimension: 7),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: t.ui.copyWith(fontSize: 13.5, color: t.text)),
                const SizedBox(height: 2),
                Text(body, style: t.ui.copyWith(fontSize: 11.5, color: t.muted)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The inverted button this app uses for a commit: ink on the text colour, never a
/// new accent — amber has one meaning and this is not it. Same treatment as
/// `OnboardingScreen`'s Pair button, so the intro hands over to a shape the operator
/// has already learned.
class IntroButton extends StatelessWidget {
  const IntroButton({required this.label, required this.onTap, super.key});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      child: Material(
        color: t.text,
        borderRadius: context.shape.radius(ShapeRole.button),
        child: InkWell(
          onTap: onTap,
          borderRadius: context.shape.radius(ShapeRole.button),
          child: Container(
            height: 48,
            alignment: Alignment.center,
            child: Text(
              label,
              style: t.ui.copyWith(
                fontSize: 14.5,
                fontWeight: FontWeight.w600,
                color: t.bg,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
