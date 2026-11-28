import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';

/// One way out of a state: words and what a tap does.
typedef StateAction = ({String label, VoidCallback onTap});

/// Grey fixes itself or waits on the world; red ink means the operator must act.
/// Never amber: that colour belongs to an agent that needs you (`DESIGN.md` §8).
enum StateTone { quiet, act }

/// The inverted pill: the primary way out of every state shape.
class StatePill extends StatelessWidget {
  const StatePill({required this.action, this.inverted = true, super.key});

  final StateAction action;
  final bool inverted;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final fg = inverted ? t.bg : t.text;
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: kMinHitTarget),
      child: TextButton(
        onPressed: action.onTap,
        style: TextButton.styleFrom(
          backgroundColor: inverted ? t.text : null,
          foregroundColor: fg,
          padding: const EdgeInsets.symmetric(horizontal: 20),
          shape: StadiumBorder(side: inverted ? BorderSide.none : BorderSide(color: t.lineStrong)),
        ),
        child: Text(action.label, style: t.ui.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: fg)),
      ),
    );
  }
}

/// Full-screen empty: a 64 px tile with two hairline rings, a title, one line, at most two ways out.
class OrbHero extends StatelessWidget {
  const OrbHero({
    required this.title,
    this.icon,
    this.picture,
    this.body,
    this.primary,
    this.secondary,
    super.key,
  });

  final IconData? icon;

  /// Drawn instead of the orb; a search with no match shows its own query here.
  final Widget? picture;
  final String title;
  final String? body;
  final StateAction? primary;
  final StateAction? secondary;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            picture ?? _orb(context, t),
            const SizedBox(height: 22),
            Text(
              title,
              textAlign: TextAlign.center,
              style: t.ui.copyWith(fontSize: 28, height: 34 / 28, fontWeight: FontWeight.w600, color: t.text),
            ),
            if (body case final b?) ...[
              const SizedBox(height: 8),
              Text(
                b,
                textAlign: TextAlign.center,
                style: t.ui.copyWith(fontSize: 16, height: 24 / 16, color: t.dim),
              ),
            ],
            if (primary case final p?) ...[const SizedBox(height: 24), StatePill(action: p)],
            if (secondary case final s?) ...[
              const SizedBox(height: 8),
              TextButton(
                onPressed: s.onTap,
                style: TextButton.styleFrom(minimumSize: const Size(0, kMinHitTarget)),
                child: Text(s.label, style: t.ui.copyWith(fontSize: 15, color: t.dim)),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _orb(BuildContext context, AppTokens t) => Container(
        width: 96,
        height: 96,
        decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: t.line)),
        alignment: Alignment.center,
        child: Container(
          width: 80,
          height: 80,
          decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: t.lineStrong)),
          alignment: Alignment.center,
          child: Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(color: t.raise, shape: BoxShape.circle),
            child: Icon(icon ?? Icons.inbox_outlined, size: 26, color: t.dim),
          ),
        ),
      );
}

/// A state of the link or a machine, floating under a header: icon, words, one button.
class StateCapsule extends StatelessWidget {
  const StateCapsule({
    required this.words,
    required this.icon,
    this.action,
    this.tone = StateTone.quiet,
    super.key,
  });

  final String words;
  final IconData icon;
  final StateAction? action;
  final StateTone tone;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final ink = tone == StateTone.act ? t.error : t.dim;
    return Container(
      constraints: const BoxConstraints(minHeight: 52),
      padding: const EdgeInsets.fromLTRB(16, 4, 4, 4),
      decoration: BoxDecoration(
        color: t.raise,
        borderRadius: context.shape.radius(ShapeRole.pill),
        border: Border.all(color: t.line),
      ),
      child: Row(
        children: [
          Icon(icon, size: 20, color: ink),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              words,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: t.ui.copyWith(fontSize: 15, height: 20 / 15, color: tone == StateTone.act ? t.error : t.text),
            ),
          ),
          if (action case final a?) ...[const SizedBox(width: 8), StatePill(action: a)],
        ],
      ),
    );
  }
}

/// Something that happened elsewhere: a slim pill centred on a hairline, in the chat.
class EventPill extends StatelessWidget {
  const EventPill({required this.words, this.icon, super.key});

  final String words;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Row(
        children: [
          Expanded(child: Divider(color: t.line, height: 1)),
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 10),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
            decoration: BoxDecoration(
              color: t.raise,
              borderRadius: context.shape.radius(ShapeRole.pill),
              border: Border.all(color: t.line),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (icon case final i?) ...[Icon(i, size: 14, color: t.muted), const SizedBox(width: 6)],
                Text(words, style: t.ui.copyWith(fontSize: 13, height: 18 / 13, color: t.dim)),
              ],
            ),
          ),
          Expanded(child: Divider(color: t.line, height: 1)),
        ],
      ),
    );
  }
}
