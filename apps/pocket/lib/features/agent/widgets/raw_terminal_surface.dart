import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../../../app/theme/theme.dart';
import '../terminal_feed.dart';
import '../terminal_geometry.dart';
import 'flow_surface.dart';
import 'terminal_metrics.dart';
import 'terminal_surface.dart';

/// Which of the two surfaces draws [feed], chosen from what the pane keeps doing.
///
/// Split out of `raw_terminal.dart`, which sat at the 300-line ceiling: this is the part
/// that is only pixels, and it holds no state — the zoom, the font size and the selection
/// belong to the terminal that owns the emulator, so they survive this being rebuilt.
class RawTerminalSurface extends StatelessWidget {
  const RawTerminalSurface({
    required this.feed,
    required this.controller,
    required this.live,
    required this.focusNode,
    required this.fontSize,
    required this.zoom,
    this.focusLine,
    this.onGrid,
    super.key,
  });

  final TerminalFeed feed;
  final TerminalController controller;

  /// Whether keys reach the pane; a surface nobody may type into is read-only.
  final bool live;
  final FocusNode focusNode;
  final double fontSize;
  final TerminalZoom zoom;
  final int? focusLine;

  /// Told how many cells fit the area at [fontSize] — what the phone asks the pane to be
  /// (v4 tiket 11). Reported after every layout; the listener drops repeats.
  final void Function(int cols, int rows)? onGrid;

  @override
  Widget build(BuildContext context) {
    final report = onGrid;
    if (report == null) return _surface(context);
    return LayoutBuilder(builder: (context, box) {
      // The flow surface pads its text; the pinned one draws edge to edge.
      final inset = feed.fit == TerminalFit.flow ? const Size(24, 20) : Size.zero;
      final cols = ((box.maxWidth - inset.width) / terminalCellWidth(fontSize)).floor();
      final rows = ((box.maxHeight - inset.height) / terminalLineHeight(fontSize)).floor();
      WidgetsBinding.instance.addPostFrameCallback((_) => report(cols, rows));
      return _surface(context);
    });
  }

  Widget _surface(BuildContext context) {
    final style = TerminalStyle(
      fontSize: fontSize,
      fontFamily: 'monospace',
      fontFamilyFallback: terminalFontFallback,
    );

    if (feed.fit == TerminalFit.flow) {
      return FlowSurface(
        terminal: feed.terminal,
        controller: controller,
        readOnly: !live,
        focusNode: focusNode,
        focusLine: focusLine,
        theme: terminalTheme(context.terminalPalette),
        textStyle: style,
      );
    }

    return PinnedSurface(
      terminal: feed.terminal,
      controller: controller,
      readOnly: !live,
      focusNode: focusNode,
      geometry: feed.geometry,
      cellWidth: terminalCellWidth(fontSize),
      lineHeight: terminalLineHeight(fontSize),
      theme: terminalTheme(context.terminalPalette),
      textStyle: style,
      revision: feed.revision,
      zoom: zoom,
      focusLine: focusLine,
    );
  }
}
