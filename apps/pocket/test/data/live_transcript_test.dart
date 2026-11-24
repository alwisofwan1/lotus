import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/live_transcript.dart';
import 'package:lotus_pocket/data/measurement_log.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/notification_event.dart' show HookNotification;
import 'package:lotus_pocket/models/server_event.dart';
import 'package:lotus_pocket/models/transcript.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');
const CellRef atlas = CellRef(mac, 'p-1');

/// A forwarded hook frame, in the shape the host actually sends: snake_case, straight
/// through from Rust.
HostEvent frame({
  HostId host = mac,
  String? paneId = 'p-1',
  String event = 'tool-pre',
  String title = 'Bash',
  String toolTarget = 'ls',
  String body = '',
  String? userPrompt,
  int? linesAdded,
  int? linesRemoved,
  bool bodyTruncated = false,
  int at = 1000,
}) =>
    (
      host,
      NotificationEvent(
        hook: HookNotification.fromJson({
          'kind': 'agent_stop',
          'timestamp': at,
          'pane_id': ?paneId,
          'agent_type': 'claude',
          'event': event,
          'tool_target': toolTarget,
          'title': title,
          'body': body,
          'status': 'running',
          'user_prompt': ?userPrompt,
          'lines_added': ?linesAdded,
          'lines_removed': ?linesRemoved,
          'body_truncated': bodyTruncated,
        }),
      ),
    );

TranscriptEntry entry({
  String event = 'tool-pre',
  String title = 'Bash',
  String toolTarget = 'ls',
  String body = '',
  String userPrompt = '',
  int at = 1000,
}) =>
    TranscriptEntry(
      event: event,
      status: 'running',
      title: title,
      body: body,
      userPrompt: userPrompt,
      toolTarget: toolTarget,
      timestamp: DateTime.fromMillisecondsSinceEpoch(at),
    );

