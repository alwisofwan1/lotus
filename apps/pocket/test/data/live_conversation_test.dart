import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/live_conversation.dart';
import 'package:lotus_pocket/data/measurement_log.dart';
import 'package:lotus_pocket/models/conversation.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/server_event.dart';
import 'package:lotus_pocket/models/transcript.dart';

const mac = HostId('mac');
final ref = CellRef(mac, 'p-1');

Map<String, Object?> turnFrame(String id, {int startedAt = 1000, int? endedAt, String? stop}) => {
      'type': 'conversation',
      'paneId': 'p-1',
      'agentType': 'claude',
      'update': {
        'kind': 'turn',
        'turn': {
          'turnId': id,
          'startedAt': startedAt,
          'endedAt': ?endedAt,
          'stopReason': ?stop,
        },
      },
    };

Map<String, Object?> partFrame(
  String turnId,
  String partId, {
  String type = 'assistant_text',
  String text = 'hello',
  String state = 'streaming',
  String paneId = 'p-1',
}) =>
    {
      'type': 'conversation',
      'paneId': paneId,
      'agentType': 'claude',
      'update': {
        'kind': 'part',
        'turnId': turnId,
        'part': {
          'id': partId,
          'ts': 2000,
          'seq': 1,
          'provenance': 'native',
          'type': type,
          if (type == 'assistant_text') ...{'text': text, 'state': state, 'truncated': false},
          if (type == 'user_message') 'text': text,
          if (type == 'reasoning') ...{'text': text, 'redacted': false},
        },
      },
    };

Map<String, Object?> textFrame(
  String turnId,
  String partId,
  String delta, {
  int seq = 2,
  String paneId = 'p-1',
}) =>
    {
      'type': 'conversation',
      'paneId': paneId,
      'agentType': 'claude',
      'update': {
        'kind': 'text',
        'turnId': turnId,
        'partId': partId,
        'delta': delta,
        'seq': seq,
      },
    };

