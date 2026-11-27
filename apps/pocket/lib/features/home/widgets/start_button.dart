import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/tactile.dart';

/// The one commit on the summon sheet: this is where an agent is born.
///
/// **It was drawn as a secondary surface, and that was the actual defect.** The pill was
/// filled with `AppTokens.raise` and inked with `AppTokens.text`, which is this app's
/// language for *a panel*, while the primary action everywhere else is inverted: filled
/// with `text`, inked with `bg` (`send_button.dart`, and the doc on the `text` token
/// itself says so). So the only irreversible control on the screen was the quietest thing
/// on it, quieter than the row of model pills above it. Inverting it is the whole revamp.
///
/// **The arrow and its launch bay went on 2026-08-27, and the reasoning that put them
/// there is worth keeping** — it was sound about the arrow and wrong about needing one.
/// The bay existed because a glyph floating beside a word reads as punctuation, so the
/// arrow was given a circle of `bg` at 9% to live in, and the press lifted it 3px inside
/// that circle. Both are true. What neither answers is why this button needs a glyph at
/// all: *Start* is already a verb, the sheet it sits in is already named `SUMMON`, and the
/// arrow duplicated a direction nothing here travels in — unlike `send_button.dart`, whose
/// `↑` **is** the label because a send button has no room for a word. Removing it takes a
/// piece of structure out of the pill and leaves the inversion to carry the weight alone,
/// which is what was actually doing the work.
///
/// So the geometry is now one centred word, and the physics moved from the glyph onto the
/// pill itself:
///
///  - **A hairline inside the fill.** A light shape on a near-black floor has no edge of
///    its own; 10% `bg` along the inside gives it one, which is what makes it look
///    pressed out of the surface instead of pasted onto it.
///  - **Physics on the press, not on the release.** The pill compresses to 0.985 *and the
///    fill takes a wash of the floor* while the thumb is down, then springs back when it
///    leaves. The wash replaces what the bay used to say — it is the same idiom the bay
///    used (`bg` laid over the light fill), applied to the whole surface rather than to a
///    circle inside it, so the button still answers a thumb without owning an ornament.
///    Nothing animates *after* the tap: the sheet is already leaving at that moment, and
///    two animations competing for the same 200ms is exactly what the step transition was
///    fixed for. What is felt is the press; what is watched is the sheet closing.
///
/// Never colour, in either version — the app spends no colour on decoration, and a launch
/// button glowing warm would collide with the one thing warm ink means here (an agent
/// needs you).
///
/// The haptic stays [Tactile.chose] rather than [Tactile.sent]: the words have not left
/// the phone yet — the composer's own send is what commits them (`spawn_flow.dart`).
class StartButton extends StatefulWidget {
  const StartButton({
    required this.onStart,
    required this.semanticsLabel,
    this.label = 'Start',
    super.key,
  });

  /// Null when there is nothing to commit.
  ///
  /// **A dead pill rather than a hidden one**, and only where the operator is *standing on*
  /// something that cannot be taken — the browse screen's workspace root (`issues/10`). The
  /// reason is always printed under it, because a control that is off without saying why is a
  /// control the operator argues with. Everywhere else the rule still holds: an action a
  /// machine cannot do is absent, not disabled.
  final VoidCallback? onStart;

  /// The whole choice, spoken: `Start claude · opus · medium`. The visible label is one
  /// verb, because the chip and the footer already print the rest — but a screen reader
  /// gets one chance to say what this button will do.
  final String semanticsLabel;

  final String label;

  @override
  State<StartButton> createState() => _StartButtonState();
}

const double _kHeight = 52;
const Duration _kPress = Duration(milliseconds: 130);
const Curve _kPressCurve = Curves.easeOutCubic;

/// How much of the app floor washes over the fill while the thumb is down. Deliberately
/// small: it has to read as *the surface answering*, not as a second colour appearing.
const double _kPressWash = 0.07;

class _StartButtonState extends State<StartButton> {
  bool _down = false;

  void _set(bool down) {
    if (_down == down) return;
    setState(() => _down = down);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      label: widget.semanticsLabel,
      child: ExcludeSemantics(
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (_) => widget.onStart == null ? null : _set(true),
          onTapUp: (_) => _set(false),
          onTapCancel: () => _set(false),
          onTap: () {
            final start = widget.onStart;
            if (start == null) return;
            Tactile.chose();
            start();
          },
          child: AnimatedScale(
            scale: _down ? 0.985 : 1,
            duration: _kPress,
            curve: _kPressCurve,
            child: AnimatedContainer(
              duration: _kPress,
              curve: _kPressCurve,
              height: _kHeight,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                // Opaque in both states rather than a translucent overlay: this pill sits
                // on a sheet that is itself translucent, and ink that lets the sheet
                // through would take its press response from whatever happened to be
                // scrolled behind it.
                color: widget.onStart == null
                    ? t.raise
                    : _down
                        ? Color.alphaBlend(t.bg.withValues(alpha: _kPressWash), t.text)
                        : t.text,
                borderRadius: BorderRadius.circular(999),
                // The edge that makes a light shape sit *in* the surface. A dead pill has no
                // edge to press out of anything, so it has none.
                border: Border.all(
                  color: widget.onStart == null ? Colors.transparent : t.bg.withValues(alpha: 0.10),
                ),
              ),
              child: Text(
                widget.label,
                style: t.serif.copyWith(
                  fontSize: 19,
                  fontWeight: FontWeight.w600,
                  color: widget.onStart == null ? t.faint : t.bg,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
