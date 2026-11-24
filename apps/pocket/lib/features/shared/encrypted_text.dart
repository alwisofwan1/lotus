import 'dart:math';

import 'package:flutter/material.dart';

/// A word that **decodes** into place when it changes: every glyph starts as noise and
/// resolves left to right.
///
/// Used for the one label on the summon sheet that changes under the operator's thumb —
/// the thinking level. A value that is being *dragged through* is not the same event as a
/// value that was typed, and a plain `Text` swap gives the two the same treatment: the
/// word simply is different now, and on a phone at arm's length that is easy to miss
/// entirely. Decoding says *this just changed* without a colour, a badge, or a second
/// line — which matters here, because this app spends no colour on decoration
/// (`AppTokens.waiting` is the only warm ink and it means an agent needs you).
///
/// Three details are what keep it from being a gimmick:
///
///  - **The width is the target's width from the first frame.** Noise is generated at
///    `text.length`, never at the old length, so nothing beside it ever reflows — the
///    reason this is not simply a random-string animation.
///  - **The noise re-rolls on its own clock (~18/s), not per frame.** At 60fps every
///    glyph changing every frame reads as static, not as decoding; slower than ~12/s and
///    it reads as a bug. Between rolls the frame is deterministic, so a repaint for any
///    other reason cannot make the word flicker.
///  - **Spaces never scramble.** Word boundaries are what make a half-decoded phrase
///    still readable as a phrase.
///
/// Honours the OS reduce-motion setting by rendering the word plainly: this is decoration
/// in the strict sense — nothing is communicated by the noise that the settled word does
/// not say — so it is the first thing that should go.
class EncryptedText extends StatefulWidget {
  const EncryptedText({
    required this.text,
    this.style,
    this.duration = const Duration(milliseconds: 340),
    super.key,
  });

  final String text;
  final TextStyle? style;

  /// How long the whole word takes to resolve. Per-glyph timing is staggered inside it.
  final Duration duration;

  @override
  State<EncryptedText> createState() => _EncryptedTextState();
}

/// Lowercase and digits only. The labels this renders are lowercase (`auto`, `xhigh`), and
/// noise drawn from symbols in a serif face reads as a ransom note rather than as cipher.
const String _kGlyphs = 'abcdefghijklmnopqrstuvwxyz0123456789';

/// ~18 rolls a second. See the class comment — this number is the whole effect.
const int _kRollMs = 55;

class _EncryptedTextState extends State<EncryptedText> with SingleTickerProviderStateMixin {
  late final AnimationController _decode = AnimationController(
    vsync: this,
    duration: widget.duration,
    value: 1,
  );

  @override
  void didUpdateWidget(EncryptedText old) {
    super.didUpdateWidget(old);
    if (old.text == widget.text) return;
    // Restarted, not queued: dragging through five stops should read as one continuous
    // decode, not as five animations waiting their turn.
    _decode
      ..duration = widget.duration
      ..forward(from: 0);
  }

  @override
  void dispose() {
    _decode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (MediaQuery.disableAnimationsOf(context)) return _plain(widget.text);

    return AnimatedBuilder(
      animation: _decode,
      builder: (context, _) => _plain(_frame(_decode.value)),
    );
  }

  /// The semantics carry the real word at every point in the animation, so a screen
  /// reader is never handed the noise.
  Widget _plain(String shown) => Text(
        shown,
        style: widget.style,
        maxLines: 1,
        semanticsLabel: widget.text,
      );

  String _frame(double progress) {
    final target = widget.text;
    if (progress >= 1) return target;

    // Eased so the first glyphs land quickly and the last one is the one you watch.
    final resolved = (Curves.easeOutCubic.transform(progress) * target.length).floor();
    final roll = (progress * widget.duration.inMilliseconds / _kRollMs).floor();

    final out = StringBuffer();
    for (var i = 0; i < target.length; i++) {
      final char = target[i];
      if (i < resolved || char == ' ') {
        out.write(char);
        continue;
      }
      // Seeded per (roll, position): stable within a frame, different on the next roll.
      out.write(_kGlyphs[Random(roll * 977 + i * 31).nextInt(_kGlyphs.length)]);
    }
    return out.toString();
  }
}
