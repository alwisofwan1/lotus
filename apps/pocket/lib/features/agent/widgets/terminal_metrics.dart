import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';

/// How large the terminal draws its cells, as steps rather than a slider.
///
/// A slider on a surface that already owns pan and pinch is a fourth gesture competing
/// for the same thumb; two buttons are unambiguous and can be hit without looking.
///
/// The list is deliberately short and the ends are deliberately far apart. 8.5 is for
/// seeing the *shape* of a wide screen at a glance — below that `issues/03` measured that
/// the geometry is right and the text is not human. 18 is for reading a permission prompt
/// while walking, which is the case that made this control necessary: at the fitted width
/// of a 93-column host the text lands around 7px, and 7px is not a size, it is a rumour.
const List<double> terminalFontSteps = [8.5, 10, 11, 13, 15.5, 18];

/// Where a freshly opened terminal starts: the size this screen has always used.
const int terminalFontDefault = 2;

/// **The terminal ignores the phone's font-size setting.** xterm's `TerminalView` scales its
/// text by `MediaQuery.textScalerOf` unless told otherwise; [terminalCellWidth] and
/// [terminalLineHeight] measure unscaled. On a phone set to 0.85 (Infinix X6880,
/// 2026-10-05) every cell came out 15% smaller than measured: a 59-column pane drawn in 85%
/// of the width, and "11px" in the dock was really 9.35px. One scale for both sides, and the
/// terminal's own A−/A+ is the size control — so: none.
const TextScaler terminalTextScaler = TextScaler.noScaling;

/// The line box for a given cell size. 1.4 is the ratio the pinned surface has always
/// been laid out with, kept in one place now that the size can move.
double terminalLineHeight(double fontSize) => fontSize * 1.4;

/// The advance width of one cell, measured rather than assumed. A hardcoded ratio would
/// drift with the platform's monospace font and quietly make the pannable surface the
/// wrong size.
///
/// Measured on demand rather than cached against the size: it is one `layout` of a
/// single glyph, and a cache keyed on the size would still have to be invalidated by a
/// platform font change it cannot observe.
double terminalCellWidth(double fontSize) {
  final painter = TextPainter(
    text: TextSpan(
      text: '0',
      style: TextStyle(
        fontSize: fontSize,
        fontFamily: 'monospace',
        fontFamilyFallback: terminalFontFallback,
      ),
    ),
    textDirection: TextDirection.ltr,
  )..layout();
  return painter.width;
}

/// A separator with a rule beneath it, not a block with a coloured stripe down its
/// left — that shape is banned in this design.
Widget terminalGapNotice(AppTokens t, int missing) => Container(
      margin: const EdgeInsets.only(left: 16, right: 16, bottom: 6),
      padding: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: t.waiting))),
      child: Text(
        '$missing bytes never arrived — the ring buffer had already moved past them.',
        style: t.mono.copyWith(fontSize: 11.5, height: 1.6, color: t.waiting),
      ),
    );

/// The app's own symbol font (`pubspec.yaml`), for the glyphs a TUI draws that no phone
/// font has — Claude's `⏵⏵` arrived as `□□` (LOT2-104).
const terminalSymbolFont = 'LotusSymbols';

/// After `monospace`: the desktop monos first, the symbols **last**, so they only fill
/// gaps and never change the width of a cell that already had a glyph.
const terminalFontFallback = ['Menlo', 'SF Mono', 'Consolas', terminalSymbolFont];