void main() {
  _prependGroup();
  late StreamController<HostEvent> events;
  late LiveTranscript live;

  setUp(() {
    events = StreamController<HostEvent>.broadcast();
    live = LiveTranscript(events.stream);
  });

  tearDown(() async {
    live.dispose();
    await events.close();
  });

  Future<void> push(HostEvent e) async {
    events.add(e);
    await pumpEventQueue();
  }

  test('holds nothing until a cell is being followed', () async {
    await push(frame());

    // Same rule as `OutputBuffer`: collecting for a screen nobody opened is memory
    // spent on a pane the operator is not looking at.
    expect(live.entriesFor(atlas), isEmpty);
    expect(live.isFollowing(atlas), isFalse);
  });

  test('a forwarded hook frame becomes a transcript entry', () async {
    live.follow([atlas]);

    await push(frame(title: 'Edit', toolTarget: 'src/legacy/shim.ts', linesRemoved: 34));

    final only = live.entriesFor(atlas).single;
    expect(only.title, 'Edit');
    expect(only.toolTarget, 'src/legacy/shim.ts');
    expect(only.linesRemoved, 34);
    // Absent stays absent: a `Read` must never render `+0 −0`.
    expect(only.linesAdded, isNull);
  });

  test('the prompt rides through, so the bubble does not wait for a refetch', () async {
    live.follow([atlas]);

    await push(frame(event: 'prompt-submit', userPrompt: 'clean up the legacy files'));

    expect(live.entriesFor(atlas).single.userPrompt, 'clean up the legacy files');
  });

  test('a truncated reply keeps saying so', () async {
    live.follow([atlas]);

    await push(frame(event: 'stop', body: 'I removed the shim and', bodyTruncated: true));

    expect(live.entriesFor(atlas).single.bodyTruncated, isTrue);
  });

  group('identity', () {
    test('another pane on the same host is ignored', () async {
      live.follow([atlas]);

      await push(frame(paneId: 'p-2'));

      expect(live.entriesFor(atlas), isEmpty);
    });

    test('the same pane id on another host is ignored', () async {
      live.follow([atlas]);

      // R-10: two machines can each run a `p-1`, and the wrong one's steps rendered
      // here would look exactly like the right one's.
      await push(frame(host: vps));

      expect(live.entriesFor(atlas), isEmpty);
    });

    test('a frame the host could not correlate to a pane is dropped, not guessed at',
        () async {
      live.follow([atlas]);

      // The host's own transcript store applies the same rule: several canvas agents
      // share one cwd, so an uncorrelated payload has no cell to belong to.
      await push(frame(paneId: null));

      expect(live.entriesFor(atlas), isEmpty);
    });
  });

  group('seeding from the host snapshot', () {
    test('the snapshot becomes the starting point', () {
      live.follow([atlas]);

      live.seed(atlas, [entry(title: 'Read', at: 500), entry(title: 'Edit', at: 600)]);

      expect(live.entriesFor(atlas).map((e) => e.title), ['Read', 'Edit']);
    });

    test('frames that arrived while the fetch was in flight are kept, not erased',
        () async {
      live.follow([atlas]);
      // The real sequence: `watch` happens before the HTTP request goes out, so a turn
      // that produces events during that round trip lands here first. A `seed` that
      // replaced the list would throw them away — and over a tailnet that window is
      // long enough to hold a dozen steps.
      await push(frame(title: 'Grep', at: 700));

      live.seed(atlas, [entry(title: 'Read', at: 500)]);

      expect(live.entriesFor(atlas).map((e) => e.title), ['Read', 'Grep']);
    });

    test('an entry the snapshot already contains is not shown twice', () async {
      live.follow([atlas]);
      await push(frame(title: 'Read', toolTarget: 'ls', at: 500));

      live.seed(atlas, [entry(title: 'Read', toolTarget: 'ls', at: 500)]);

      expect(live.entriesFor(atlas), hasLength(1));
    });

    test('two steps in the same millisecond both survive', () async {
      live.follow([atlas]);

      // Timestamps come from `Date.now()` in the hook script, so a burst shares a
      // millisecond. Deduping by "newer than the last seed entry" would silently drop
      // one of these — which is why the key is composite.
      await push(frame(title: 'Bash', toolTarget: 'ls', at: 900));
      await push(frame(title: 'Bash', toolTarget: 'pwd', at: 900));

      expect(live.entriesFor(atlas), hasLength(2));
    });

    test('a seed for a cell the pager has left behind is refused', () async {
      live.follow([atlas]);
      live.follow(const [CellRef(mac, 'p-2')]);

      // The swipe already happened and carried on far enough that this cell is out of
      // reach; the in-flight fetch belongs to a page nobody can get back to in one move.
      live.seed(atlas, [entry(title: 'Read')]);

      expect(live.entriesFor(atlas), isEmpty);
    });

    test('a seed for a cell still in the window lands even when it is off screen', () {
      // The whole point of a window: the read for the page one swipe away completes
      // while another page is on screen, and it must not be thrown away for that.
      live.follow(const [atlas, CellRef(mac, 'p-2')]);

      live.seed(atlas, [entry(title: 'Read')]);

      expect(live.entriesFor(atlas).single.title, 'Read');
    });
  });

  group('ordering and bounds', () {
    test('entries stay oldest-first even when a late frame arrives out of order',
        () async {
      live.follow([atlas]);

      await push(frame(title: 'Second', at: 2000));
      await push(frame(title: 'First', at: 1000));

      expect(live.entriesFor(atlas).map((e) => e.title), ['First', 'Second']);
    });

    test('the oldest is dropped past the host\'s own ring size', () async {
      live = LiveTranscript(events.stream, maxEntries: 3);
      live.follow([atlas]);

      for (var i = 0; i < 5; i++) {
        await push(frame(title: 'step$i', at: 1000 + i));
      }

      // Bounded to what the host can replay, so this and a reload cannot disagree
      // about history — the reasoning that ties `OutputBuffer.maxBytes` to the host's
      // ring buffer.
      expect(live.entriesFor(atlas).map((e) => e.title), ['step2', 'step3', 'step4']);
    });
  });

  group('the window', () {
    const borea = CellRef(mac, 'p-2');
    const cirrus = CellRef(mac, 'p-3');

    test('a cell still in reach keeps collecting while another is on screen', () async {
      live.follow(const [atlas, borea]);

      await push(frame());

      // This is what makes a swipe back land on a page that is already current, and it
      // costs nothing on the wire: the host broadcasts these frames whether or not
      // anyone files them.
      expect(live.entriesFor(atlas), hasLength(1));
    });

    test('a cell that falls out of the window is dropped entirely', () async {
      live.follow(const [atlas, borea]);
      await push(frame());

      live.follow(const [borea, cirrus]);

      expect(live.entriesFor(atlas), isEmpty);
      expect(live.isFollowing(atlas), isFalse);
    });

    test('a cell that comes back does not silently discard its first entries', () async {
      // Eviction has to drop the seen-keys with the entries. Keeping them would leave a
      // set that never shrinks *and* make a re-entered cell treat its own replayed
      // history as duplicates — a page that fills with everything except its oldest steps.
      live.follow(const [atlas]);
      await push(frame(title: 'Read', toolTarget: 'ls', at: 500));

      live.follow(const [borea]);
      live.follow(const [atlas]);
      await push(frame(title: 'Read', toolTarget: 'ls', at: 500));

      expect(live.entriesFor(atlas), hasLength(1));
    });

    test('never holds more cells than the pager can reach', () {
      live = LiveTranscript(events.stream, maxCells: 2);

      live.follow(const [atlas, borea, cirrus]);

      // The pager is the one that decides the window, so this is a ceiling and not a
      // policy — it refuses to be handed more than the design says exists.
      expect(live.following, hasLength(2));
      expect(live.isFollowing(atlas), isFalse);
    });

    test('following the same cells again is not a change', () {
      live.follow(const [atlas, borea]);
      var notifications = 0;
      live.addListener(() => notifications++);

      live.follow(const [borea, atlas]);

      expect(notifications, isZero);
    });

    test('leaving the pager drops everything', () async {
      live.follow(const [atlas, borea]);
      await push(frame());

      live.forget();

      expect(live.entriesFor(atlas), isEmpty);
      expect(live.following, isEmpty);
    });
  });

  test('notifies so the open page rebuilds', () async {
    live.follow([atlas]);
    var notifications = 0;
    live.addListener(() => notifications++);

    await push(frame());

    // The whole point: Chat used to fill once on open and stand still until the
    // operator left the page and came back.
    expect(notifications, greaterThan(0));
  });

  test('events belonging to other surfaces are left alone', () async {
    live.follow([atlas]);

    await push((mac, const FleetChangedEvent(cells: [])));
    await push((mac, const CellOutputEvent(paneId: 'p-1', chunk: 'x', byteOffset: 1)));

    expect(live.entriesFor(atlas), isEmpty);
  });

  group('Fase 0 counting (issues/01 no. 3) — drops land in a MeasurementLog', () {
    List<Map<String, Object?>> recorded(MeasurementLog log) => log
        .copyText()
        .split('\n')
        .where((line) => line.isNotEmpty)
        .map((line) => jsonDecode(line) as Map<String, Object?>)
        .toList();

    Map<String, Object?> labelsOf(Map<String, Object?> line) =>
        line['labels']! as Map<String, Object?>;

    test('one line per dropped entry, not one per trim', () async {
      final measurements = MeasurementLog();
      final tracked = LiveTranscript(events.stream, maxEntries: 3, measurements: measurements);
      addTearDown(tracked.dispose);
      tracked.follow([atlas]);

      for (var i = 0; i < 5; i++) {
        await push(frame(title: 'step$i', at: 1000 + i));
      }

      // 5 accepted, 3 kept: exactly 2 must have gone, matching the ring's own count
      // rather than `_sortAndTrim`'s loop count in isolation.
      final drops = recorded(measurements).where((l) => l['metric'] == 'transcript.dropped');
      expect(drops, hasLength(2));
      expect(drops.every((l) => l['value'] == 1), isTrue);
      expect(drops.every((l) => labelsOf(l)['paneId'] == 'p-1'), isTrue);
    });

    test(
        'the first drop names how many entries this cell had ever accumulated — '
        '"how many turns fit"', () async {
      final measurements = MeasurementLog();
      final tracked = LiveTranscript(events.stream, maxEntries: 3, measurements: measurements);
      addTearDown(tracked.dispose);
      tracked.follow([atlas]);

      for (var i = 0; i < 5; i++) {
        await push(frame(title: 'step$i', at: 1000 + i));
      }

      final drops = recorded(measurements).where((l) => l['metric'] == 'transcript.dropped');
      // The 4th live frame is what first pushes the cell past `maxEntries: 3`.
      expect(labelsOf(drops.first)['sinceCreate'], '4');
    });

    test('a seed merge that overflows in one step is counted too', () {
      final measurements = MeasurementLog();
      final tracked = LiveTranscript(events.stream, maxEntries: 2, measurements: measurements);
      addTearDown(tracked.dispose);
      tracked.follow([atlas]);

      tracked.seed(atlas, [
        entry(title: 'a', at: 1),
        entry(title: 'b', at: 2),
        entry(title: 'c', at: 3),
      ]);

      final drops = recorded(measurements).where((l) => l['metric'] == 'transcript.dropped');
      expect(drops, hasLength(1));
    });

    test('every LiveTranscript gets its own log unless one is handed in', () {
      final a = LiveTranscript(events.stream);
      final b = LiveTranscript(events.stream);
      addTearDown(a.dispose);
      addTearDown(b.dispose);

      expect(identical(a.measurements, b.measurements), isFalse);
    });
  });
}

