import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/host_event.dart';
import '../models/host_id.dart';
import '../models/server_event.dart';
import '../models/transcript.dart';
import 'measurement_log.dart';

/// Chat's transcript for the cells the Agent pager can reach, kept current.
///
/// **This closes a producer-with-no-consumer gap.** The host already broadcasts every
/// hook event to every connected device as `{type: "notification", …}`
/// (`stream-hub.ts`), and that frame *is* one transcript entry. Nothing in the app
/// read it: the only `case NotificationEvent()` in `data/` was `OutputBuffer`
/// explicitly ignoring it. So Chat was a single REST fetch — it filled on open and
/// then never moved, which is why leaving the page and coming back was what made new
/// output appear. The exact mirror image of the `cell.output` bug (`dab5261e`), where
/// a consumer had no producer.
///
/// **Keyed per cell, and that is a correction** (`issues/12`, 2026-08-09). It used to
/// hold one cell behind a single `watch(ref)` pointer, and `AgentPage` drove that
/// pointer from its own `initState`/`dispose`. A `PageView` never has just one live
/// page: during a swipe the incoming page is already built while the outgoing one has
/// not been disposed yet, so two pages each believed they owned this store and the
/// winner was whichever lifecycle callback happened to run last — always the outgoing
/// `dispose`, which pointed the store at nothing. The next agent's transcript was then
/// dropped on arrival, and because a store pointed at nothing also drops every incoming
/// frame, nothing ever repaired it short of leaving the screen.
///
/// So ownership moved up to [follow], which the **pager** calls — one writer, and the
/// ordering question stops existing rather than getting a better answer.
///
/// The map key doing this work is a [CellRef], which is host **and** pane. That is a
/// stronger guarantee than the clearing it replaced, not a weaker one: the rule was
/// *"entries carry no host, so one pane's steps under another agent's name would be
/// indistinguishable"*, and entries filed under their own cell cannot be rendered under
/// another's. R-10 is now held by the type instead of by call order.
///
/// **Costs nothing extra on the wire.** Unlike PTY output — which only flows after an
/// explicit `subscribe` — notification frames are broadcast unconditionally. This
/// class does not ask the host for anything; it stops throwing away what was already
/// arriving. Keeping a neighbour's frames is therefore free, and it is what makes a
/// swipe back land on a page that is already current.
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

  /// Per cell.
  ///
  /// **Was 60, mirroring the host's hook ring, and that reasoning expired** (Fase 3 of
  /// `plans/session-history-hardening`). The rule was "never hold more than the host can
  /// replay", which was right while the host could only replay its 60-entry ring. It now
  /// serves the runner's own conversation file, which has no such bound — so mirroring 60
  /// stopped protecting an invariant and started being the thing that truncates history.
  ///
  /// 500 matches the host's own per-page ceiling, so one page can always be held whole.
  /// Still a cap rather than none: this is a phone, and every entry held is rendered.
  final int maxEntries;

  /// How many cells may be held at once. Five, which is `AgentScreen._reach` of 2 on
  /// each side of the page in view — the set the pager's viewport can have **laid out**
  /// at one moment, not the set the operator can swipe to. That distinction was measured,
  /// and it is recorded where the window is computed.
  ///
  /// A ceiling rather than a policy: [follow] is given the window by the pager, and
  /// this only refuses to be handed more than the design says exists. Its cost is
  /// bounded by construction — 5 × [maxEntries].
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

  /// Points this at the cells the pager can currently reach.
  ///
  /// Called by `AgentScreen` when it opens and on every page change — **never** by a
  /// page. That is the whole ownership rule: one writer, called from places that are
  /// not inside a lazy child's build, so it also cannot mark a listener dirty mid-build
  /// the way the old per-page `watch` did.
  ///
  /// A cell that falls out of the window is dropped **entirely**, its seen-keys with
  /// it. Keeping the keys would leak a set that never shrinks, and re-entering the cell
  /// later would then silently discard its first replayed entries as duplicates.
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

  /// Adds a page of **older** entries in front of what is already held.
  ///
  /// Separate from [seed] because the two answer different questions: a seed replaces
  /// this cell's history with the newest page, while this extends it backwards as the
  /// operator scrolls. Merging them would mean a scroll-up could silently discard the
  /// live frames that arrived while the request was in flight.
  ///
  /// Refused for a cell outside the window, and de-duplicated against what is held —
  /// a page boundary that overlaps by one entry must not draw that entry twice.
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

  /// Takes the host's snapshot as this cell's starting point.
  ///
  /// Called after the REST read lands. Frames that arrived **while** that request was
  /// in flight are already here, and they are kept rather than discarded: the seed is
  /// merged under them by timestamp, so nothing is lost in the gap between the pager
  /// following this cell and the snapshot returning. That gap is real — a turn can
  /// produce a dozen events in the time one HTTP round trip takes over a tailnet.
  ///
  /// Refused for a cell outside the window: that read belongs to a page the pager has
  /// already moved past.
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

  /// A composite key rather than "newer than the last snapshot entry".
  ///
  /// Timestamps come from `Date.now()` in the hook script, so a burst of tool events
  /// can share a millisecond. A `>` comparison would then drop a real step and a `>=`
  /// would duplicate one; this tells them apart by what they actually are. Entries
  /// carry no id — if the drop payload ever grows one, it replaces this.
  static String _keyOf(TranscriptEntry e) =>
      '${e.timestamp}|${e.event}|${e.title}|${e.toolTarget}|${e.body.length}';

  @override
  void dispose() {
    _subscription.cancel();
    super.dispose();
  }
}
