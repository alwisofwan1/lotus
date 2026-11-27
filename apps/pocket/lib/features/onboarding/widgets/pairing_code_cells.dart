import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/theme.dart';
import 'pairing_code_cell.dart';

/// The pairing code as eight cells, grouped four and four.
///
/// **Grouped the way the desktop prints it.** `MobileTab` shows `1234 5678`, so the eye
/// matches two short groups instead of counting along one run of eight — and a slip in
/// that count only surfaces later as a 401.
///
/// **One real [TextField] underneath, the cells only draw it.** Typing, paste (`1234
/// 5678`, `1234-5678`), the keyboard's one-time-code autofill and a scan writing
/// [controller] all go through the same field, so there is one value and one set of
/// formatters. The field stays in the tree, transparent, over the cells.
///
/// Motion is adapted from Planes' free OTP Input (useplanes.com/r/otp-input.json):
/// digits rise in and drop out, the active cell lifts, a refused code shakes once. Three
/// departures:
///
/// - **Only the host says a code is wrong.** Planes checks a `correctCode` locally; here
///   [refused] is set by the screen from `PairingCodeRefused` (a 401) and nothing else.
///   A throttled or unreachable host does not shake: the code in hand may be good.
/// - **The dead code stays readable.** Planes clears 600ms after an error. Here it stays
///   under red so it can be compared with the desktop, and the next edit starts over
///   from what was typed (a keystroke, a paste) rather than appending to a dead code.
/// - **No success pop.** The screen leaves on success, and Pocket has no success green.
///
/// Under reduced motion digits just appear, nothing shakes and the caret holds still.
class PairingCodeCells extends StatefulWidget {
  const PairingCodeCells({
    required this.label,
    required this.controller,
    this.length = 8,
    this.refused = false,
    this.enabled = true,
    this.onFilled,
    super.key,
  });

  final String label;
  final TextEditingController controller;
  final int length;

  /// True after the host refused this code. A rise from false shakes the row once.
  final bool refused;

  final bool enabled;

  /// Called when an edit by the operator — not a scan — completes the code.
  final VoidCallback? onFilled;

  @override
  State<PairingCodeCells> createState() => _PairingCodeCellsState();
}

/// Between two digits of a group, and between the two groups.
const double _cellGap = 6;
const double _groupGap = 16;
const Duration _stagger = Duration(milliseconds: 30);
const List<double> _shakeX = [0, -8, 8, -6, 6, -3, 3, 0];

class _PairingCodeCellsState extends State<PairingCodeCells> with TickerProviderStateMixin {
  final _focus = FocusNode();
  late final _shake = AnimationController(vsync: this, duration: const Duration(milliseconds: 450));
  late final _caret = AnimationController(vsync: this, duration: const Duration(seconds: 1));

  /// The code on screen was refused and no edit has happened since.
  late bool _dead = widget.refused;

  /// Where a multi-digit fill (paste, scan) began, so its digits enter left to right.
  int? _bulkFrom;
  late int _shown = _digits.length;

