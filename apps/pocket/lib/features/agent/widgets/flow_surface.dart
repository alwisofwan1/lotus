import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:xterm/xterm.dart';

import '../../../app/theme/app_tokens.dart';
import 'terminal_metrics.dart';

/// The emulator drawn at the phone's own width, scrolled like any other text.
///
/// `autoResize: true` is the whole widget: the terminal adopts the viewport's column
/// count and reflows into it. That is exactly what `issues/03` forbade — for a TUI. For
/// line-based output it is the best reading this screen can offer, and it was never
/// available before because the ban was applied to everything.
class FlowSurface extends StatefulWidget {
  const FlowSurface({
    required this.terminal,
    required this.controller,
    required this.theme,
    required this.textStyle,
    this.focusLine,
    this.readOnly = true,
    this.focusNode,
    super.key,
  });

  final Terminal terminal;

  /// Passed rather than left to the library's own. Without it a selection still
  /// happens on a long press and **nothing can read it** — which is how this screen
  /// spent months with copy looking impossible (measured 2026-08-10).
  final TerminalController controller;

  /// An absolute buffer row to bring into view — a search hit. Null leaves the view
  /// where `TerminalView` puts it, which is stuck to the bottom.
  final int? focusLine;

  /// Read-first is the posture this screen opens in (ADR-6), not a ceiling — the
  /// operator turns keys on deliberately.
  final bool readOnly;

  /// Held by the owner so turning keys on can take the keyboard without the operator
  /// having to tap the surface as well.
  final FocusNode? focusNode;

  final TerminalTheme theme;
  final TerminalStyle textStyle;

  @override
  State<FlowSurface> createState() => _FlowSurfaceState();
}

class _FlowSurfaceState extends State<FlowSurface> {
  late final _scroll = ScrollController()..addListener(_noteScroll);

  /// The last line of the buffer when the view left the bottom; null while it follows.
  /// The pill counts the lines after it (v4 tiket 07).
  ///
  /// **A line, not a count of lines**, and the review that changed it is why. Comparing
  /// `buffer.lines.length` stops at the cap (`Terminal.maxLines`, 4000), which a busy pane
  /// reaches and stays at — the pill never came. A line's `index` moves down as old lines
  /// are trimmed off the top, so the count keeps going at the cap.
  ///
  /// Two cases are let go rather than guessed: a reflow replaces the lines (re-anchored
  /// with the count so far as `base` — lines re-wrapped meanwhile are not counted, an
  /// under-count, never invented output), and the alternate screen is another buffer (no
  /// pill while it is up).
  ({Buffer buffer, BufferLine line, int base})? _left;
  int _unread = 0;

  @override
  void initState() {
    super.initState();
    widget.terminal.addListener(_noteOutput);
  }

  @override
  void didUpdateWidget(FlowSurface old) {
    super.didUpdateWidget(old);
    if (old.terminal != widget.terminal) {
      old.terminal.removeListener(_noteOutput);
      widget.terminal.addListener(_noteOutput);
      _left = null;
      _unread = 0;
    }
    if (old.focusLine != widget.focusLine) _follow();
  }

  @override
  void dispose() {
    widget.terminal.removeListener(_noteOutput);
    _scroll.dispose();
    super.dispose();
  }

  /// The same test `RenderTerminal` makes to decide whether it sticks to the bottom, so
  /// the pill and the emulator never disagree about what "following" means.
  void _noteScroll() {
    final p = _scroll.position;
    final following = p.pixels >= p.maxScrollExtent;
    if (following) {
      if (_left == null) return;
      setState(() {
        _left = null;
        _unread = 0;
      });
    } else {
      _left ??= _lastLine();
    }
  }

  /// [base] is what was already counted, carried over when a reflow re-anchors.
  ({Buffer buffer, BufferLine line, int base})? _lastLine([int base = 0]) {
    final buffer = widget.terminal.buffer;
    final lines = buffer.lines;
    return lines.length == 0
        ? null
        : (buffer: buffer, line: lines[lines.length - 1], base: base);
  }

  void _noteOutput() {
    var left = _left;
    if (left == null || !mounted) return;
    final buffer = widget.terminal.buffer;
    if (!left.line.attached && buffer == left.buffer) {
      left = _left = _lastLine(_unread);
      if (left == null) return;
    }
    final unread = buffer != left.buffer
        ? 0
        : left.base + buffer.lines.length - 1 - left.line.index;
    if (unread == _unread) return;
    // `autoResize` resizes the emulator from inside layout, and a resize notifies too —
    // a rebuild asked for then is an assertion, so it waits for the frame to end.
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      SchedulerBinding.instance.addPostFrameCallback((_) => _noteOutput());
      return;
    }
    setState(() => _unread = unread);
  }

  /// Back to the bottom; `RenderTerminal` sees the offset at the end and follows again.
  void _latest() {
    if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
  }

  /// Brings the current match into view.
  ///
  /// **The mapping is measured, not assumed.** `TerminalView`'s scroll is linear in
  /// buffer lines: offset 0 is the top of the buffer, the view opens at the bottom, and
  /// one line is `maxScrollExtent / (lines - viewHeight)` — read off a live view on
  /// 2026-08-10, because the widget underneath is called `InfiniteScrollView` and that
  /// name suggests something far worse than the truth.
  void _follow() {
    final line = widget.focusLine;
    if (line == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final scrollable = widget.terminal.buffer.lines.length - widget.terminal.viewHeight;
      if (scrollable <= 0) return;
      final max = _scroll.position.maxScrollExtent;
      // A third of a screen above the hit, so the lines that led to it come with it.
      final target = (line - widget.terminal.viewHeight / 3) * (max / scrollable);
      _scroll.jumpTo(target.clamp(0.0, max));
    });
  }

  @override
  Widget build(BuildContext context) => Stack(
        children: [
          Positioned.fill(child: _view()),
          // No permanent button: the operator read `↓` in the dock as *download*. This
          // exists only while there is something below to go back to.
          if (_unread > 0)
            Positioned(
              left: 0,
              right: 0,
              bottom: 12,
              child: Center(child: NewLinesPill(count: _unread, onTap: _latest)),
            ),
        ],
      );

  Widget _view() => TerminalView(
        widget.terminal,
        controller: widget.controller,
        scrollController: _scroll,
        autoResize: true,
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
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      );
}

/// `↓ 12 new lines` — what arrived below while the operator read further up.
class NewLinesPill extends StatelessWidget {
  const NewLinesPill({required this.count, required this.onTap, super.key});

  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(18),
      side: BorderSide(color: t.lineStrong),
    );

    return Semantics(
      button: true,
      label: 'Jump to latest, $count new',
      excludeSemantics: true,
      child: Material(
        color: Color.alphaBlend(t.raise, t.bg),
        elevation: 4,
        shape: shape,
        child: InkWell(
          onTap: onTap,
          customBorder: shape,
          child: Container(
            height: 36,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            alignment: Alignment.center,
            child: Text(
              '↓ $count new ${count == 1 ? 'line' : 'lines'}',
              style: t.mono.copyWith(fontSize: 12, color: t.text),
            ),
          ),
        ),
      ),
    );
  }
}
