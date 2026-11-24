import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/conversation.dart';
import '../models/conversation_update.dart';
import '../models/host_event.dart';
import '../models/host_id.dart';
import '../models/server_event.dart';
import '../models/transcript.dart';
import 'conversation_builder.dart';
import 'conversation_turns.dart';
import 'entry_lane.dart';
import 'history_window.dart';
import 'measurement_log.dart';
import 'question_settle.dart';

/// Chat's conversation for the cells the Agent pager can reach, kept current — in [Turn]s,
/// which is what Chat renders (`ChatTranscript.ofTurns`).
///
/// **One store, two inputs, one output.** A host that advertises `conversation-stream` sends
/// `Part` deltas the host itself derived, and they are applied here as they arrive. A host
/// that does not sends hook entries, which are held and re-converted with
/// [turnsFromEntries] — the same thing the app has always done, moved inside the store so
/// the rest of the app stops caring which host it is talking to.
///
/// The legacy input is the only remaining caller of `conversation_builder.dart`, and cannot
/// be deleted while the app supports hosts that predate the lane — it deliberately has **no
/// minimum host version** (`contract/README.md`). Ownership and windowing follow
/// `LiveTranscript`: [follow] is called by the pager and by nothing else, and a cell outside
/// the window is dropped whole. The bound on what one cell keeps is [HistoryWindow]'s.
class LiveConversation extends ChangeNotifier {
  LiveConversation(
    Stream<HostEvent> events, {
    this.maxParts = 500,
    this.maxCells = 5,
    this.maxHeld = 3000,
    MeasurementLog? measurements,
  }) : measurements = measurements ?? MeasurementLog() {
    // Built here rather than in the initializer list, so the window counts drops on **this**
    // store's log. `measurements ?? MeasurementLog()` written twice makes two of them, and
    // the one the app reads is then the one nothing ever writes to.
    _window = HistoryWindow(
      maxParts: maxParts,
      maxHeld: maxHeld,
      measurements: this.measurements,
    );
    _subscription = events.listen(_onEvent);
  }

  /// The same counter `LiveTranscript` kept, on the same key: what falls off the front is
  /// the number that answers "how much history fits before it starts being lost".
  final MeasurementLog measurements;

  /// Parts per cell, across all its turns. The host pages at 500; one page fits whole.
  final int maxParts;

  /// How many cells may be held at once — the pager's laid-out window, not its reach.
  final int maxCells;

  /// The ceiling no amount of scrolling up may pass, per cell — see [HistoryWindow], which
  /// owns both bounds and everything that reclaims against them.
  final int maxHeld;
  late final HistoryWindow _window;

  late final StreamSubscription<HostEvent> _subscription;

  final Map<CellRef, List<Turn>> _turns = {};

  /// Cells whose live stream lost deltas the host can no longer replay.
  ///
  /// A page reads this to decide it must refetch instead of trusting what it holds. Cleared by
  /// [seed] and [seedEntries], which are the only things that can actually repair it.
  final Set<CellRef> _gaps = {};

  /// The other input: hook entries, held and re-converted (`EntryLane`).
  final EntryLane _lane = EntryLane();

  List<CellRef> get following => List.unmodifiable(_turns.keys);

  bool isFollowing(CellRef ref) => _turns.containsKey(ref);

  /// This cell's turns, oldest first. Empty for a cell outside the window — the same answer
  /// as a cell with nothing recorded, which is what every caller can act on.
  List<Turn> turnsFor(CellRef ref) => List.unmodifiable(_turns[ref] ?? const <Turn>[]);

  /// Whether this cell's history is known to be incomplete and needs a fetch.
  bool hasGap(CellRef ref) => _gaps.contains(ref);

  /// Points this at the cells the pager can currently reach. One writer, called by the
  /// pager and never by a page.
  void follow(List<CellRef> window) {
    final wanted =
        window.length > maxCells ? window.sublist(window.length - maxCells) : window;
    if (wanted.length == _turns.length && wanted.every(_turns.containsKey)) return;

    for (final gone in _turns.keys.toList()) {
      if (wanted.contains(gone)) continue;
      _turns.remove(gone);
      _lane.forget(gone);
      _gaps.remove(gone);
      // The allowance dies with the history it was granted for. Without this a cell that
      // came back into the window would inherit a cap for pages it no longer holds.
      _window.forget(gone);
    }
    for (final ref in wanted) {
      _turns.putIfAbsent(ref, () => []);
    }
    notifyListeners();
  }

