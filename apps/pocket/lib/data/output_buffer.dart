import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/host_event.dart';
import '../models/host_id.dart';
import '../models/server_event.dart';
import 'measurement_log.dart';

/// Keep one pane because subscriptions replace each other; preserve ordered bytes and gaps (ADR-10, `issues/03`).
class OutputBuffer extends ChangeNotifier {
  OutputBuffer(
    Stream<HostEvent> events, {
    this.maxBytes = 256 * 1024,
    MeasurementLog? measurements,
  }) : measurements = measurements ?? MeasurementLog() {
    _subscription = events.listen(_onEvent);
  }

  /// Match the host ring so local replay and reconnection agree (`plans/session-history-hardening`).
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

  /// Report host gaps separately from local eviction (R-4).
  int get missingBytes => _missingBytes;

  /// Local replay eviction is not missing output: the terminal already received it.
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

  /// Only stop the matching pane so a disposed neighbor cannot cancel its subscription (`issues/12`).
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

  /// Evict whole chunks to avoid splitting escape sequences; count eviction separately from missing bytes.
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
