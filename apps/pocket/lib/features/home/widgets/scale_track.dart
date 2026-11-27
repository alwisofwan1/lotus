import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/tactile.dart';

/// A value chosen off a runner's own scale, on a track the thumb can **drag**.
///
/// Two of them on the summon sheet: how hard the agent thinks, and how free it acts. Both are
/// ordered scales whose stops are *words the host sent*, which is why this widget knows none
/// of them — it takes a list, an index, and the word to announce itself by.
///
/// **It was `ThinkingSlider` until 2026-08-27**, and the rename is the whole reason it could
/// be reused: the permission scale needed exactly this control, and a widget called
/// `ThinkingSlider` drawing `PERMISSION` would have been a name that lies. Nothing about its
/// behaviour changed with the name.
///
/// It was a row of tap targets before that, and the shape was already promising a gesture it
/// did not honour: a knob on a filled track is the one control every phone operator has
/// learned to *drag*, so a knob that only answers discrete taps reads as unresponsive rather
/// than as a different control. Dragging it now does what the shape says, and tapping a stop
/// still works — the old gesture was never wrong, only lonely.
///
/// What makes it feel continuous rather than steppy:
///
///  - **While the thumb is down, the knob is where the finger is** — not at the nearest
///    stop. Snapping under the finger is the single thing that makes a slider feel like
///    it is arguing with you.
///  - **The selection changes as the finger crosses each stop**, with the platform's
///    picker-wheel tick ([Tactile.chose]), so the value can be felt while the eye is on
///    the label above rather than on the track.
///  - **On release it settles** to the crossed stop over 220ms — the only moment
///    interpolation is correct, because it is the only moment the value is not being
///    chosen.
///  - **The fill is the value.** How far along the scale it sits reads as a length before the
///    word above is read at all, so the track is filled to the knob and the passed pips lift a
///    step out of ornament grey. On the permission scale that length is *how free it is*,
///    which is the one thing worth reading from across a room.
///
/// Accessibility is a real slider, not a row of buttons: one `Semantics` node with
/// `increase`/`decrease` actions, so the value can be moved without the gesture at all.
class ScaleTrack extends StatefulWidget {
  const ScaleTrack({
    required this.label,
    required this.stops,
    required this.selected,
    required this.onSelect,
    super.key,
  });

  /// What this scale is, for the screen reader: `Thinking`, `Permission`. Not drawn — the
  /// eye already has it in the row above, and hearing it twice is worse than not at all.
  final String label;

  /// The words of the scale, least first. The thinking scale puts `auto` at index 0.
  final List<String> stops;
  final int selected;
  final ValueChanged<int> onSelect;

  @override
  State<ScaleTrack> createState() => _ScaleTrackState();
}

const double _kHeight = 46;
const double _kRadius = 23;

/// The knob, resting and held. It grows under the thumb because a control being operated
/// should look operated — and because the finger covers it, so the growth is read at the
/// edges rather than in the middle.
const double _kThumb = 26;
const double _kThumbHeld = 31;

/// Settling only. Nothing animates while the finger is down: that is the drag itself.
const Duration _kSettle = Duration(milliseconds: 220);
const Curve _kSettleCurve = Curves.easeOutCubic;

class _ScaleTrackState extends State<ScaleTrack> {
  /// Continuous position, in stop units, while the thumb is down. Null when it is not —
  /// and that null is what switches the knob between *following* and *settling*.
  double? _held;

  double get _position => _held ?? widget.selected.toDouble();

  /// Which stop the finger is over, clamped to the scale's ends so dragging past the
  /// edge holds the extreme rather than doing nothing.
  int _stopAt(double dx, double width) {
    final column = width / widget.stops.length;
    final index = (dx / column).floor();
    return index.clamp(0, widget.stops.length - 1);
  }

  double _continuous(double dx, double width) {
    final column = width / widget.stops.length;
    return (dx / column - 0.5).clamp(0, widget.stops.length - 1).toDouble();
  }

