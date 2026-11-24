import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:xterm/xterm.dart';

import '../../data/output_buffer.dart';
import '../../models/host_id.dart';
import 'ansi_guard.dart';
import 'terminal_geometry.dart';

/// The emulator, fed and classified.
///
/// Pulled out of the widget when the terminal grew find, copy, a palette and keys, and
/// `raw_terminal.dart` stopped fitting in one pass. It is a real collaborator rather
/// than a slice: everything here answers one question — *what is on the other end, and
/// how should it be drawn* — and none of it is about pixels.
///
/// The classification is the load-bearing part. Whether a pane may be reflowed is a
/// question about the bytes with one right answer (`issues/03`), so it is read from what
/// the pane keeps doing ([AnsiGuard.paintsScreen]) rather than offered as a preference.
class TerminalFeed extends ChangeNotifier {
  TerminalFeed({
    required this.buffer,
    required this.cell,
    required this.onOutput,
    this.inputHandler,
    this.onTyped,
  }) {
    _build(reflow: true);
    buffer.addListener(_onBuffer);
  }

  final OutputBuffer buffer;

  /// Whose bytes this emulator draws. The buffer is shared by every page in the pager and
  /// carries one cell at a time, so without this a neighbour's feed would print the
  /// active page's output.
  final CellRef cell;

  /// [OutputBuffer.epoch] as of the last bytes this emulator was made to agree with.
  int _epoch = 0;

  bool get _tailing => buffer.watching == cell;

  /// Where bytes the operator types go. Called only when the owner has turned keys on —
  /// this class does not know about that, and should not.
  final ValueChanged<String> onOutput;

  /// What turns a key event into bytes — the held ctrl and alt ride on it (`StickyKeys`).
  /// Handed to every emulator this builds, since a mode switch replaces it.
  final TerminalInputHandler? inputHandler;

  /// Text the phone's keyboard typed — as distinct from the bytes the emulator sends on
  /// its own, which share [onOutput] with it. Where a held ctrl is spent (`StickyKeys`).
  final VoidCallback? onTyped;

  late Terminal _terminal;
  Terminal get terminal => _terminal;

  late AnsiGuard _guard;
  StreamSubscription<String>? _writes;

  /// Whether the live [Terminal] was built to reflow. Kept because it is fixed at
  /// construction, so changing mode means building a new one and replaying into it.
  bool _reflowing = true;

  TerminalFit _fit = TerminalFit.flow;
  TerminalFit get fit => _fit;

  TerminalGeometry _geometry = const TerminalGeometry(columns: 80, rows: 24);
  TerminalGeometry get geometry => _geometry;

  int _revision = 0;
  int get revision => _revision;

  /// Bumped whenever the emulator itself is replaced, so an owner holding anything
  /// pinned to the old one — a search, a selection — knows to start again.
  int _generation = 0;
  int get generation => _generation;

  /// Builds an emulator, replays everything held into it, then follows the stream.
  ///
  /// The replay and the subscription go through **one** [AnsiGuard], synchronously:
  /// stream events arrive on later microtasks so nothing can land between the two, and
  /// the guard carries the tail of a sequence split across frames — a second instance
  /// would start blind halfway through.
  void _build({required bool reflow}) {
    _writes?.cancel();
    _reflowing = reflow;
    _generation++;
    _terminal = _TypedTerminal(
      onTyped: onTyped,
      maxLines: 4000,
      reflowEnabled: reflow,
      inputHandler: inputHandler ?? defaultInputHandler,
    );
    // Built generously wide, never at the last measurement: cells past the emulator's
    // own width are never stored, so sizing it to the answer would make the answer
    // unmeasurable (see `TerminalGeometry.of`).
    if (!reflow) {
      _terminal.resize(TerminalGeometry.roomyColumns, TerminalGeometry.roomyRows);
    }

    _guard = AnsiGuard();
    _epoch = buffer.epoch;
    // Every path — the key bar, the phone's own keyboard, a paste — arrives here as
    // bytes the emulator encoded, and leaves by one door.
    _terminal.onOutput = onOutput;
    // Empty while another pane holds the tail: what the buffer carries is not ours.
    final replayed = _tailing ? buffer.replay : '';
    _terminal.write(_guard.pass(replayed));
    // Fase 0 counting (`issues/01` no. 3): the *first* build has nothing to lose —
    // there was no emulator before it. Every one after this is `_settle`'s postFrame
    // callback replacing a live emulator because `AnsiGuard.paintsScreen` changed, and
    // `maxLines: 4000` above only ever gets refilled from what [buffer] still holds —
    // capped at `OutputBuffer.maxBytes` — so this is the number that answers whether
    // those 4000 lines were ever reachable.
    if (_generation > 1) {
      buffer.measurements.record(
        'terminal.rebuild',
        replayed.length,
        labels: {'paneId': buffer.watching?.paneId ?? ''},
      );
    }
    _writes = buffer.writes.listen(_onChunk);
    _settle();
  }

