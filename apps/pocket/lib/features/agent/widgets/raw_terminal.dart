import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../../../app/theme/theme.dart';
import '../../../data/output_buffer.dart';
import '../../../models/host_id.dart';
import '../terminal_feed.dart';
import '../terminal_geometry.dart';
import '../input_latency_probe.dart';
import '../key_outbox.dart';
import '../sticky_keys.dart';
import '../terminal_search.dart';
import 'find_bar.dart';
import 'immersive_controls.dart';
import 'key_bar.dart';
import 'selection_menu.dart';
import 'terminal_dock.dart';
import 'terminal_metrics.dart';
import 'raw_terminal_surface.dart';

part 'raw_terminal_lift.dart';

/// The PTY as it is — drawn the way *this* pane's output deserves, not one way for all.
///
/// `issues/03` measured a Claude TUI on the alternate screen and concluded: pin to the
/// host's geometry and pan, never reflow. That finding is intact; its *reach* was wrong —
/// applied to every pane, it pinned `git log` to 120 columns and panned that too.
///
/// So the mode is chosen from what the pane keeps doing — [AnsiGuard.paintsScreen],
/// which watches cursor addressing rather than the alternate-screen switch. The first
/// version watched `CSI ? 1049 h` and shipped: sent once at session start, and the host
/// replays only a 64 KB ring, so by the time a phone attaches it has scrolled out and
/// every TUI was classified as line-based and reflowed into nonsense.
///
/// There is deliberately **no manual override** of that classification: reflowing a
/// screen-painter is not a preference, it is a broken render. What the operator gets
/// instead is [TerminalZoom], a font size, find, copy, and keys. Two further
/// shapes came from a real phone: [TerminalGeometry] is measured off a *generously
/// sized* emulator rather than a hardcoded 120×45, and it opens fitted to the width.
class RawTerminal extends StatefulWidget {
  const RawTerminal({
    required this.buffer,
    required this.cell,
    this.onPick,
    this.onAsk,
    this.agent,
    this.onFinding,
    this.onInput,
    this.onToggleLive,
    this.live = false,
    this.provider,
    this.answers,
    this.onSessions,
    this.immersive,
    this.onGrid,
    super.key,
  });

  final OutputBuffer buffer;

  /// Whose output this draws — the buffer is shared across the pager. Not part of the key
  /// on purpose: one emulator lives as long as the page, whichever view is shown.
  final CellRef cell;

  /// Hands a selected line to whoever owns the composer. Never runs it.
  final ValueChanged<String>? onPick;

  /// Hands a selection to Chat as a quote, to ask [agent] about it. Never sends.
  final ValueChanged<String>? onAsk;

  /// Who the selection menu's `Ask` names.
  final String? agent;

  /// Told when the find bar opens and closes, so the page can lend it the header's row.
  final ValueChanged<bool>? onFinding;

  /// Sends bytes to the pane's PTY, completing when the host answered — that `Future` is
  /// what [KeyOutbox] serialises on. Null keeps this terminal read-only, which is what
  /// ADR-6 means until the operator asks otherwise.
  final Future<void> Function(String data)? onInput;

  /// Whether keys reach the pane, owned by the page ([PageMode.live]). The dock's
  /// `Type to session` turns it on; the page's mini bar turns it off.
  final bool live;

  final VoidCallback? onToggleLive;

  /// Which runner is on the other end, so the key bar can offer keys it reads.
  final String? provider;

  /// The prompt's quick answers, drawn right above the dock (v4 tiket 06). Built by the
  /// caller, which holds the ADR-8 gate; here it is only placed — and dropped while keys
  /// are live, when the digit is typed and the keyboard needs the rows.
  final Widget? answers;

  /// The dock's Sessions button (v4 tiket 08); null draws none.
  final VoidCallback? onSessions;

  /// Landscape full screen (v4 tiket 10): the dock gives way to floating controls.
  final ImmersiveExits? immersive;

  /// The area in cells, for the phone's hold on the pane's size (v4 tiket 11).
  final void Function(int cols, int rows)? onGrid;

  @override
  State<RawTerminal> createState() => _RawTerminalState();
}

class _RawTerminalState extends State<RawTerminal> with _SelectionLift {
  late TerminalFeed _feed = _newFeed();

  TerminalFeed _newFeed() => TerminalFeed(
    buffer: widget.buffer,
    cell: widget.cell,
    inputHandler: _sticky.wrap(defaultInputHandler),
    onTyped: _sticky.spend,
    onOutput: (data) {
      // **Empty writes are dropped, and they are not hypothetical.** `CustomTextEdit`
      // takes its delta as `text.substring(initLength, length)`, so an editing-state
      // update that changes nothing — a cursor move, the state echoed back after a
      // reset, the keyboard opening — arrives as `''` and reaches `textInput('')`. Sent
      // on, the host answers 400 *data is required* on every keystroke (device,
      // 2026-08-10); a write of nothing is a no-op anywhere.
      if (widget.live && data.isNotEmpty) _outbox.add(_probe.pressed(data));
    },
  )..addListener(_onFeed);

  /// ctrl and alt, shared by the key bar and the phone's keyboard.
  final _sticky = StickyKeys();

  /// The emulator is replaced when the pane changes what it does; a search pinned to
  /// the old one would point at rows that no longer exist.
  int _generation = 0;

  /// The terminal's own focus. Requesting it opens the phone's keyboard and puts the
  /// caret in the pane; what was missing was anyone asking on the operator's behalf.
  final _focus = FocusNode(debugLabel: 'terminal');