  void _moveTo(double dx, double width) {
    final stop = _stopAt(dx, width);
    setState(() => _held = _continuous(dx, width));
    if (stop == widget.selected) return;
    Tactile.chose();
    widget.onSelect(stop);
  }

  void _step(int by) {
    final next = (widget.selected + by).clamp(0, widget.stops.length - 1);
    if (next == widget.selected) return;
    Tactile.chose();
    widget.onSelect(next);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    // `increasedValue`/`decreasedValue` are not optional trim: a node that offers the
    // increase action *and* carries a value must say what the value would become, and the
    // framework asserts on the half-declared form. It is also the better announcement —
    // "medium, will become high" is what a slider is supposed to say.
    final at = widget.selected;
    final last = widget.stops.length - 1;

    return Semantics(
      slider: true,
      value: widget.stops[at],
      increasedValue: widget.stops[(at + 1).clamp(0, last)],
      decreasedValue: widget.stops[(at - 1).clamp(0, last)],
      label: widget.label,
      onIncrease: () => _step(1),
      onDecrease: () => _step(-1),
      child: ExcludeSemantics(
        child: LayoutBuilder(
          builder: (context, box) {
            final width = box.maxWidth;
            final column = width / widget.stops.length;

            return GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTapDown: (d) => _moveTo(d.localPosition.dx, width),
              onTapUp: (_) => setState(() => _held = null),
              onTapCancel: () => setState(() => _held = null),
              onHorizontalDragStart: (d) => _moveTo(d.localPosition.dx, width),
              onHorizontalDragUpdate: (d) => _moveTo(d.localPosition.dx, width),
              onHorizontalDragEnd: (_) => setState(() => _held = null),
              onHorizontalDragCancel: () => setState(() => _held = null),
              child: SizedBox(
                height: _kHeight,
                child: Stack(
                  children: [
                    DecoratedBox(
                      decoration: BoxDecoration(
                        color: t.raise,
                        borderRadius: BorderRadius.circular(_kRadius),
                      ),
                      child: const SizedBox.expand(),
                    ),
                    _fill(t, column),
                    _pips(t),
                    _knob(t, column),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  /// One shade over the pill, ending at the knob — the value as a length.
  Widget _fill(AppTokens t, double column) => _settled(
        left: 0,
        width: column * (_position + 0.5),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: t.raise,
            borderRadius: BorderRadius.circular(_kRadius),
          ),
        ),
      );

  /// Passed stops sit a step brighter than the ones ahead, so the track reads as travelled
  /// even where the fill and the pill are close in value.
  Widget _pips(AppTokens t) => Row(
        children: [
          for (var i = 0; i < widget.stops.length; i++)
            Expanded(
              child: Center(
                child: AnimatedContainer(
                  duration: _kSettle,
                  curve: _kSettleCurve,
                  width: 5,
                  height: 5,
                  decoration: BoxDecoration(
                    color: i <= _position.round() ? t.muted : t.faint,
                    borderRadius: BorderRadius.circular(3),
                  ),
                ),
              ),
            ),
        ],
      );

  Widget _knob(AppTokens t, double column) {
    final held = _held != null;
    final size = held ? _kThumbHeld : _kThumb;
    return _settled(
      left: column * (_position + 0.5) - size / 2,
      width: size,
      child: Center(
        child: AnimatedContainer(
          duration: _kSettle,
          curve: _kSettleCurve,
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: t.text,
            borderRadius: BorderRadius.circular(size / 2),
          ),
        ),
      ),
    );
  }

  /// Positioned directly while the finger is down, animated when it is not — the one
  /// switch this control turns on, expressed once.
  Widget _settled({required double left, required double width, required Widget child}) {
    if (_held != null) {
      return Positioned(left: left, top: 0, bottom: 0, width: width, child: child);
    }
    return AnimatedPositioned(
      duration: _kSettle,
      curve: _kSettleCurve,
      left: left,
      top: 0,
      bottom: 0,
      width: width,
      child: child,
    );
  }
}
