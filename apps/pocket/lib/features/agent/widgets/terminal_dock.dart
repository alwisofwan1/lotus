import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../../app/theme/surface_tokens.dart';
import '../../shared/field_glyphs.dart';
import '../../shared/tactile.dart';
import '../terminal_geometry.dart';
import 'terminal_look.dart';

/// The foot of Terminal while keys are off: `⌨ Type to session  120×38 · ⌕ · Aa` (mockup B1).
///
/// Replaces `TerminalBar` (v4 tiket 04), and with it the second way of typing into a PTY.
/// The bar sat at the top and carried a keys toggle among five other controls; the
/// composer under it carried a one-line field that went through `/dispatch`. Now there is
/// one door, wide and at the thumb, and it leads to one path: emulator → `KeyOutbox` →
/// `/input`. Once it is open the dock gives its row to the key bar, and the page's mini
/// bar holds the way back.
///
/// Find stays a square of its own; `Aa` keeps the look (`FIT`, `1:1`, `A−`, `A+`). The
/// bar's palette `{}` and full screen `⤢` were dropped on 2026-10-04 at the operator's
/// call, for a cleaner dock — full screen returns as landscape in tiket 10. Sessions
/// (tiket 08) opens this pager's agents; absent when nothing handed it a sheet.
class TerminalDock extends StatefulWidget {
  const TerminalDock({
    required this.fit,
    required this.zoom,
    required this.geometry,
    required this.fontSize,
    required this.onZoom,
    required this.onFontSize,
    required this.onFind,
    this.onType,
    this.onSessions,
    super.key,
  });

  final TerminalFit fit;
  final TerminalZoom zoom;

  /// What the pane is actually using, measured — stated on the Type button so the
  /// operator knows the size of what they are about to type into.
  final TerminalGeometry geometry;

  final double fontSize;
  final ValueChanged<TerminalZoom> onZoom;
  final ValueChanged<double> onFontSize;
  final VoidCallback onFind;

  /// Turns keys on. Null on a host with nowhere to send them, which leaves no button.
  final VoidCallback? onType;

  /// Opens the Sessions sheet (v4 tiket 08). Null draws no button.
  final VoidCallback? onSessions;

  static const double button = 48;

  @override
  State<TerminalDock> createState() => _TerminalDockState();
}

class _TerminalDockState extends State<TerminalDock> {
  /// Whether `Aa` is open. Here rather than in `RawTerminal` for the reason it lived in
  /// the bar: this widget already has every number the panel shows.
  bool _look = false;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_look)
          TerminalLook(
            fit: widget.fit,
            zoom: widget.zoom,
            fontSize: widget.fontSize,
            onZoom: widget.onZoom,
            onFontSize: widget.onFontSize,
          ),
        Container(
          color: t.termBg,
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
          child: Row(
            children: [
              Expanded(child: widget.onType == null ? _size(t) : _type(t, widget.onType!)),
              if (widget.onSessions case final onSessions?) ...[
                const SizedBox(width: 8),
                _square(
                  t,
                  label: 'Sessions',
                  onTap: onSessions,
                  child: SessionsGlyph(color: t.dim, size: 17),
                ),
              ],
              const SizedBox(width: 8),
              _square(
                t,
                label: 'Find in output',
                onTap: widget.onFind,
                child: SearchGlyph(color: t.dim, size: 17),
              ),
              const SizedBox(width: 8),
              _square(
                t,
                label: 'Text size and zoom',
                on: _look,
                onTap: () => setState(() => _look = !_look),
                child: Text('Aa', style: t.ui.copyWith(fontSize: 15, color: t.dim)),
              ),
            ],
          ),
        ),
      ],
    );
  }

  /// Words, never `160×48`: a wrapped pane takes the phone's width, a pinned one keeps
  /// the host's and pans. The raw size was jargon on a phone (LOT2-104).
  String get _sizeLabel => widget.fit == TerminalFit.flow ? 'WRAPPED' : 'FIXED WIDTH';

  Widget _size(AppTokens t) => Text(
        _sizeLabel,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: t.mono.copyWith(fontSize: 11, letterSpacing: 1.1, color: t.dim),
      );

  Widget _type(AppTokens t, VoidCallback onType) => Semantics(
        button: true,
        label: 'Type to session',
        excludeSemantics: true,
        child: Material(
          color: t.raise2,
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: () {
              Tactile.chose();
              onType();
            },
            child: SizedBox(
              height: TerminalDock.button,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: Row(
                  children: [
                    KeyboardGlyph(color: t.text, size: 17),
                    const SizedBox(width: 10),
                    Expanded(
                      child: LayoutBuilder(builder: (context, box) => _typeWords(t, box.maxWidth)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );

  /// `Type to session`, and the size label only when both fit. The action keeps its
  /// words: beside a flexing `FIXED WIDTH` it read `Type to s…` at 360dp (review, LOT2-104).
  Widget _typeWords(AppTokens t, double width) {
    final title = t.ui.copyWith(fontSize: 14, fontWeight: FontWeight.w500, color: t.text);
    final label = t.mono.copyWith(fontSize: 11, color: t.faint);
    final scaler = MediaQuery.textScalerOf(context);
    double measure(String text, TextStyle style) => (TextPainter(
          text: TextSpan(text: text, style: style),
          textScaler: scaler,
          textDirection: TextDirection.ltr,
          maxLines: 1,
        )..layout())
            .width;
    final room = measure('Type to session', title) + 8 + measure(_sizeLabel, label) <= width;
    return Row(
      children: [
        Expanded(
          child: Text('Type to session', maxLines: 1, overflow: TextOverflow.ellipsis, style: title),
        ),
        if (room) ...[const SizedBox(width: 8), Text(_sizeLabel, maxLines: 1, style: label)],
      ],
    );
  }

  Widget _square(
    AppTokens t, {
    required String label,
    required VoidCallback onTap,
    required Widget child,
    bool on = false,
  }) =>
      Semantics(
        button: true,
        toggled: on,
        label: label,
        excludeSemantics: true,
        child: Material(
          color: on ? t.keyHi : t.raise,
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: () {
              Tactile.chose();
              onTap();
            },
            child: SizedBox.square(dimension: TerminalDock.button, child: Center(child: child)),
          ),
        ),
      );
}
