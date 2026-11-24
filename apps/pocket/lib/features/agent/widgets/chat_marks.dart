import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import 'line_details.dart';

/// `── TODAY ──` between turns that fall on different days.
///
/// The timestamp was carried on every line since Chat existed and drawn nowhere. On a
/// ring of sixty entries that spans a night, the difference between "it asked me this
/// an hour ago" and "it asked me this yesterday" is the difference between acting and
/// ignoring.
class DayMark extends StatelessWidget {
  const DayMark({required this.at, this.now, super.key});

  final DateTime at;
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final rule = Expanded(child: Container(height: 1, color: t.line));

    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 12),
      child: Row(
        children: [
          rule,
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Text(
              dayLabel(at, now ?? DateTime.now()),
              style: t.mono.copyWith(fontSize: 11, letterSpacing: 0.13 * 11, color: t.muted),
            ),
          ),
          rule,
        ],
      ),
    );
  }
}

/// The top of what the host still has.
///
/// The app's usual rule about not letting an absence look like an answer: a transcript
/// that simply stops reads as "this is everything", and it is not — the host keeps a
/// ring of sixty entries per pane and the rest is gone. Stated once, at the only place
/// it is true.
class HistoryEdge extends StatelessWidget {
  const HistoryEdge({required this.entries, super.key});

  final int entries;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Padding(
      padding: const EdgeInsets.only(top: 2, bottom: 12),
      child: Text(
        'start of the history the host keeps\nlast $entries entries',
        textAlign: TextAlign.center,
        style: t.mono.copyWith(fontSize: 11, height: 1.6, color: t.muted),
      ),
    );
  }
}

/// The agent is working, said at the end of the transcript where the eye already is.
///
/// `MVP.md` traded the speed of a green dot for a quiet screen and flagged this as the
/// first place to revisit if that trade felt wrong. This is that revisit, and it pays
/// the debt in mono without spending the third colour the rule forbids.
///
/// **The motion is the text, not a pulse**, and that is a correction to the mockup this
/// came from. A perpetually breathing dot was drawn there; building it exposed three
/// problems, in ascending order of seriousness: it repaints forever while the page is
/// open, it says "alive" on a schedule of its own rather than when anything happened,
/// and an animation that never completes makes `pumpAndSettle` — which every test of
/// this page uses — hang instead of settle. What actually changes here is the phrase
/// itself, arriving over the socket (`312 of 476` → `398 of 476`), so cross-fading each
/// new phrase moves precisely when there is something to report and rests otherwise.
class LiveLine extends StatelessWidget {
  const LiveLine({required this.text, super.key});

  final String text;

