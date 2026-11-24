import 'package:flutter/material.dart';

/// Two steps of **one** sheet — a list, and what was chosen from it — swapped along a
/// shared horizontal axis while the sheet's own height glides between them.
///
/// **Why this is not an `AnimatedSwitcher`.** It was one until 2026-08-27, and a screen
/// recording of the real phone says precisely why it read as a glitch rather than a
/// movement. Two failures, both structural:
///
///  1. `AnimatedSwitcher` lays its children out in a `Stack`, and a `Stack` takes the
///     size of its **largest** child. So the sheet held the tall list's height for the
///     whole animation and then **snapped** to the short config step in a single frame —
///     an ~80px jump that moved every line the operator had already started reading.
///     Height was never interpolated at all; it stepped twice, at both ends.
///  2. Its cross-fade runs both opacities on the same curve, so for ~120ms the runner
///     rows and the MODEL segment were legible *through each other*. That double
///     exposure is what the eye reports as "broken" — not the slide.
///
/// So: the size is animated here, and the leaving step is taken **out of layout**. It
/// keeps the height it actually had on screen and is clipped away as the sheet closes
/// over it, instead of being re-laid-out into the arriving step's box — which is what
/// would make its rows jump in the instant before they fade.
///
/// The numbers below are a shared-axis transition, and each one is a decision:
///
///  - **300ms in, 250ms back.** 180ms was not slow, it was *too short for the distance*:
///    a height change of ~300px inside it can only read as a cut. Going back is shorter
///    because the operator already knows what is behind them.
///  - **Emphasized decelerate for everything that moves.** One curve for the height and
///    the arriving content, so the floor and the words arrive together; a sheet whose
///    frame settles before its content does reads as two animations.
///  - **Staged opacity, never a cross-fade.** The leaving step is gone by 35% and the
///    arriving one starts at 25%, so the overlap is ~30ms at low opacity. Fade *through*
///    the surface, not between two legible layers.
///  - **28 logical pixels of travel, not a fraction of the width.** The two steps are
///    different widths; a percentage makes the shorter one travel less for no reason.
///    28px is far enough to name a direction and short enough not to become the event.
///
/// The OS reduce-motion setting collapses all of it to a cut — the same rule the rest of
/// this sheet follows, and the reason the durations are read per swap rather than baked
/// into the controller.
class SheetSteps extends StatefulWidget {
  const SheetSteps({required this.depth, required this.child, super.key});

  /// How deep into the sheet this step is: `0` is the list, `1` is what it opened.
  ///
  /// The number, not a boolean, because it is also the direction: deeper means the
  /// arriving step comes from the right, shallower means it comes from the left, and a
  /// sheet that ever grows a third step needs no new argument to keep reading correctly.
  final int depth;

  /// The step to draw at [depth]. Rebuilt freely — only a change of [depth] animates.
  final Widget child;

  @override
  State<SheetSteps> createState() => _SheetStepsState();
}

/// Long enough for ~300px of height to read as travel; short enough to stay a gesture.
const Duration _kDeeper = Duration(milliseconds: 300);
const Duration _kBack = Duration(milliseconds: 250);

/// Material's emphasized-decelerate: leaves fast, lands soft. Used for the height and
/// the arriving step alike, so nothing settles ahead of anything else.
const Curve _kArrive = Cubic(0.05, 0.7, 0.1, 1.0);

/// The leaving step's opacity, spent in the first third and then out of the way.
const Interval _kLeaveFade = Interval(0.0, 0.35, curve: Curves.easeIn);

/// The arriving step's opacity, starting just before the other has finished.
const Interval _kArriveFade = Interval(0.25, 0.9, curve: Curves.easeOut);

const double _kTravel = 28;

class _SheetStepsState extends State<SheetSteps> with SingleTickerProviderStateMixin {
  /// One controller, one meaning: 0 is *the swap has just begun*, 1 is *settled*. It
  /// rests at 1, so the first build draws the step plainly with no animation to undo.
  late final AnimationController _swap = AnimationController(
    vsync: this,
    duration: _kDeeper,
    value: 1,
  )..addStatusListener(_onSettled);

  /// The step being left: painted, but no longer part of layout.
  Widget? _leaving;

  /// The height that step had while it was the one on screen. Measured rather than
  /// assumed, because it is the whole point — see the class comment.
  double? _leavingHeight;

  bool _deeper = true;