  String get _digits => widget.controller.text;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onText);
    _focus.addListener(_onFocus);
  }

  @override
  void didUpdateWidget(PairingCodeCells old) {
    super.didUpdateWidget(old);
    if (old.controller != widget.controller) {
      old.controller.removeListener(_onText);
      widget.controller.addListener(_onText);
    }
    if (widget.refused && !old.refused) {
      _dead = true;
      if (!_still) _shake.forward(from: 0);
    } else if (!widget.refused && old.refused) {
      // A retry of the same code: nothing has been refused this time, yet.
      _dead = false;
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onText);
    _focus.dispose();
    _shake.dispose();
    _caret.dispose();
    super.dispose();
  }

  bool get _still => MediaQuery.disableAnimationsOf(context);

  void _onText() {
    final now = _digits.length;
    if (now == _shown) return;
    setState(() {
      _bulkFrom = now - _shown > 1 ? _shown : null;
      _shown = now;
    });
  }

  void _onFocus() {
    if (_focus.hasFocus && !_still) {
      _caret.repeat();
    } else {
      _caret.stop();
    }
    setState(() {});
  }

  /// After a refusal the next edit starts over instead of extending a dead code: an
  /// appended keystroke or paste keeps only what was added, a deletion empties the field.
  TextEditingValue _restart(TextEditingValue before, TextEditingValue after) {
    if (!_dead || after.text == before.text) return after;
    setState(() => _dead = false);
    final String text;
    if (after.text.startsWith(before.text)) {
      text = after.text.substring(before.text.length);
    } else if (before.text.startsWith(after.text)) {
      text = '';
    } else {
      text = after.text;
    }
    return TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length));
  }

  void _toEnd() {
    final end = widget.controller.text.length;
    widget.controller.selection = TextSelection.collapsed(offset: end);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final still = _still;
    final active = _focus.hasFocus && widget.enabled ? math.min(_digits.length, widget.length - 1) : null;

    Widget cell(int i) => PairingCodeCell(
          digit: i < _digits.length ? _digits[i] : null,
          active: i == active,
          dead: _dead,
          still: still,
          caret: _caret,
          delay: _bulkFrom != null && i >= _bulkFrom! ? _stagger * (i - _bulkFrom!) : Duration.zero,
        );

    final half = widget.length ~/ 2;
    Widget group(int from, int to) => Expanded(
          child: Row(
            children: [
              for (var i = from; i < to; i++) ...[
                if (i > from) const SizedBox(width: _cellGap),
                Expanded(child: cell(i)),
              ],
            ],
          ),
        );

    final cells = AnimatedBuilder(
      animation: _shake,
      builder: (context, child) {
        final p = _shake.value * (_shakeX.length - 1);
        final k = p.floor().clamp(0, _shakeX.length - 2);
        final x = _shakeX[k] + (_shakeX[k + 1] - _shakeX[k]) * (p - k);
        return Transform.translate(offset: Offset(x, 0), child: child);
      },
      child: ExcludeSemantics(
        child: Row(
          children: [group(0, half), const SizedBox(width: _groupGap), group(half, widget.length)],
        ),
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(widget.label, style: t.ui.copyWith(fontSize: 11.5, color: t.muted)),
        const SizedBox(height: 7),
        AnimatedOpacity(
          opacity: widget.enabled ? 1 : 0.55,
          duration: still ? Duration.zero : const Duration(milliseconds: 180),
          child: SizedBox(
            height: 48,
            child: Stack(
              children: [
                Positioned.fill(child: cells),
                Positioned.fill(
                  child: TextSelectionTheme(
                    data: const TextSelectionThemeData(
                      selectionColor: Colors.transparent,
                      selectionHandleColor: Colors.transparent,
                    ),
                    child: Semantics(
                      label: widget.label,
                      child: TextField(
                        controller: widget.controller,
                        focusNode: _focus,
                        enabled: widget.enabled,
                        expands: true,
                        maxLines: null,
                        showCursor: false,
                        autocorrect: false,
                        enableSuggestions: false,
                        keyboardType: TextInputType.number,
                        autofillHints: const [AutofillHints.oneTimeCode],
                        // Restart first, so a paste after a refusal is judged whole;
                        // then the desktop's space or a dash is dropped, not refused.
                        inputFormatters: [
                          _Restart(_restart),
                          FilteringTextInputFormatter.digitsOnly,
                          LengthLimitingTextInputFormatter(widget.length),
                        ],
                        onTap: _toEnd,
                        onChanged: (value) {
                          if (value.length == widget.length) widget.onFilled?.call();
                        },
                        style: const TextStyle(color: Colors.transparent, fontSize: 1),
                        decoration: const InputDecoration.collapsed(hintText: null),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _Restart extends TextInputFormatter {
  _Restart(this.apply);

  final TextEditingValue Function(TextEditingValue, TextEditingValue) apply;

  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) =>
      apply(oldValue, newValue);
}