void _prependGroup() {
  group('Fase 3 — older pages extend history backwards', () {
    late StreamController<HostEvent> events;
    late LiveTranscript live;

    setUp(() {
      events = StreamController<HostEvent>.broadcast();
      live = LiveTranscript(events.stream)..follow([atlas]);
    });

    tearDown(() async {
      live.dispose();
      await events.close();
    });

    TranscriptEntry at(int ms, String body) => TranscriptEntry(
          event: 'stop',
          status: 'idle',
          title: 'Finished working',
          body: body,
          userPrompt: '',
          toolTarget: '',
          timestamp: DateTime.fromMillisecondsSinceEpoch(ms),
        );

    test('older entries land in front of what is already held', () {
      live.seed(atlas, [at(300, 'c')]);
      live.prepend(atlas, [at(100, 'a'), at(200, 'b')]);

      expect(
        live.entriesFor(atlas).map((e) => e.body),
        ['a', 'b', 'c'],
        reason: 'oldest first, the order Chat renders top to bottom',
      );
    });

    /// A page boundary that overlaps by one entry must not draw that entry twice.
    test('an entry already held is not added again', () {
      live.seed(atlas, [at(200, 'b'), at(300, 'c')]);
      live.prepend(atlas, [at(100, 'a'), at(200, 'b')]);

      expect(live.entriesFor(atlas).map((e) => e.body), ['a', 'b', 'c']);
    });

    /// Trimming from the front — what every other path here does — would throw away
    /// exactly what the operator just scrolled up to fetch.
    test('the cap drops the newest, not the page just fetched', () {
      final small = LiveTranscript(events.stream, maxEntries: 2)..follow([atlas]);
      addTearDown(small.dispose);
      small.seed(atlas, [at(300, 'c')]);

      small.prepend(atlas, [at(100, 'a'), at(200, 'b')]);

      expect(small.entriesFor(atlas).map((e) => e.body), ['a', 'b']);
    });

    test('a cell outside the window is refused, like every other writer here', () {
      live.prepend(const CellRef(vps, 'p-9'), [at(100, 'a')]);
      expect(live.entriesFor(const CellRef(vps, 'p-9')), isEmpty);
    });
  });
}