  /// Two anchors, alternating — and the reason they are *global* keys is the whole point.
  ///
  /// A swap moves the leaving step from the live slot into a positioned one. Under a local
  /// key that is a different place in the tree, so its element is rebuilt and every
  /// `State` inside it is born again: the config step would re-read its `initial` and, for
  /// the ~90ms it is still visible, flash the model pill the operator had just moved off.
  /// A `GlobalKey` **reparents** the element instead, `State` and scroll offset intact, so
  /// what fades out is exactly what was on screen.
  final List<GlobalKey> _slots = [
    GlobalKey(debugLabel: 'sheet-step-a'),
    GlobalKey(debugLabel: 'sheet-step-b'),
  ];
  int _slot = 0;
  int _leavingSlot = 1;

  void _onSettled(AnimationStatus status) {
    if (!mounted || status != AnimationStatus.completed || _leaving == null) return;
    // Dropped only once it is invisible *and* the height has arrived; keeping it a frame
    // longer costs nothing, dropping it early would show the sheet without its floor.
    setState(() {
      _leaving = null;
      _leavingHeight = null;
    });
  }

  @override
  void didUpdateWidget(SheetSteps old) {
    super.didUpdateWidget(old);
    if (old.depth == widget.depth) return;

    _deeper = widget.depth > old.depth;

    if (_cut) {
      // A cut has nothing travelling, so there is no leaving step to keep on screen —
      // and clearing it here rather than from the controller's status is what stops a
      // zero-duration swap from calling `setState` inside this very build.
      _leaving = null;
      _leavingHeight = null;
      _swap.value = 1;
      return;
    }

    final box = _slots[_slot].currentContext?.findRenderObject() as RenderBox?;
    _leaving = old.child;
    // `hasSize` is the honest guard: an unlaid-out box has no size to keep, and a
    // guessed one would put the leaving step at a height it never had.
    _leavingHeight = box != null && box.hasSize ? box.size.height : null;
    _leavingSlot = _slot;
    _slot = 1 - _slot;
    _swap
      ..duration = _duration
      ..forward(from: 0);
  }

  /// Whether the OS has asked for no motion. Read per swap rather than cached: the
  /// setting can change while a sheet is open.
  bool get _cut => MediaQuery.disableAnimationsOf(context);

  Duration get _duration => _deeper ? _kDeeper : _kBack;

  @override
  void dispose() {
    _swap.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final leaving = _leaving;
    final leavingHeight = _leavingHeight;

    final steps = Stack(
        alignment: Alignment.topCenter,
        children: [
          // Positioned, so it no longer votes on the sheet's height — and dropped
          // entirely when it could not be measured, which is safer than handing a
          // scrolling step an unbounded box.
          if (leaving != null && leavingHeight != null)
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              height: leavingHeight,
              child: IgnorePointer(
              child: _leave(KeyedSubtree(key: _slots[_leavingSlot], child: leaving)),
            ),
            ),
        _arrive(KeyedSubtree(key: _slots[_slot], child: widget.child)),
      ],
    );

    // No `AnimatedSize` at all under reduce-motion, rather than one with a zero duration:
    // `RenderAnimatedSize` restarts its own controller from inside `performLayout`, and a
    // zero duration completes there and then — re-dirtying the render object mid-layout,
    // which the framework asserts on. A cut needs no animator anyway.
    if (_cut) return steps;

    return AnimatedSize(
      duration: _duration,
      curve: _kArrive,
      // Top-aligned so the grip and the first line stay put while the floor moves. The
      // clip is what turns the leaving step's extra height into something the sheet
      // closes over, rather than overflow.
      alignment: Alignment.topCenter,
      child: steps,
    );
  }

  /// Fades out early and drifts *against* the arrival, so the pair reads as one shove.
  Widget _leave(Widget child) => AnimatedBuilder(
        animation: _swap,
        builder: (context, _) {
          final t = _kLeaveFade.transform(_swap.value);
          return Opacity(
            opacity: 1 - t,
            child: Transform.translate(
              // Shorter travel than the arrival: the step that is going has less to say
              // about where the operator is heading.
              offset: Offset(t * (_deeper ? -_kTravel * 0.7 : _kTravel * 0.7), 0),
              child: child,
            ),
          );
        },
      );

  Widget _arrive(Widget child) => AnimatedBuilder(
        animation: _swap,
        builder: (context, _) {
          final slide = _kArrive.transform(_swap.value);
          return Opacity(
            opacity: _kArriveFade.transform(_swap.value),
            child: Transform.translate(
              offset: Offset((1 - slide) * (_deeper ? _kTravel : -_kTravel), 0),
              child: child,
            ),
          );
        },
      );
}
