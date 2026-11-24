import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/host_event.dart';
import '../models/host_id.dart';
import '../models/server_event.dart';
import 'measurement_log.dart';

/// PTY output for the one cell Terminal mode is showing.
///
/// One pane at a time, because that is what the socket allows: `subscribe` replaces the
/// previous tail rather than adding to it (ADR-10). So this holds a single cell's bytes
/// and is reset when the operator swipes to another agent — the host replays that pane's
/// ring buffer on the new subscription, which is a better source than anything kept here.
///
/// Deliberately **not** an ANSI interpreter and not a formatter: `xterm.dart` is the
/// emulator (`issues/03`), and the only thing this layer owes it is bytes in order plus
/// an honest account of what is missing.
class OutputBuffer extends ChangeNotifier {
  OutputBuffer(
    Stream<HostEvent> events, {
    this.maxBytes = 256 * 1024,
    MeasurementLog? measurements,
  }) : measurements = measurements ?? MeasurementLog() {
    _subscription = events.listen(_onEvent);
  }

  /// Matches the host's own ring buffer (`OUTPUT_TAIL_BYTES`). Holding more than the
  /// host can ever replay would only mean this and a reconnect disagree about history.
  ///
  /// Raised 64KB → 256KB with the ring itself in Fase 2 of
  /// `plans/session-history-hardening`, so the invariant above still holds. It has a second
  /// effect here worth naming: this is also what a rebuilt emulator is replayed from
  /// (`TerminalFeed._build`), so a mode switch now restores four times as much of the
  /// screen as it did. Only one cell is ever held, so the cost is 256KB, not per-cell.
  final int maxBytes;

  /// Fase 0 counting (`issues/01`) — every existing caller gets its own instance by
  /// default, so nothing that constructs an `OutputBuffer` today has to change.
  /// `TerminalFeed` reads this off the buffer it already holds rather than being
  /// threaded a second collaborator of its own (`terminal_feed.dart`).
  final MeasurementLog measurements;

  late final StreamSubscription<HostEvent> _subscription;

  final StreamController<String> _writes = StreamController<String>.broadcast();
  final List<String> _chunks = [];

  CellRef? _watching;
  int _epoch = 0;
  int _bytes = 0;
  int _missingBytes = 0;
  int _evictedBytes = 0;
  int? _lastByteOffset;

  /// Which cell these bytes belong to. Null means nothing is being tailed.
  CellRef? get watching => _watching;

  /// How many times the held bytes were thrown away to start over. A consumer that keeps
  /// its own copy of [replay] (an emulator that outlives a tail) compares this to learn
  /// that the host is about to replay its ring again, so it empties first instead of
  /// printing that ring on top of itself.
  int get epoch => _epoch;

  /// Everything held, for a terminal that has just been mounted.
  ///
  /// Take this and subscribe to [writes] in **one synchronous step**. Dart delivers
  /// stream events on later microtasks, so nothing can arrive between the two — split
  /// them across an `await` and a chunk goes missing.
  String get replay => _chunks.join();

  /// Chunks as they arrive, for `Terminal.write`.
  Stream<String> get writes => _writes.stream;

  /// Bytes the operator will never see: the host's ring buffer could not reach back far
  /// enough, so they were gone before this app could ask for them.
  ///
  /// R-4 requires this be shown rather than silently swallowed. It is a count, not an
  /// inline marker, because where to draw it is a decision for `features/` — and a
  /// marker spliced into the byte stream would be text `xterm` then tries to interpret.
  ///
  /// **Only host-reported gaps.** Local eviction is [evictedBytes] and is a different
  /// claim — see there.
  int get missingBytes => _missingBytes;

  /// Bytes dropped from [replay] to stay inside [maxBytes], having already been written
  /// to the terminal.
  ///
  /// Deliberately *not* [missingBytes]. These arrived and were drawn; only the snapshot
  /// a freshly-mounted emulator would replay let them go. Counting the two together made
  /// a screen-painting CLI — Codex redraws inline and emits tens of megabytes a session —
  /// report "34823344 bytes never arrived" over output the operator was looking at.
  int get evictedBytes => _evictedBytes;