  /// Replaces this cell's history with a page fetched over REST.
  ///
  /// Refused for a cell outside the window. Live deltas that arrived while the request was
  /// in flight are re-applied on top, by turn id and part id, so a seed cannot lose them.
  void seed(CellRef ref, List<Turn> page) {
    final held = _turns[ref];
    if (held == null) return;
    final live = [...held];
    _turns[ref] = [for (final t in page) Turn(
          turnId: t.turnId,
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          stopReason: t.stopReason,
          parts: [...t.parts],
        )];
    for (final turn in live) {
      for (final part in turn.parts) {
        _apply(ref, PartUpdate(turnId: turn.turnId, part: part), notify: false);
      }
    }
    _gaps.remove(ref);
    // A REST page replaces what was held, so whatever paging had earned is gone with it.
    _window.forget(ref);
    _trim(ref);
    notifyListeners();
  }

  /// Adds older turns in front of what is held, as the operator scrolls up.
  void prepend(CellRef ref, List<Turn> older) {
    final held = _turns[ref];
    if (held == null || older.isEmpty) return;
    final known = held.map((t) => t.turnId).toSet();
    final fresh = older.where((t) => !known.contains(t.turnId)).toList();
    if (fresh.isEmpty) return;
    held.insertAll(0, fresh);
    _window.notePaged(ref);
    notifyListeners();
  }

  /// How many parts this cell holds, across its turns.
  int partsHeld(CellRef ref) =>
      (_turns[ref] ?? const <Turn>[]).fold(0, (n, t) => n + t.parts.length);

  /// Whether this cell holds as much history as it ever will — what the line at the top of
  /// Chat announces. Read against the cell's **own** cap, which paging raises: comparing to
  /// [maxParts] would put "history stops here" above a page the operator had just walked
  /// through, and that line's whole job is to say when to stop scrolling.
  bool atHistoryEdge(CellRef ref) => partsHeld(ref) >= _window.capFor(ref);

  /// Every prompt this cell is carrying, for settling a [PendingDispatch].
  ///
  /// The union of two sources on purpose. A `user_message` part is the prompt as the hook
  /// recorded its **body**, which is capped longer and is what the operator actually typed.
  /// The legacy entries' `userPrompt` is the shorter copy, and it is the only signal for a
  /// turn that opened without a `prompt-submit` — a case `turnsFromEntries` produces no part
  /// for at all. Dropping either would leave a pending line on screen forever.
  Set<String> promptsFor(CellRef ref) => {
        for (final turn in _turns[ref] ?? const <Turn>[])
          for (final part in turn.parts)
            if (part is UserMessagePart) part.text,
        for (final entry in _lane.entriesOf(ref)) entry.userPrompt,
      };

  /// Replaces this cell's history with a page of hook entries, converted once.
  ///
  /// The legacy seed, for a host whose `/transcript` is all there is. One conversion for the
  /// page rather than one per entry, which is what [pushEntry] would cost applied in a loop.
  void seedEntries(CellRef ref, List<TranscriptEntry> page) {
    if (!_turns.containsKey(ref)) return;
    // Like [seed]: a REST page replaces what was held, so a raised cap would describe pages
    // that are no longer there.
    _window.forget(ref);
    _turns[ref] = _lane.seed(ref, page, _window.capFor(ref));
    _gaps.remove(ref);
    notifyListeners();
  }