  void _onChunk(String chunk) {
    if (!_tailing) return;
    _terminal.write(_guard.pass(chunk));
    _settle();
  }

  /// Empties the emulator in place, then writes what the buffer holds.
  ///
  /// For a re-subscribe: the host replays its whole ring, so the screen must be blank
  /// first or the ring prints twice. Cheaper than a new [Terminal] — the same object
  /// keeps its scroll, selection and search — and the guard is kept, because *whether this
  /// pane paints a screen* is a fact about the pane, not about this visit.
  void reset() {
    _epoch = buffer.epoch;
    // Out of the alternate screen and home before the clear: `Buffer.clear` empties lines
    // and leaves the cursor wherever the old content put it.
    _terminal.write('\x1b[?1049l\x1b[0m\x1b[H');
    _terminal.buffer.clear();
    _terminal.altBuffer.clear();
    _terminal.write(_guard.pass(_tailing ? buffer.replay : ''));
    _settle();
    notifyListeners();
  }

  /// The buffer started over for *this* pane. Bytes for another pane, or none at all,
  /// leave the emulator as it is — it is the record of what this pane last showed.
  void _onBuffer() {
    if (_tailing && buffer.epoch != _epoch) reset();
  }

  /// Re-reads what the pane is doing, and rebuilds only when the answer changed.
  ///
  /// Deferred to after the frame: a rebuild can be triggered from inside a write Flutter
  /// is already painting, and replacing the emulator mid-build ships a crash.
  void _settle() {
    final wasFit = _fit;
    final wasGeometry = _geometry;
    _fit = _guard.paintsScreen ? TerminalFit.pinned : TerminalFit.flow;
    _geometry = TerminalGeometry.of(_terminal);
    _revision++;

    // **Only when a listener would draw something different.** `RenderTerminal`
    // subscribes to the emulator itself (`ui/render.dart:58`), so output repaints
    // without anyone rebuilding the widgets around it. Notifying on every chunk rebuilt
    // the work bar, the key bar and the surfaces about fourteen times a second while a
    // pane was busy — jank that reads as input lag, in exchange for nothing.
    //
    // A pinned pane is the exception: its viewport follows the cursor, and that is
    // computed from [revision] in a `build`.
    if (_fit == TerminalFit.pinned || _fit != wasFit || _geometry != wasGeometry) {
      notifyListeners();
    }

    if ((_fit == TerminalFit.flow) == _reflowing) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if ((_fit == TerminalFit.flow) != _reflowing) {
        _build(reflow: _fit == TerminalFit.flow);
      }
    });
  }

  @override
  void dispose() {
    buffer.removeListener(_onBuffer);
    _writes?.cancel();
    super.dispose();
  }
}

/// A terminal that says when text was **typed** into it. `textInput` is the phone keyboard's
/// path for anything that is not a key event (and the paste fallback); the emulator's own
/// replies go straight to `onOutput` and never pass here.
class _TypedTerminal extends Terminal {
  _TypedTerminal({
    required this.onTyped,
    super.maxLines,
    super.reflowEnabled,
    super.inputHandler,
  });

  final VoidCallback? onTyped;

  @override
  void textInput(String text) {
    super.textInput(text);
    if (text.isNotEmpty) onTyped?.call();
  }
}