  /// Whether a real hole exists in the history. Eviction is not a hole.
  bool get truncated => _missingBytes > 0;

  /// How far this pane's output has been seen — the offset a `resume` asks from.
  int? get lastByteOffset => _lastByteOffset;

  /// Points the buffer at a cell, or at nothing.
  ///
  /// Switching cells clears everything, including the truncation count: a gap belongs to
  /// the pane it happened in, and carrying it across a swipe would report a hole in
  /// output the operator is not looking at.
  void watch(CellRef? ref) {
    if (_watching == ref) return;
    // Counted before the clear, and only when there was a pane to lose: the first
    // `watch` of a session moves off nothing, and that is not a cost to the operator
    // (`issues/01` no. 4 — "each one costs the operator their scrollback").
    final leaving = _watching;
    if (leaving != null) {
      measurements.record('buffer.cleared', _bytes, labels: {'paneId': leaving.paneId});
    }
    _watching = ref;
    _epoch++;
    _chunks.clear();
    _bytes = 0;
    _missingBytes = 0;
    _evictedBytes = 0;
    _lastByteOffset = null;
    notifyListeners();
  }

  /// Stops tailing [ref], and **only** [ref].
  ///
  /// The distinction from `watch(null)` is the whole point (`issues/12`). Since the
  /// pager keeps neighbouring pages mounted, a page being disposed is no longer proof
  /// that it is the one holding the tail: page `i-1` falling out of the cache while
  /// page `i` has Terminal open would otherwise clear that terminal's bytes and cancel
  /// its subscription, from a page the operator cannot even see.
  ///
  /// Returns whether it was actually watching this cell, which is what tells the caller
  /// whether the socket subscription is also theirs to cancel.
  bool release(CellRef ref) {
    if (_watching != ref) return false;
    watch(null);
    return true;
  }

  void _onEvent(HostEvent hostEvent) {
    final (host, event) = hostEvent;
    final watching = _watching;
    if (watching == null) return;

    switch (event) {
      case CellOutputEvent(:final paneId, :final chunk, :final byteOffset):
        // Both halves of the identity are checked. Two hosts can each run a `p-1`
        // (R-10), and bytes from the wrong machine rendered into this terminal would be
        // indistinguishable from the right ones.
        if (CellRef(host, paneId) != watching) return;
        _append(chunk);
        _lastByteOffset = byteOffset;
        notifyListeners();

      case CellTruncatedEvent(:final paneId, :final missingBytes):
        if (CellRef(host, paneId) != watching) return;
        _missingBytes += missingBytes;
        measurements.record('output.missing', missingBytes, labels: {'paneId': paneId});
        notifyListeners();

      // Everything else on this socket belongs to another surface. Named rather than
      // defaulted so a new event type has to be considered here too.
      case HelloEvent():
      case FleetChangedEvent():
      case NotificationEvent():
      case ConversationFrame():
      case ConversationTruncatedFrame():
        return;
    }
  }

  void _append(String chunk) {
    _chunks.add(chunk);
    _bytes += chunk.length;
    _trim();
    if (!_writes.isClosed) _writes.add(chunk);
  }

  /// Drops whole chunks from the front until inside budget.
  ///
  /// Whole chunks, never a substring: cutting inside an escape sequence would leave
  /// `xterm` a half-command to interpret, and a corrupted screen is worse than a
  /// shorter one. What is dropped is counted as *evicted*, never as missing: the
  /// terminal already has these bytes, so telling the operator they never arrived would
  /// be a warning about output they can still see.
  void _trim() {
    while (_bytes > maxBytes && _chunks.length > 1) {
      final dropped = _chunks.removeAt(0);
      _bytes -= dropped.length;
      _evictedBytes += dropped.length;
      // `_watching` cannot be null here: `_trim` only runs from `_append`, which only
      // runs from `_onEvent` after the null check on `watching` above.
      final paneId = _watching!.paneId;
      measurements.record('output.evicted', dropped.length, labels: {'paneId': paneId});
    }
  }

  @override
  void dispose() {
    _subscription.cancel();
    _writes.close();
    super.dispose();
  }
}