  /// Adds a page of older hook entries in front, on the legacy input.
  ///
  /// Accepted for any followed cell, including one that has held nothing yet: the first
  /// scroll-up on a page whose cell has produced no step is exactly when this is asked, and
  /// requiring an existing entry list here silently dropped that page.
  void prependEntries(CellRef ref, List<TranscriptEntry> older) {
    if (!_turns.containsKey(ref) || older.isEmpty) return;
    // `/transcript` answers in hook entries for **every** cell, so the pager brings them
    // even to one the host runs itself — and re-deriving from them would drop the native
    // turns and file the same steps again under derived ids, which is the failure
    // `conversation_turns.dart` has a rule against arriving by another door. Measured
    // 2026-09-08: one scroll-up replaced a live conversation outright.
    if (_isDeltaLane(ref)) {
      // Deduped against what earlier pages took: this lane keeps no entry list to compare
      // with, two reads can overlap, and `prepend` would not catch it — the same steps
      // arrive under a *different* derived turn id.
      final fresh = older.where((e) => !_window.alreadyTaken(ref, stableId(e))).toList();
      if (fresh.isEmpty) return;
      _window.noteTaken(ref, fresh.map(stableId));
      prepend(ref, turnsFromEntries(fresh, Provenance.hook));
      return;
    }
    final derived = _lane.prepend(ref, older);
    if (derived == null) return;
    _window.notePaged(ref);
    _turns[ref] = derived;
    notifyListeners();
  }

  /// Whether this cell's history came from the conversation lane rather than from entries.
  ///
  /// Read from what is *held* rather than from a flag, because that is the fact that
  /// matters: entries held means the legacy converter owns these turns and re-deriving is
  /// correct; turns held with no entries behind them means the host sent them as parts and
  /// only it can revise them. A cell holding neither is neither — the first scroll-up on a
  /// page whose cell has produced no step, which the entries lane handles.
  bool _isDeltaLane(CellRef ref) =>
      !_lane.holds(ref) && (_turns[ref]?.isNotEmpty ?? false);

  /// Drops everything held. Called when the Agent screen closes.
  void forget() {
    _turns.clear();
    _lane.clear();
    _window.clear();
  }

  /// Feeds one hook entry on the legacy input. Public so the REST seed can use the same
  /// path on a host that has no conversation route either.
  void pushEntry(CellRef ref, TranscriptEntry entry) {
    final derived = _lane.push(ref, entry, _window.capFor(ref),
        follows: _turns.containsKey(ref));
    if (derived == null) return;
    _turns[ref] = derived;
    notifyListeners();
  }

  /// The operator has answered the open question here — show it now, rather than waiting for
  /// the runner to write its own record of it (`question_settle.dart` says why).
  void settleQuestion(CellRef ref, String chosen) {
    final turns = _turns[ref];
    if (turns == null) return;
    final settled = withQuestionAnswered(turns, chosen);
    if (settled == null) return;
    _turns[ref] = settled;
    notifyListeners();
  }

  @override
  void dispose() {
    unawaited(_subscription.cancel());
    super.dispose();
  }

  void _onEvent(HostEvent event) {
    final (host, frame) = event;
    switch (frame) {
      case ConversationFrame(:final paneId, :final update):
        _apply(CellRef(host, paneId), update, notify: true);
      case ConversationTruncatedFrame(:final paneId):
        // The host could not reach back far enough. Marked rather than papered over: the page
        // repairs it with one REST fetch, and until then the operator is looking at a
        // transcript with a hole in the middle it cannot see.
        _gaps.add(CellRef(host, paneId));
        notifyListeners();
      case NotificationEvent(:final hook):
        final paneId = hook.paneId;
        if (paneId == null || paneId.isEmpty) return;
        final ref = CellRef(host, paneId);
        // Only where nothing has arrived on the modern lane for this cell: a host that
        // sends both would otherwise draw every step twice, under two different ids.
        if (_lane.holds(ref) || _turns[ref]?.isEmpty != false) {
          pushEntry(ref, hook.toTranscriptEntry());
        }
      case _:
        return;
    }
  }

  void _apply(CellRef ref, ConversationUpdate update, {required bool notify}) {
    final held = _turns[ref];
    if (held == null) return;
    applyUpdate(held, update);
    _trim(ref);
    if (notify) notifyListeners();
  }

  void _trim(CellRef ref) {
    final held = _turns[ref];
    if (held != null) _window.trim(ref, held);
  }
}
