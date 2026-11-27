import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../../../app/theme/theme.dart';
import 'terminal_metrics.dart';
import '../terminal_geometry.dart';

/// The host's screen, shown whole and then zoomed into — the way any viewer shows a
/// remote display it is not allowed to resize.
///
/// **Termux is the reference the design was asked for, and the one thing Termux never
/// does is pan: it resizes the PTY to the phone.** That is closed to us — ADR-6 is
/// read-first, and `issues/03` rejected resizing the host outright because it would
/// reflow the pane the operator is looking at on their own desktop. What is left is the
/// remote-screen idiom: fit the whole width by default, pinch to read.
///
/// That inverts what this widget did before. Opening at 1:1 and panning meant the
/// operator never saw the shape of the screen they were on, only a keyhole into it —
/// and every glance started with a hunt. Fitting first costs legibility that a pinch
/// buys straight back, and it makes the first frame *orienting* rather than confusing.
///
/// Vertical position still follows the cursor: the width is settled by fitting, the
/// depth is not.
class PinnedSurface extends StatefulWidget {
  const PinnedSurface({
    required this.terminal,
    required this.controller,
    required this.geometry,
    required this.cellWidth,
    required this.lineHeight,
    required this.theme,
    required this.textStyle,
    required this.revision,
    required this.zoom,
    this.focusLine,
    this.readOnly = true,
    this.focusNode,
    super.key,
  });

  final Terminal terminal;

  /// See [FlowSurface.controller] — the same reason, and the same object.
  final TerminalController controller;

  /// See [FlowSurface.readOnly].
  final bool readOnly;

  /// Held by the owner so turning keys on can take the keyboard without the operator
  /// having to tap the surface as well.
  final FocusNode? focusNode;

  final TerminalGeometry geometry;
  final double cellWidth;
  final double lineHeight;
  final TerminalTheme theme;
  final TerminalStyle textStyle;

  /// Bumped by the owner whenever new bytes land, so the viewport can follow the cursor
  /// without this widget having to subscribe to the stream a second time.
  final int revision;

  /// How close to look. Changing it re-aims the viewport even after the operator has
  /// panned — asking for a zoom *is* asking to be moved.
  final TerminalZoom zoom;

  /// An absolute buffer row to show instead of the cursor — a search hit. Asking for a
  /// match *is* asking to be moved, so it overrides a steer exactly as a zoom does.
  final int? focusLine;

  @override
  State<PinnedSurface> createState() => _PinnedSurfaceState();
}

class _PinnedSurfaceState extends State<PinnedSurface> {
  final _view = TransformationController();

  /// Set the moment the operator pans or pinches, and never cleared while the surface
  /// is up. Following is a convenience for arriving; continuing to yank the viewport
  /// after they have chosen where to look would be the sticky-scroll bug of the chat
  /// list, on a surface where it is harder to undo.
  bool _steered = false;

  @override
  void didUpdateWidget(PinnedSurface old) {
    super.didUpdateWidget(old);
    // A zoom change is an instruction, so it overrides a steer; new bytes are not.
    //
    // So is a text-size change, and for the same reason: the operator asked to look
    // differently, and leaving the viewport where it was would drop them somewhere else
    // in a screen that just changed size under them. Both cell metrics are checked
    // because either alone can move — the advance width comes from the platform font.
    if (old.zoom != widget.zoom ||
        old.focusLine != widget.focusLine ||
        old.cellWidth != widget.cellWidth ||
        old.lineHeight != widget.lineHeight) {
      _steered = false;
      _aim();
    } else if (old.revision != widget.revision || old.geometry != widget.geometry) {
      _aim();
    }
  }

  @override
  void initState() {
    super.initState();
    _aim();
  }

  @override
  void dispose() {
    _view.dispose();
    super.dispose();
  }

  double get _contentWidth => widget.cellWidth * widget.geometry.columns;

  double get _contentHeight => widget.lineHeight * widget.geometry.rows;

  /// The emulator's whole screen — never less than what is shown of it.
  double get _screenHeight =>
      widget.lineHeight * math.max(widget.terminal.viewHeight, widget.geometry.rows);

  double _fitScale(double viewportWidth) =>
      _contentWidth <= 0 ? 0.3 : (viewportWidth / _contentWidth).clamp(0.15, 1.0);

  /// Points the viewport at the cursor, at the requested zoom.
  ///
  /// Post-frame because the viewport's size is not known until layout has run, and a
  /// transform computed against a zero-sized box lands nowhere.
  void _aim() {
    if (_steered) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _steered) return;
      final box = context.findRenderObject() as RenderBox?;
      if (box == null || !box.hasSize || _contentWidth <= 0) return;

      final fit = _fitScale(box.size.width);
      final scale = widget.zoom == TerminalZoom.fit ? fit : 1.0;
      final buffer = widget.terminal.buffer;

