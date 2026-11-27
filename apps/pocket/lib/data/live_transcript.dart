import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/host_event.dart';
import '../models/host_id.dart';
import '../models/server_event.dart';
import '../models/transcript.dart';
import 'measurement_log.dart';

/// Pager-owned per-cell state prevents neighboring pages from canceling each other (`issues/12`, R-10).
class LiveTranscript extends ChangeNotifier {
  LiveTranscript(
    Stream<HostEvent> events, {
    this.maxEntries = 500,
    this.maxCells = 5,
    MeasurementLog? measurements,
  }) : measurements = measurements ?? MeasurementLog() {
    _subscription = events.listen(_onEvent);
  }

  /// Fase 0 counting (`issues/01`) — every existing caller gets its own instance by
  /// default, so nothing that constructs a `LiveTranscript` today has to change.
  final MeasurementLog measurements;

  /// Match the host page ceiling while bounding memory (`plans/session-history-hardening`).
  final int maxEntries;

  /// Bound held cells to the pager viewport.
  final int maxCells;

  late final StreamSubscription<HostEvent> _subscription;

  /// Entries per cell, oldest first — the order Chat renders top to bottom.
  final Map<CellRef, List<TranscriptEntry>> _entries = {};

  /// Keys of everything held, per cell, so a frame the seed already contains is not
  /// shown twice. See [_keyOf] for why a key and not a timestamp comparison.
  final Map<CellRef, Set<String>> _seen = {};


  /// How many **live** frames a cell has ever accepted (`issues/01` no. 3) — counted
  /// only in [_onEvent], not while [seed] re-merges entries this store already held,
  /// so a big snapshot never inflates a number meant to answer "how many turns fit
  /// before history starts falling off the front". Read alongside `transcript.dropped`
  /// in the log: the value on a cell's first drop *is* that answer.
  final Map<CellRef, int> _totalAppended = {};

  /// The cells being collected for, in the order the pager named them.
  List<CellRef> get following => List.unmodifiable(_entries.keys);

  /// Whether anything is being collected for this cell at all.
  bool isFollowing(CellRef ref) => _entries.containsKey(ref);

  /// This cell's entries, oldest first. Empty for a cell outside the window, which is
  /// the same answer as a cell with nothing recorded — a caller cannot act on the
  /// difference, and `AgentPage` already distinguishes "not loaded" by its own `_view`.
  List<TranscriptEntry> entriesFor(CellRef ref) =>
      List.unmodifiable(_entries[ref] ?? const <TranscriptEntry>[]);

  /// The pager owns the window; drop seen keys with removed cells so replay is not discarded.
  void follow(List<CellRef> window) {
    final wanted = window.length > maxCells
        ? window.sublist(window.length - maxCells)
        : window;

    if (wanted.length == _entries.length && wanted.every(_entries.containsKey)) return;

    for (final gone in _entries.keys.toList()) {
      if (wanted.contains(gone)) continue;
      _entries.remove(gone);
      _seen.remove(gone);
      _totalAppended.remove(gone);
    }
    for (final ref in wanted) {
      _entries.putIfAbsent(ref, () => []);
      _seen.putIfAbsent(ref, () => {});
      _totalAppended.putIfAbsent(ref, () => 0);
    }
    notifyListeners();
  }

  /// Merge older pages without losing concurrent live frames; deduplicate overlaps.
  void prepend(CellRef ref, List<TranscriptEntry> older) {
    final held = _entries[ref];
    if (held == null || older.isEmpty) return;
    final fresh = older.where((e) => !_seen[ref]!.contains(_keyOf(e))).toList();
    if (fresh.isEmpty) return;
    for (final entry in fresh) {
      _seen[ref]!.add(_keyOf(entry));
    }
    held.insertAll(0, fresh);
    // Trimmed from the FRONT everywhere else, because the oldest step is the one worth
    // losing. Here that would throw away exactly what was just fetched, so the cap is
    // applied to the tail instead — the newest entries are still arriving live and will
    // come back on their own.
    while (held.length > maxEntries) {
      _seen[ref]!.remove(_keyOf(held.removeLast()));
    }
    notifyListeners();
  }

  /// Merge the snapshot with frames received during the request and ignore cells outside the window.
  void seed(CellRef ref, List<TranscriptEntry> snapshot) {
    final held = _entries[ref];
    if (held == null) return;

    final live = List<TranscriptEntry>.from(held);
    held
      ..clear()
      ..addAll(snapshot);
    _seen[ref]!
      ..clear()
      ..addAll(snapshot.map(_keyOf));

    for (final entry in live) {
      _append(ref, entry);
    }
    _sortAndTrim(ref);
    notifyListeners();
  }

  /// Drops everything. Called by the pager's own `dispose`.
  ///
  /// Deliberately silent. Its only caller is an unmount, every listener is a descendant
  /// of that unmount and has already gone, and notifying from inside one is precisely
  /// the fault this class was rewritten to stop committing.
  void forget() {
    _entries.clear();
    _seen.clear();
    _totalAppended.clear();
  }


  void _onEvent(HostEvent hostEvent) {
    final (host, event) = hostEvent;
    if (event is! NotificationEvent) return;

    final paneId = event.hook.paneId;
    // A frame the host could not correlate to a pane carries no `pane_id` at all, and
    // is dropped rather than guessed at — the same rule the host's own transcript store
    // applies (PLAN §7 no. 7).
    if (paneId == null) return;

    // Both halves of the identity, for the reason `OutputBuffer` states: two hosts can
    // each run a `p-1`, and the wrong machine's steps rendered here would look right.
    // Here that check *is* the map lookup — a frame from the other machine simply has
    // no bucket to land in.
    final ref = CellRef(host, paneId);
    if (!_entries.containsKey(ref)) return;

    if (_append(ref, event.hook.toTranscriptEntry())) {
      _totalAppended[ref] = (_totalAppended[ref] ?? 0) + 1;
      _sortAndTrim(ref);
      notifyListeners();
    }
  }

  /// Adds one entry unless this cell already holds it. Returns whether anything changed.
  bool _append(CellRef ref, TranscriptEntry entry) {
    if (!_seen[ref]!.add(_keyOf(entry))) return false;
    _entries[ref]!.add(entry);
    return true;
  }

  /// Sorted because the seed and the live frames interleave, then trimmed from the
  /// front — the oldest step is the one worth losing.
  void _sortAndTrim(CellRef ref) {
    final entries = _entries[ref]!;
    entries.sort((a, b) => a.timestamp.compareTo(b.timestamp));
    while (entries.length > maxEntries) {
      _seen[ref]!.remove(_keyOf(entries.removeAt(0)));
      measurements.record(
        'transcript.dropped',
        1,
        labels: {
          'paneId': ref.paneId,
          // See [_totalAppended]: on the first drop for this cell, this is exactly
          // `issues/01`'s "how many entries accumulate before the first drop".
          'sinceCreate': '${_totalAppended[ref] ?? 0}',
        },
      );
    }
  }

  /// Use a composite key because distinct events can share a timestamp.
  static String _keyOf(TranscriptEntry e) =>
      '${e.timestamp}|${e.event}|${e.title}|${e.toolTarget}|${e.body.length}';

  @override
  void dispose() {
    _subscription.cancel();
    super.dispose();
  }
}