void main() {
  late StreamController<HostEvent> events;
  late LiveConversation live;

  setUp(() {
    events = StreamController<HostEvent>.broadcast();
    live = LiveConversation(events.stream);
    live.follow([ref]);
  });

  tearDown(() {
    live.dispose();
    unawaited(events.close());
  });

  Future<void> send(Map<String, Object?> json) async {
    events.add((mac, ServerEvent.fromJson(json, host: mac)!));
    await Future<void>.delayed(Duration.zero);
  }

  test('opens a turn from its header and files parts under it', () async {
    await send(turnFrame('t-1'));
    await send(partFrame('t-1', 'p-a', type: 'user_message', text: 'run the tests'));

    final turns = live.turnsFor(ref);
    expect(turns, hasLength(1));
    expect(turns.single.turnId, 't-1');
    expect(turns.single.isOpen, isTrue);
    expect(turns.single.parts, hasLength(1));
  });

  test('revises a part in place rather than appending it twice', () async {
    await send(turnFrame('t-1'));
    await send(partFrame('t-1', 'p-a', text: 'he'));
    await send(partFrame('t-1', 'p-a', text: 'hello', state: 'done'));

    final parts = live.turnsFor(ref).single.parts;
    expect(parts, hasLength(1));
    final part = parts.single as AssistantTextPart;
    expect(part.text, 'hello');
    expect(part.streaming, isFalse);
  });

  test('closes a turn without losing what was in it', () async {
    await send(turnFrame('t-1'));
    await send(partFrame('t-1', 'p-a'));
    await send(turnFrame('t-1', endedAt: 5000, stop: 'end_turn'));

    final turn = live.turnsFor(ref).single;
    expect(turn.isOpen, isFalse);
    expect(turn.stopReason, 'end_turn');
    // The header arrives whole and carries no parts; applying it must not clear them.
    expect(turn.parts, hasLength(1));
  });

  test('places a part whose turn header has not arrived yet', () async {
    // Frames can arrive out of order, and a part that cannot be placed is a step the
    // operator never sees.
    await send(partFrame('t-9', 'p-a'));
    expect(live.turnsFor(ref).single.turnId, 't-9');
    await send(turnFrame('t-9', startedAt: 500));
    expect(live.turnsFor(ref), hasLength(1));
    expect(live.turnsFor(ref).single.parts, hasLength(1));
  });

  test('ignores a cell outside the window', () async {
    await send(partFrame('t-1', 'p-a', paneId: 'p-other'));
    expect(live.turnsFor(CellRef(mac, 'p-other')), isEmpty);
    expect(live.isFollowing(CellRef(mac, 'p-other')), isFalse);
  });

  test('drops a cell that leaves the window, entirely', () async {
    await send(turnFrame('t-1'));
    expect(live.turnsFor(ref), hasLength(1));
    live.follow([CellRef(mac, 'p-2')]);
    expect(live.turnsFor(ref), isEmpty);
    expect(live.isFollowing(ref), isFalse);
  });

  test('a seed keeps the deltas that arrived while it was in flight', () async {
    await send(turnFrame('t-1'));
    await send(partFrame('t-1', 'live-part'));

    live.seed(ref, [
      Turn(
        turnId: 't-1',
        startedAt: DateTime.fromMillisecondsSinceEpoch(1000),
        parts: const [],
      ),
    ]);

    // The REST page had no part for it yet; the live one must survive the replacement.
    expect(live.turnsFor(ref).single.parts.map((p) => p.id), ['live-part']);
  });

  test('prepend adds older turns in front, and never a turn already held', () async {
    await send(turnFrame('t-2', startedAt: 2000));
    final older = Turn(
      turnId: 't-1',
      startedAt: DateTime.fromMillisecondsSinceEpoch(1000),
      parts: const [],
    );
    live.prepend(ref, [older]);
    expect(live.turnsFor(ref).map((t) => t.turnId), ['t-1', 't-2']);
    live.prepend(ref, [older]);
    expect(live.turnsFor(ref).map((t) => t.turnId), ['t-1', 't-2']);
  });

  test('holds no more parts than the cap, dropping the oldest turn first', () async {
    final small = LiveConversation(events.stream, maxParts: 2)..follow([ref]);
    addTearDown(small.dispose);
    await send(turnFrame('t-1'));
    await send(partFrame('t-1', 'a'));
    await send(turnFrame('t-2', startedAt: 2000));
    await send(partFrame('t-2', 'b'));
    await send(partFrame('t-2', 'c', text: 'more'));

    expect(small.turnsFor(ref).map((t) => t.turnId), ['t-2']);
  });

  test('what the cap drops is counted on the log the caller reads', () async {
    // The counter answers "how much history fits before it starts being lost", and it is
    // read off `live.measurements`. A second log inside the store would keep the number
    // where nobody looks — the metric would read zero forever and the cap would look free.
    final log = MeasurementLog();
    final given = LiveConversation(events.stream, maxParts: 1, measurements: log)
      ..follow([ref]);
    addTearDown(given.dispose);
    // And the default path, which is the one the app actually constructs.
    final own = LiveConversation(events.stream, maxParts: 1)..follow([ref]);
    addTearDown(own.dispose);

    await send(turnFrame('t-1'));
    await send(partFrame('t-1', 'a'));
    await send(turnFrame('t-2', startedAt: 2000));
    await send(partFrame('t-2', 'b'));

    expect(given.turnsFor(ref).map((t) => t.turnId), ['t-2'], reason: 'something was dropped');
    expect(log.length, greaterThan(0));
    expect(own.measurements.length, greaterThan(0),
        reason: 'a store that made its own log must still be the one holding the count');
  });

  /// The cap is there so what is held stays bounded, and it drops from the **front** —
  /// which is exactly where paging older history puts things. Measured 2026-09-08: six
  /// pages scrolled in (601 parts held), then one streaming chunk arrived and 200 parts
  /// across two whole turns vanished from above the operator's reading position.
  ///
  /// The rule that fixes it without giving up the bound: **history the operator asked for
  /// raises this cell's allowance.** A page nobody requested is still trimmed; a page they
  /// scrolled up to get is theirs until the hard ceiling.
  group('history the operator paged in', () {
    Turn older(String id, int parts) => Turn(
          turnId: id,
          startedAt: DateTime.fromMillisecondsSinceEpoch(100),
          parts: [
            for (var n = 0; n < parts; n++)
              AssistantTextPart(
                id: '$id-$n',
                ts: DateTime.fromMillisecondsSinceEpoch(100),
                seq: n,
                provenance: Provenance.native,
                text: 'x',
                streaming: false,
                truncated: false,
              ),
          ],
        );

    TranscriptEntry entry(String body, int at) => TranscriptEntry(
          event: 'agent-response',
          status: 'idle',
          title: '',
          body: body,
          userPrompt: '',
          toolTarget: '',
          timestamp: DateTime.fromMillisecondsSinceEpoch(at),
        );

    /// `TranscriptPager` pages over `/transcript`, which answers in **hook entries** — even
    /// for a cell whose live history came from the conversation lane. Re-deriving the whole
    /// cell from those entries would throw the native turns away and put the same steps back
    /// under different ids, which is the "one exchange drawn twice" failure this store
    /// already has a rule against (`conversation_turns.dart`).
    test('arrives as entries without replacing what the delta lane built', () async {
      await send(turnFrame('t-live', startedAt: 9000));
      await send(partFrame('t-live', 'p-a', type: 'user_message', text: 'run the tests'));
      await send(partFrame('t-live', 'p-b', text: 'Done.', state: 'done'));

      live.prependEntries(ref, [entry('older reply', 100), entry('older still', 50)]);

      final turns = live.turnsFor(ref);
      final liveTurn = turns.where((t) => t.turnId == 't-live');
      expect(liveTurn, hasLength(1), reason: 'the native turn is still there');
      expect(liveTurn.single.parts.map((p) => p.id), ['p-a', 'p-b'],
          reason: 'with its own part ids, so later deltas still find them');
      expect(turns.length, greaterThan(1), reason: 'the older page went in front of it');
      expect(turns.last.turnId, 't-live', reason: 'and behind, not in front of, the newest');
    });

    /// The top of Chat says "history stops here" when the cell is at its limit. Paging
    /// raises that limit, so reading the marker off [LiveConversation.maxParts] would start
    /// announcing a wall the operator had just walked through — the one thing that line must
    /// never do, because it tells them to stop scrolling.
    test('does not make the transcript claim it has reached its limit', () async {
      final small = LiveConversation(events.stream, maxParts: 4, maxHeld: 12)..follow([ref]);
      addTearDown(small.dispose);
      await send(turnFrame('t-live', startedAt: 9000));
      await send(partFrame('t-live', 'live-a'));
      expect(small.atHistoryEdge(ref), isFalse);

      small.prepend(ref, [older('old-1', 5)]);
      expect(small.atHistoryEdge(ref), isFalse,
          reason: 'past maxParts, but only because the operator asked for it');

      small.prepend(ref, [older('old-2', 6)]);
      expect(small.atHistoryEdge(ref), isTrue, reason: 'at the ceiling, and that is real');
    });

    /// Two `/transcript` reads can overlap — the host's ring against its file, or a repeated
    /// `oldestCursor` after a failed read. On the delta lane there is no entry list to compare
    /// against, and `prepend` cannot catch it either: the same steps arrive under a
    /// *different* derived turn id, which is the "one exchange drawn twice" failure.
    test('does not draw an overlapping page twice', () async {
      await send(turnFrame('t-live', startedAt: 9000));
      await send(partFrame('t-live', 'p-a', text: 'Done.', state: 'done'));

      // Not the same page twice — an identical page is already caught, because identical
      // entries derive an identical turn id. The dangerous shape is a **partial** overlap,
      // where the second read starts inside the first turn: `turnsFromEntries` then opens a
      // turn from a different entry and files the same two steps under a new id.
      final prompt = TranscriptEntry(
        event: 'prompt-submit', status: 'running', title: '', body: 'do the thing',
        userPrompt: 'do the thing', toolTarget: '',
        timestamp: DateTime.fromMillisecondsSinceEpoch(100),
      );
      final a = entry('older a', 200);
      final b = entry('older b', 300);
      live.prependEntries(ref, [prompt, a, b]);
      final afterFirst = live.partsHeld(ref);

      live.prependEntries(ref, [a, b, entry('older c', 400)]);

      expect(live.partsHeld(ref), afterFirst + 1,
          reason: 'only the one step the second page actually added');
    });

    test('gives the allowance back when a refresh replaces what it was granted for', () {
      final small = LiveConversation(events.stream, maxParts: 2)..follow([ref]);
      addTearDown(small.dispose);
      for (var i = 0; i < 2; i++) {
        small.pushEntry(ref, entry('live $i', 9000 + i));
      }
      small.prependEntries(ref, [entry('older a', 100), entry('older b', 200)]);
      expect(small.partsHeld(ref), greaterThan(2), reason: 'the page raised the cap');

      // A pull-to-refresh. It replaces what was held, so the raised cap would otherwise
      // describe pages that are no longer there — and the cell would quietly hold up to the
      // hard ceiling of purely live history.
      small.seedEntries(ref, [entry('fresh', 9500)]);

      expect(small.partsHeld(ref), lessThanOrEqualTo(2));
    });

    test('survives the live update that arrives while it is being read', () async {
      // The live side already at its cap, which is the state a busy cell is in and the one
      // the first version of this test missed by starting from one part.
      final small = LiveConversation(events.stream, maxParts: 2)..follow([ref]);
      addTearDown(small.dispose);
      await send(turnFrame('t-live', startedAt: 9000));
      await send(partFrame('t-live', 'live-a'));
      await send(partFrame('t-live', 'live-x', text: 'second'));

      small.prepend(ref, [older('old-1', 3), older('old-2', 3)]);
      expect(small.turnsFor(ref).map((t) => t.turnId), ['old-1', 'old-2', 't-live']);

      // A chunk of streaming text, which adds no part…
      await send(textFrame('t-live', 'live-a', '!'));
      expect(small.turnsFor(ref).map((t) => t.turnId), ['old-1', 'old-2', 't-live']);

      // …and a whole new step, which does. This is the one that used to slip through: the
      // allowance was exactly what had been paged in, so it granted no headroom at all and
      // the very next part pushed the cell over and took `old-1` with it.
      await send(partFrame('t-live', 'live-b', text: 'and another'));
      expect(small.turnsFor(ref).map((t) => t.turnId), ['old-1', 'old-2', 't-live'],
          reason: 'a page the operator scrolled up for is not the cap\'s to reclaim');
    });

    /// The legacy lane keeps its own list of entries and caps *that* — a bound the allowance
    /// never saw. Every host older than `conversation-stream` uses this lane, and the app has
    /// no minimum host version, so it is not a corner.
    test('survives a hook entry on the lane that has no deltas', () async {
      final small = LiveConversation(events.stream, maxParts: 4)..follow([ref]);
      addTearDown(small.dispose);
      for (var i = 0; i < 4; i++) {
        small.pushEntry(ref, entry('live $i', 9000 + i));
      }
      final live = small.partsHeld(ref);

      small.prependEntries(ref, [entry('older a', 100), entry('older b', 200)]);
      final paged = small.partsHeld(ref);
      expect(paged, greaterThan(live), reason: 'the page is held');

      small.pushEntry(ref, entry('one more', 9100));

      expect(small.partsHeld(ref), greaterThan(paged - 1),
          reason: 'the page the operator scrolled up for is still there');
    });
  });

  test('a host with no conversation lane still fills the same store, from hook entries',
      () async {
    // The legacy input: this is the one remaining caller of `conversation_builder.dart`,
    // and it exists because the app has no minimum host version.
    events.add((
      mac,
      ServerEvent.fromJson({
        'type': 'notification',
        'event': {
          'kind': 'agent_stop',
          'pane_id': 'p-1',
          'agent_type': 'claude',
          'event': 'prompt-submit',
          'title': '',
          'body': 'run the tests',
          'status': '',
          'cwd': '/w',
          'timestamp': 1000,
        },
      }, host: mac)!
    ));
    await Future<void>.delayed(Duration.zero);

    expect(live.turnsFor(ref), hasLength(1));
    expect(live.turnsFor(ref).single.parts, isNotEmpty);
  });

  test('a host that sends both lanes does not draw every step twice', () async {
    await send(turnFrame('t-1'));
    await send(partFrame('t-1', 'p-a', type: 'user_message', text: 'run the tests'));
    events.add((
      mac,
      ServerEvent.fromJson({
        'type': 'notification',
        'event': {
          'kind': 'agent_stop',
          'pane_id': 'p-1',
          'agent_type': 'claude',
          'event': 'prompt-submit',
          'title': '',
          'body': 'run the tests',
          'status': '',
          'cwd': '/w',
          'timestamp': 1000,
        },
      }, host: mac)!
    ));
    await Future<void>.delayed(Duration.zero);

    // The delta lane already said this step; the entry must not add a second copy.
    expect(live.turnsFor(ref).single.parts, hasLength(1));
  });

  test('a named gap is remembered until something can repair it', () async {
    // The host held nothing as far back as we asked. Papering over it would leave a
    // transcript missing its middle with nothing on screen to say so.
    await send(turnFrame('t-1'));
    expect(live.hasGap(ref), isFalse);

    events.add((
      mac,
      ServerEvent.fromJson({
        'type': 'conversation.truncated',
        'paneId': 'p-1',
        'requestedFromCursor': 3,
        'oldestCursor': 40,
      }, host: mac)!
    ));
    await Future<void>.delayed(Duration.zero);
    expect(live.hasGap(ref), isTrue);

    // Only a real page can repair it — and it does.
    live.seed(ref, [
      Turn(
        turnId: 't-1',
        startedAt: DateTime.fromMillisecondsSinceEpoch(1000),
        parts: const [],
      ),
    ]);
    expect(live.hasGap(ref), isFalse);
  });

  test('a cell that leaves the window takes its gap with it', () async {
    events.add((
      mac,
      ServerEvent.fromJson({
        'type': 'conversation.truncated',
        'paneId': 'p-1',
        'requestedFromCursor': 1,
        'oldestCursor': 9,
      }, host: mac)!
    ));
    await Future<void>.delayed(Duration.zero);
    expect(live.hasGap(ref), isTrue);
    live.follow([CellRef(mac, 'p-2')]);
    expect(live.hasGap(ref), isFalse);
  });

  test('a frame this build cannot read is dropped, not thrown', () {
    expect(
      ServerEvent.fromJson({
        'type': 'conversation',
        'paneId': 'p-1',
        'agentType': 'claude',
        'update': {'kind': 'something_new_in_v2'},
      }, host: mac),
      isNull,
    );
  });

  /// A part identifies a step; a turn only groups them. `bb` keeps this the other way up
  /// from Lotus — its timeline is items keyed by `itemId`, with the turn as metadata — and
  /// this is the rule that matters: an item cannot be on screen twice because a turn moved.
  ///
  /// Measured on a phone on 2026-09-08: one exchange drawn twice, its user bubble and its
  /// reply repeated, because the same two parts arrived under a second turn id.
  group('a part is the same step wherever it is filed', () {
    test('a part already held is updated where it lives, not added again', () async {
      await send(turnFrame('t-1'));
      await send(partFrame('t-1', 'p-a', type: 'user_message', text: 'Halo'));
      await send(partFrame('t-1', 'p-b', text: 'Halo! Ada yang bisa dibantu?', state: 'done'));

      // The same two steps, arriving again under a turn id the host derived differently.
      await send(turnFrame('t-OTHER'));
      await send(partFrame('t-OTHER', 'p-a', type: 'user_message', text: 'Halo'));
      await send(partFrame('t-OTHER', 'p-b', text: 'Halo! Ada yang bisa dibantu?', state: 'done'));

      expect(live.partsHeld(ref), 2);
      final parts = live.turnsFor(ref).expand((t) => t.parts).toList();
      expect(parts.map((p) => p.id), ['p-a', 'p-b']);
    });

    test('the newer content wins, even under a different turn', () async {
      await send(turnFrame('t-1'));
      await send(partFrame('t-1', 'p-a', text: 'Hal', state: 'streaming'));
      await send(partFrame('t-OTHER', 'p-a', text: 'Halo, selesai', state: 'done'));

      final parts = live.turnsFor(ref).expand((t) => t.parts).toList();
      expect(parts, hasLength(1));
      expect((parts.single as AssistantTextPart).text, 'Halo, selesai');
    });

    test('a part for an unopened turn still opens one when it is genuinely new', () async {
      await send(partFrame('t-9', 'p-z'));
      expect(live.turnsFor(ref).single.turnId, 't-9');
      expect(live.partsHeld(ref), 1);
    });
  });

  /// The shape a reply actually arrives in: one part that opens it, then the characters.
  group('prose that arrives a chunk at a time', () {
    test('grows the part it names, without adding a second one', () async {
      await send(turnFrame('t-1'));
      await send(partFrame('t-1', 'p-a', text: 'Saya '));
      await send(textFrame('t-1', 'p-a', 'akan '));
      await send(textFrame('t-1', 'p-a', 'baca file itu.'));

      expect(live.partsHeld(ref), 1);
      final part = live.turnsFor(ref).single.parts.single as AssistantTextPart;
      expect(part.text, 'Saya akan baca file itu.');
      // Still streaming: only a `part` update can settle it (`part/settles-once`).
      expect(part.streaming, isTrue);
    });

    test('a settling part replaces what the deltas built, and does not double it', () async {
      await send(turnFrame('t-1'));
      await send(partFrame('t-1', 'p-a', text: 'Saya '));
      await send(textFrame('t-1', 'p-a', 'akan baca file itu.'));
      // What the host sends when the whole message lands: the same id, the whole text, done.
      await send(partFrame('t-1', 'p-a', text: 'Saya akan baca file itu.', state: 'done'));

      final part = live.turnsFor(ref).single.parts.single as AssistantTextPart;
      expect(part.text, 'Saya akan baca file itu.');
      expect(part.streaming, isFalse);
    });

    test('a delta for a part this client never got is dropped, not guessed at', () async {
      await send(turnFrame('t-1'));
      await send(textFrame('t-1', 'p-missing', 'orphan'));

      // No empty part invented to hang it on. The host does not send this
      // (`part/opens-before-delta`); a phone that is behind simply waits for the settle.
      expect(live.partsHeld(ref), 0);
    });

    test('reasoning grows the same way prose does', () async {
      await send(turnFrame('t-1'));
      await send(partFrame('t-1', 'p-r', type: 'reasoning', text: 'Menim'));
      await send(textFrame('t-1', 'p-r', 'bang dulu.'));

      final part = live.turnsFor(ref).single.parts.single as ReasoningPart;
      expect(part.text, 'Menimbang dulu.');
    });
  });

  /// **The answer shows the moment it is given.**
  ///
  /// The runner's own record is what settles a question for good, but on a cell with a terminal
  /// that record is written only after the keystroke lands — so a phone that waited for it
  /// showed the card, unchanged, for as long as the round trip took, and the operator tapped
  /// again. `bb` closes the same gap with a `resolving` status the client sets itself
  /// (`domain/pending-interactions.ts`), and the server's answer replaces it.
  group('answering shows at once', () {
    QuestionPart open() => QuestionPart(
          id: 'q1',
          ts: DateTime.fromMillisecondsSinceEpoch(1),
          seq: 1,
          provenance: Provenance.derived,
          questions: const [
            UserQuestion(
              question: 'Tabs atau spaces?',
              options: [UserQuestionOption(label: 'Spaces'), UserQuestionOption(label: 'Tabs')],
            ),
          ],
        );

    LiveConversation seeded(QuestionPart part) {
      final live = LiveConversation(const Stream.empty())..follow([ref]);
      addTearDown(live.dispose);
      live.seed(ref, [
        Turn(turnId: 't1', startedAt: DateTime.fromMillisecondsSinceEpoch(0), parts: [part]),
      ]);
      return live;
    }

    test('marks the question answered with the words the operator chose', () {
      final live = seeded(open());

      live.settleQuestion(ref, 'Tabs');

      final question = live.turnsFor(ref).single.parts.whereType<QuestionPart>().single;
      expect(question.answered, {'Tabs atau spaces?': ['Tabs']});
      expect(question.isOpen, isFalse);
    });

    test('tells the screen, so the card comes down without another read', () {
      final live = seeded(open());
      var told = 0;
      live.addListener(() => told++);

      live.settleQuestion(ref, 'Tabs');

      expect(told, 1);
    });

    /// The sequence a real tap produces, in the order `agent_page.dart` produces it.
    ///
    /// `_answer` settles the card, sends the digit, and then calls `_load()` — which
    /// re-seeds this store from a fresh `/conversation`. The host writes its own record of
    /// the answer only after the keystroke lands, so that page still says the question is
    /// open. Reported from a device on 2026-09-10: the card came back and stayed until the
    /// page was left and re-entered.
    test('a re-seed from a host that has not caught up does not reopen the card', () {
      final live = seeded(open());

      live.settleQuestion(ref, 'Tabs');
      // Exactly what `_load()` does next, with the page the host would serve.
      live.seed(ref, [
        Turn(turnId: 't1', startedAt: DateTime.fromMillisecondsSinceEpoch(0), parts: [open()]),
      ]);

      final question = live.turnsFor(ref).single.parts.whereType<QuestionPart>().single;
      expect(question.isOpen, isFalse,
          reason: 'the operator answered; only the host is behind');
      expect(question.answered, {'Tabs atau spaces?': ['Tabs']});
    });

    test('leaves a question that is already over exactly as it was', () {
      final answered = QuestionPart(
        id: 'q1', ts: DateTime.fromMillisecondsSinceEpoch(1), seq: 1,
        provenance: Provenance.derived, questions: open().questions,
        cancelled: true,
      );
      final live = seeded(answered);
      var told = 0;
      live.addListener(() => told++);

      live.settleQuestion(ref, 'Tabs');

      expect(live.turnsFor(ref).single.parts.whereType<QuestionPart>().single.cancelled, isTrue);
      expect(told, 0, reason: 'nothing changed, so nothing to redraw');
    });
  });
}
