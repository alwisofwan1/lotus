part of 'raw_terminal.dart';

/// Where a finished selection sits, so the selection menu floats beside its text — lifted
/// out of `raw_terminal.dart` at the 300-line limit (v4 tiket 10), one concern per file.
mixin _SelectionLift on State<RawTerminal> {
  TerminalController get _selection;

  /// Where the current selection's text is — the menu floats beside it.
  final _lift = ValueNotifier<Rect?>(null);

  /// The selection [_lift] was taken for. A lift that changes nothing — a scroll, a tap
  /// on the menu itself — must not move the menu away from the text (review, 2026-10-04).
  BufferRange? _liftedFor;

  final _stack = GlobalKey();

  /// A cleared selection forgets where it was: the same word held again after a scroll
  /// is the same range, and must be measured again (review, LOT2-104).
  void _forgetLift() {
    if (_selection.selection == null) _liftedFor = null;
  }

  /// Measured on the lift because that is when a selection is finished. The text, not
  /// the thumb: a drag downwards lifted the thumb below the lines it chose, and the menu
  /// covered them (LOT2-104).
  void _noteLift(PointerUpEvent lift) {
    final range = _selection.selection;
    final stack = _stack.currentContext;
    if (range == null || range == _liftedFor || stack == null) return;
    _liftedFor = range;
    _lift.value = selectionBounds(stack, range, stack.findRenderObject()! as RenderBox) ??
        Rect.fromCenter(center: lift.localPosition, width: 0, height: 0);
  }
}