      // The row within the window the surface draws, never the absolute row in the
      // buffer — see `cursorRowInWindow`. A scrolling CLI's absolute row is thousands of
      // lines deep, and translating by it aimed this viewport clean off the content.
      // A search hit is aimed at the same way the cursor is — both are absolute rows in
      // a buffer whose drawn window is only the last `rows` of it.
      final cursorRow = cursorRowInWindow(
        absoluteCursorY: widget.focusLine ?? buffer.absoluteCursorY,
        totalLines: buffer.lines.length,
        rows: widget.geometry.rows,
        screen: widget.terminal.viewHeight,
      );
      final cursorY = (cursorRow + 1) * widget.lineHeight;
      // Two thirds down rather than flush to the bottom: the lines *above* the cursor
      // are the ones that say what just happened.
      final dy = (cursorY - (box.size.height / scale) * 0.66).clamp(0.0, double.infinity);
      // At 1:1 the width no longer fits, so the column matters too. At fit it is always
      // zero, because the whole width is on screen.
      final dx = widget.zoom == TerminalZoom.fit
          ? 0.0
          : (buffer.cursorX * widget.cellWidth - (box.size.width / scale) * 0.5)
              .clamp(0.0, double.infinity);

      // Translate first, then scale — the matrix is applied right to left, so this
      // shifts the content and then scales the result, which is what "zoom to a point"
      // means. Composed the other way it would scroll by scaled pixels and drift.
      _view.value = Matrix4.identity()
        ..scaleByDouble(scale, scale, 1, 1)
        ..translateByDouble(-dx, -dy, 0, 1);
    });
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
        builder: (context, box) {
          // Zooming out past the fitted width would only add empty margins — there is
          // nothing further out to see.
          final fit = _fitScale(box.maxWidth);

          return InteractiveViewer(
            transformationController: _view,
            constrained: false,
            minScale: fit,
            // Four, not three: at a fitted 93 columns the text is around 7px, and a
            // pinch has to reach something a person can actually read.
            maxScale: 4,
            boundaryMargin: const EdgeInsets.all(24),
            onInteractionStart: (_) => _steered = true,
            // **The emulator is laid out at its whole screen and clipped to the host's
            // rows** (LOT2-103). It is built `roomyRows` deep and a host using fewer
            // draws in the *top* of that screen, while `TerminalView` shows — and on
            // every key jumps to — the *bottom* of its buffer. Sized to the host's rows,
            // the view scrolled 27 empty rows past a 21-row Claude pane and every letter
            // typed threw the prompt out of sight (device, 2026-10-04). At full depth its
            // bottom *is* the screen, and the clip keeps the empty rows off the surface.
            child: SizedBox(
              width: _contentWidth,
              height: _contentHeight,
              child: ClipRect(
                child: OverflowBox(
                  alignment: Alignment.topLeft,
                  minHeight: _screenHeight,
                  maxHeight: _screenHeight,
                  child: TerminalView(
                widget.terminal,
                controller: widget.controller,
                // Both flags are the point. `autoResize` would adopt the widget's width
                // and undo the pinning; `readOnly` makes ADR-6's read-first a guarantee
                // the library enforces rather than a discipline we remember.
                autoResize: false,
                readOnly: widget.readOnly,
                // `visiblePassword` rather than the library's `emailAddress` default. A terminal
                // is not prose, and `enableSuggestions: false` is a hint Android keyboards feel
                // free to ignore — SwiftKey kept a prediction strip over `clear`/`clearly` on a
                // device 2026-08-10. This input type is the one they honour: no suggestions, no
                // auto-capitals, no smart punctuation turning `--` into an em dash.
                // **Backspace does not exist without this.** `CustomTextEdit` starts its editing
                // state empty, so deleting from an empty field changes nothing, the IME sends no
                // update, and `onDelete` never fires — measured on a device 2026-08-10, where the
                // key was simply dead. Set, the state starts as two spaces and a delete shortens
                // it, which is what the package's own doc calls "preferred on mobile platforms".
                deleteDetection: true,
                keyboardType: TextInputType.visiblePassword,
        // Measured unscaled, so drawn unscaled (`terminalTextScaler`).
        textScaler: terminalTextScaler,

                focusNode: widget.focusNode,
                backgroundOpacity: 0,
                theme: widget.theme,
                textStyle: widget.textStyle,
                padding: EdgeInsets.zero,
              ),
                ),
              ),
            ),
          );
        },
      );
}

/// xterm's theme, read straight from the palette; the choices live in `palettes/`.
TerminalTheme terminalTheme(TerminalPalette p) => TerminalTheme(
      cursor: p[TermRole.cursor],
      selection: p[TermRole.selection],
      foreground: p[TermRole.foreground],
      background: p[TermRole.background],
      black: p[TermRole.black],
      white: p[TermRole.white],
      red: p[TermRole.red],
      green: p[TermRole.green],
      yellow: p[TermRole.yellow],
      blue: p[TermRole.blue],
      magenta: p[TermRole.magenta],
      cyan: p[TermRole.cyan],
      brightBlack: p[TermRole.brightBlack],
      brightRed: p[TermRole.brightRed],
      brightGreen: p[TermRole.brightGreen],
      brightYellow: p[TermRole.brightYellow],
      brightBlue: p[TermRole.brightBlue],
      brightMagenta: p[TermRole.brightMagenta],
      brightCyan: p[TermRole.brightCyan],
      brightWhite: p[TermRole.brightWhite],
      searchHitBackground: p[TermRole.searchHitBackground],
      searchHitBackgroundCurrent: p[TermRole.searchHitBackgroundCurrent],
      searchHitForeground: p[TermRole.searchHitForeground],
    );