  /// Long enough to register as a change, short enough not to blur a fast-moving count.
  static const Duration fade = Duration(milliseconds: 220);

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          Container(
            width: 5,
            height: 5,
            decoration: BoxDecoration(color: t.dim, borderRadius: BorderRadius.circular(3)),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: AnimatedSwitcher(
              duration: fade,
              child: Text(
                text,
                // Keyed by the phrase, so an unchanged one is not re-faded on every
                // rebuild the transcript triggers.
                key: ValueKey(text),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: t.mono.copyWith(fontSize: 12, color: t.dim),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The one affordance for "there is newer output than what you are reading".
///
/// **The count is new, and it is not decoration.** `MVP.md` refused a badge because a
/// number competes with the amber that means an agent needs you — which is right, and
/// is why this only exists while the operator has scrolled away from the end, a state
/// in which nothing is being asked of them. What it buys is the difference between
/// "there is more" and "there is a lot more", which decides whether to skim back or
/// jump.
class JumpToLatest extends StatelessWidget {
  const JumpToLatest({required this.onTap, required this.unread, super.key});

  final VoidCallback onTap;
  final int unread;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final counted = unread > 0;

    return Semantics(
      button: true,
      label: counted ? 'Jump to latest, $unread new' : 'Jump to latest',
      child: Material(
        color: Color.alphaBlend(t.raise, t.bg),
        shape: counted
            ? RoundedRectangleBorder(borderRadius: BorderRadius.circular(17))
            : const CircleBorder(),
        child: InkWell(
          onTap: onTap,
          customBorder: counted
              ? RoundedRectangleBorder(borderRadius: BorderRadius.circular(17))
              : const CircleBorder(),
          child: Container(
            height: 34,
            width: counted ? null : 34,
            padding: counted ? const EdgeInsets.symmetric(horizontal: 12) : EdgeInsets.zero,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: counted ? BoxShape.rectangle : BoxShape.circle,
              borderRadius: counted ? BorderRadius.circular(17) : null,
              border: Border.all(color: t.lineStrong),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('⌄', style: t.ui.copyWith(fontSize: 15, height: 1, color: t.dim)),
                if (counted) ...[
                  const SizedBox(width: 7),
                  Text(
                    '$unread new',
                    style: t.mono.copyWith(fontSize: 11.5, color: t.dim),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}


/// The space between two turns, and nothing else.
///
/// **No rule, no label.** `MVP.md` gives this screen two colours and asks structure to be
/// carried by typeface and space; [DayMark] already spends a hairline on the larger claim,
/// and a second rule for the smaller one would make the two compete. A gap is a boundary the
/// eye reads without being told.
///
/// Sized against the lines it separates rather than by taste: a chat line pads 5 above and
/// below, so two neighbours sit about 10 apart. This is deliberately about three times that
/// — far enough that a turn reads as one block at a glance, near enough that the next turn
/// is plainly the same conversation.
class TurnGap extends StatelessWidget {
  const TurnGap({super.key});

  /// **Sized by measurement, not by taste.** Measured on a real Infinix X6880 (440 dpi,
  /// devicePixelRatio 2.75) on 2026-09-10, by reading text-band positions out of a
  /// screenshot rather than eyeballing it:
  ///
  /// | gap | device px | logical px |
  /// |---|---|---|
  /// | prose → `result`, inside one turn | 111 · 112 | ~41 |
  /// | bubble → `* AGENT` heading, inside one turn | 129 · 123 | ~46 |
  /// | `result` → next turn's bubble, with this row at 22 | 144 | ~52 |
  ///
  /// 22 was picked against the 10-logical-pixel padding of a single chat line, and that was
  /// the wrong reference. The gaps this has to beat are the ones *between blocks* — 41 and
  /// 46 — not the one between two lines of the same block. It left the turn boundary six
  /// logical pixels wider than an ordinary gap, which is not a boundary anybody sees.
  ///
  /// 48 puts the boundary near twice the largest gap inside a turn, which is the ratio that
  /// makes one turn read as one block at a glance.
  @override
  Widget build(BuildContext context) => const SizedBox(height: 48);
}

/// The top edge of the transcript, dissolved into the floor.
///
/// **A line was being cut in half there.** The transcript is a plain `Column` child
/// under the header, so a row crossing that boundary was sliced flat — seen on a device:
/// a sentence with its upper half missing, which reads as a rendering fault rather than
/// as "there is more above".
///
/// A gradient in the app's own floor rather than a `ShaderMask`: the list sits on `bg`
/// and nothing shows through it, so painting `bg` → transparent is the same picture
/// without the `saveLayer` a mask costs on every frame of every scroll.
///
/// [IgnorePointer], or the top 28px of a scrolling list would stop taking the thumb —
/// the exact place the operator reaches to scroll back.
class TranscriptTopFade extends StatelessWidget {
  const TranscriptTopFade({super.key});

  /// Deep enough to swallow one line of prose at 15.5/1.6, shallow enough that the
  /// newest thing above it is still legible through the tail of the gradient.
  static const double height = 28;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      child: IgnorePointer(
        child: Container(
          height: height,
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [t.bg, t.bg.withValues(alpha: 0)],
            ),
          ),
        ),
      ),
    );
  }
}