  /// One sender, in order — see [KeyOutbox] for what happened without it.
  late final _outbox = KeyOutbox(_probe.timed((data) async => widget.onInput?.call(data)));
  late final _probe = InputLatencyProbe(widget.buffer, widget.cell); // v4 tiket 12

  TerminalZoom _zoom = TerminalZoom.fit;

  /// How large the cells are drawn. Held here because three things downstream are
  /// measured from it: the text style, the line box, and one cell's advance width.
  double _fontSize = terminalFontSteps[terminalFontDefault];

  /// Ours rather than the library's own: a selection nobody can read cannot be copied.
  @override
  late final _selection = TerminalController()..addListener(_forgetLift);
  /// Non-null while the find bar is up. Rebuilt with the emulator: its hits are rows in
  /// *that* buffer, and a mode switch replaces it.
  TerminalSearch? _search;

  void _onFeed() {
    if (!mounted) return;
    if (_feed.generation != _generation) {
      _generation = _feed.generation;
      final searching = _search != null;
      _search?.dispose();
      _search = searching ? _newSearch() : null;
    }
    setState(() {});
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final palette = context.terminalPalette;
    _search?.restyle(
      otherHit: palette[TermRole.findHit],
      currentHit: palette[TermRole.findHitCurrent],
    );
  }

  @override
  void didUpdateWidget(RawTerminal old) {
    super.didUpdateWidget(old);
    // Keys on: take the keyboard rather than making the operator tap the surface too.
    // Keys off: give it back, or one stays open over a terminal that stopped listening.
    if (old.live != widget.live) {
      if (widget.live) {
        _focus.requestFocus();
      } else {
        _focus.unfocus();
        _sticky.release();
      }
    }
    if (old.buffer == widget.buffer && old.cell == widget.cell) return;
    _feed
      ..removeListener(_onFeed)
      ..dispose();
    _feed = _newFeed();
  }

  @override
  void dispose() {
    _outbox.dispose();
    _probe.dispose();
    _focus.dispose();
    _sticky.dispose();
    _feed
      ..removeListener(_onFeed)
      ..dispose();
    _search?.dispose();
    _selection.dispose();
    _lift.dispose();
    super.dispose();
  }

  /// Opens the find bar, or closes it and takes its highlights with it — the bar's `✕`
  /// and the dock's `⌕` are the same instruction from opposite sides.
  void _toggleFind() {
    final open = _search;
    setState(() {
      open?.dispose();
      _search = open == null ? _newSearch() : null;
    });
    widget.onFinding?.call(open == null);
  }

  /// Rebuilds this widget, not only the bar: the surfaces are aimed from `build`, and
  /// the bar's own listener was showing `1/6` over a viewport still on the cursor.
  TerminalSearch _newSearch() =>
      TerminalSearch(
        terminal: _feed.terminal,
        controller: _selection,
        otherHit: context.terminalPalette[TermRole.findHit],
        currentHit: context.terminalPalette[TermRole.findHitCurrent],
      )
        ..addListener(() => setState(() {}));

  Widget _immersed(Widget terminal) => switch (widget.immersive) {
        null => terminal,
        final exits => ImmersiveControls(
            live: widget.live,
            onChat: exits.onChat,
            onFind: _toggleFind,
            onExit: exits.onExit,
            onKeys: widget.onInput == null ? null : widget.onToggleLive,
            onSessions: widget.onSessions,
            child: terminal,
          ),
      };

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_search case final search?) FindBar(search: search, onClose: _toggleFind),
        // R-4: what is missing is said out loud. The ring buffer is 64 KB, so a long
        // reconnect leaves a hole, and a terminal that looked seamless would be lying.
        ListenableBuilder(
          listenable: widget.buffer,
          builder: (context, _) => widget.buffer.truncated
              ? terminalGapNotice(t, widget.buffer.missingBytes)
              : const SizedBox.shrink(),
        ),
        Expanded(
          child: _immersed(Stack(
            key: _stack,
            children: [
              Positioned.fill(
                child: Listener(
                  onPointerUp: _noteLift,
                  child: RawTerminalSurface(
                    feed: _feed,
                    controller: _selection,
                    live: widget.live,
                    focusNode: _focus,
                    fontSize: _fontSize,
                    zoom: _zoom,
                    focusLine: _search?.focusLine,
                    onGrid: widget.onGrid,
                  ),
                ),
              ),
              Positioned.fill(
                child: SelectionMenu(
                  terminal: _feed.terminal,
                  controller: _selection,
                  anchor: _lift,
                  agent: widget.agent,
                  onSendToChat: widget.onPick,
                  onAsk: widget.onAsk,
                ),
              ),
            ],
          )),
        ),
        // Keys live: the key bar. Keys off: the dock, whose `Type to session` is the one
        // door to typing (v4 tiket 04). Never both — they answer the same question.
        if (widget.answers case final answers? when !widget.live) answers,
        if (widget.live)
          KeyBar(terminal: _feed.terminal, provider: widget.provider, sticky: _sticky)
        else if (widget.immersive == null)
          TerminalDock(
            fit: _feed.fit,
            zoom: _zoom,
            geometry: _feed.geometry,
            fontSize: _fontSize,
            onZoom: (zoom) => setState(() => _zoom = zoom),
            onFontSize: (size) => setState(() => _fontSize = size),
            onFind: _toggleFind,
            onType: widget.onInput == null ? null : widget.onToggleLive,
            onSessions: widget.onSessions,
          ),
      ],
    );
  }
}
