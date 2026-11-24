import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/measurement_log.dart';
import 'package:lotus_pocket/data/output_buffer.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/server_event.dart';

/// The source Terminal mode writes from. Bytes in order, and an honest account of what
/// is missing (R-4) — nothing else, because `xterm.dart` is the emulator.
const HostId mac = HostId('mac');
const HostId vps = HostId('vps');
const macPane = CellRef(mac, 'p-1');

void main() {
  late StreamController<HostEvent> events;
  late OutputBuffer buffer;

  setUp(() {
    events = StreamController<HostEvent>.broadcast();
    buffer = OutputBuffer(events.stream);
  });

  tearDown(() async {
    buffer.dispose();
    await events.close();
  });

  void emitOutput(HostId host, String paneId, String chunk, {int offset = 0}) =>
      events.add((host, CellOutputEvent(paneId: paneId, chunk: chunk, byteOffset: offset)));

  test('holds nothing until a cell is being watched', () async {
    emitOutput(mac, 'p-1', 'hello');
    await pumpEventQueue();

    // A buffer that collected output for a screen nobody opened would replay a stranger's
    // bytes into the first terminal that mounts.
    expect(buffer.replay, isEmpty);
    expect(buffer.watching, isNull);
  });

  test('collects the watched pane in order, with the offset a resume needs', () async {
    buffer.watch(macPane);

    emitOutput(mac, 'p-1', 'first ', offset: 6);
    emitOutput(mac, 'p-1', 'second', offset: 12);
    await pumpEventQueue();

    expect(buffer.replay, 'first second');
    expect(buffer.lastByteOffset, 12);
    expect(buffer.truncated, isFalse);
  });

  test('ANSI is carried through untouched', () async {
    buffer.watch(macPane);
    const frame = '\x1b[?1049h\x1b[2J\x1b[31mred\x1b[0m';

    emitOutput(mac, 'p-1', frame);
    await pumpEventQueue();

    // Interpreting or stripping any of this here would be doing the emulator's job, and
    // `issues/03` settled that the emulator is `xterm.dart`.
    expect(buffer.replay, frame);
  });

  test('another pane on the same host is ignored', () async {
    buffer.watch(macPane);

    emitOutput(mac, 'p-2', 'not mine');
    await pumpEventQueue();

    expect(buffer.replay, isEmpty);
  });

  test('the same pane id on another host is ignored', () async {
    buffer.watch(macPane);

    emitOutput(vps, 'p-1', 'from the vps');
    await pumpEventQueue();

    // R-10: two hosts can each run a `p-1`, and once rendered into this terminal the
    // wrong machine's bytes are indistinguishable from the right ones.
    expect(buffer.replay, isEmpty);
  });

  test('new chunks also arrive as writes, for an already-mounted terminal', () async {
    buffer.watch(macPane);
    final written = <String>[];
    buffer.writes.listen(written.add);

    emitOutput(mac, 'p-1', 'a');
    emitOutput(mac, 'p-1', 'b');
    await pumpEventQueue();

    expect(written, ['a', 'b']);
  });

  test('replay and writes together lose nothing', () async {
    buffer.watch(macPane);
    emitOutput(mac, 'p-1', 'before ');
    await pumpEventQueue();

    // Exactly how a terminal mounts: take what is held and subscribe, in one
    // synchronous step. Nothing can interleave, because stream events are microtasks.
    final seen = StringBuffer(buffer.replay);
    buffer.writes.listen(seen.write);

    emitOutput(mac, 'p-1', 'after');
    await pumpEventQueue();

    expect(seen.toString(), 'before after');
  });

  group('what is missing is said out loud', () {
    test('a ring buffer that could not reach back is reported', () async {
      buffer.watch(macPane);

      events.add((
        mac,
        const CellTruncatedEvent(paneId: 'p-1', requestedFromByte: 1000, servedFromByte: 4000),
      ));
      await pumpEventQueue();

      // R-4: the host says so rather than silently serving a later position, and the app
      // must pass that on rather than showing a seamless-looking screen.
      expect(buffer.truncated, isTrue);
      expect(buffer.missingBytes, 3000);
    });

    test('a truncation for another pane is not this pane\'s gap', () async {
      buffer.watch(macPane);

      events.add((
        mac,
        const CellTruncatedEvent(paneId: 'p-2', requestedFromByte: 0, servedFromByte: 500),
      ));
      await pumpEventQueue();

      expect(buffer.truncated, isFalse);
    });

    test('trimming to budget is eviction, not loss', () async {
      final small = OutputBuffer(events.stream, maxBytes: 10)..watch(macPane);
      addTearDown(small.dispose);

      emitOutput(mac, 'p-1', '1234567890');
      emitOutput(mac, 'p-1', 'abcde');
      await pumpEventQueue();

      // Dropped whole, never cut mid-escape-sequence: half a command would leave the
      // emulator a corrupted screen, which is worse than a shorter one.
      expect(small.replay, 'abcde');
      // These bytes arrived and were written to the terminal — only the replay snapshot
      // let them go. Counting them as missing told the operator a screen-painting CLI had
      // lost 34 MB it had in fact drawn.
      expect(small.evictedBytes, 10);
      expect(small.missingBytes, 0);
      expect(small.truncated, isFalse);
    });

    test('the last chunk is never dropped, however large', () async {
      final small = OutputBuffer(events.stream, maxBytes: 4)..watch(macPane);
      addTearDown(small.dispose);

      emitOutput(mac, 'p-1', 'far larger than the budget');
      await pumpEventQueue();

      // Trimming to nothing would leave a blank terminal for a cell that is producing
      // output — the one reading the operator would call broken.
      expect(small.replay, 'far larger than the budget');
    });
  });

  group('swiping to another agent', () {
    test('clears the previous cell entirely', () async {
      buffer.watch(macPane);
      emitOutput(mac, 'p-1', 'mac output');
      events.add((
        mac,
        const CellTruncatedEvent(paneId: 'p-1', requestedFromByte: 0, servedFromByte: 90),
      ));
      await pumpEventQueue();

      buffer.watch(const CellRef(mac, 'p-2'));

      expect(buffer.replay, isEmpty);
      expect(buffer.lastByteOffset, isNull);
      // A gap belongs to the pane it happened in; carrying it across a swipe would
      // report a hole in output the operator is not looking at.
      expect(buffer.truncated, isFalse);
    });

    test('releasing the cell you hold detaches, and says it did', () async {
      buffer.watch(macPane);
      emitOutput(mac, 'p-1', 'mac output');
      await pumpEventQueue();

      expect(buffer.release(macPane), isTrue);
      expect(buffer.watching, isNull);
      expect(buffer.replay, isEmpty);
    });

    test('releasing a cell you do not hold leaves the tail alone', () async {
      buffer.watch(macPane);
      emitOutput(mac, 'p-1', 'mac output');
      await pumpEventQueue();

      // The pager keeps neighbouring pages mounted, so a page being disposed is no
      // longer proof it is the one holding the tail (`issues/12`). The `false` is what
      // stops the caller cancelling a socket subscription that is not theirs.
      expect(buffer.release(const CellRef(mac, 'p-2')), isFalse);
      expect(buffer.watching, macPane);
      expect(buffer.replay, 'mac output');
    });

    test('watching the same cell again is not a reset', () async {
      buffer.watch(macPane);
      emitOutput(mac, 'p-1', 'kept');
      await pumpEventQueue();

      buffer.watch(macPane);

      expect(buffer.replay, 'kept');
    });

    test('detaching stops collecting', () async {
      buffer.watch(macPane);
      buffer.watch(null);

      emitOutput(mac, 'p-1', 'ignored');
      await pumpEventQueue();

      expect(buffer.replay, isEmpty);
    });
  });

  test('events belonging to other surfaces are left alone', () async {
    buffer.watch(macPane);
    var notifications = 0;
    buffer.addListener(() => notifications += 1);

    events.add((mac, const FleetChangedEvent(cells: [])));
    await pumpEventQueue();

    expect(buffer.replay, isEmpty);
    expect(notifications, 0, reason: 'a terminal must not rebuild for a fleet update');
  });

  group('Fase 0 counting (issues/01) — a shared MeasurementLog gets every event', () {
    List<Map<String, Object?>> recorded(MeasurementLog log) => log
        .copyText()
        .split('\n')
        .where((line) => line.isNotEmpty)
        .map((line) => jsonDecode(line) as Map<String, Object?>)
        .toList();

    Map<String, Object?> labelsOf(Map<String, Object?> line) =>
        line['labels']! as Map<String, Object?>;

    test('eviction is counted, not just tallied on the getter', () async {
      final measurements = MeasurementLog();
      final small = OutputBuffer(events.stream, maxBytes: 10, measurements: measurements)
        ..watch(macPane);
      addTearDown(small.dispose);

      emitOutput(mac, 'p-1', '1234567890');
      emitOutput(mac, 'p-1', 'abcde');
      await pumpEventQueue();

      final evicted = recorded(measurements).where((l) => l['metric'] == 'output.evicted');
      expect(evicted, hasLength(1));
      expect(evicted.single['value'], 10);
      expect(labelsOf(evicted.single)['paneId'], 'p-1');
    });

    test('a host-reported gap is counted separately from eviction', () async {
      final measurements = MeasurementLog();
      final tracked = OutputBuffer(events.stream, measurements: measurements)..watch(macPane);
      addTearDown(tracked.dispose);

      events.add((
        mac,
        const CellTruncatedEvent(paneId: 'p-1', requestedFromByte: 1000, servedFromByte: 4000),
      ));
      await pumpEventQueue();

      final missing = recorded(measurements).where((l) => l['metric'] == 'output.missing');
      expect(missing, hasLength(1));
      expect(missing.single['value'], 3000);
      expect(recorded(measurements).any((l) => l['metric'] == 'output.evicted'), isFalse);
    });

    test('switching cells is counted, but only when something was actually held',
        () async {
      final measurements = MeasurementLog();
      final tracked = OutputBuffer(events.stream, measurements: measurements);
      addTearDown(tracked.dispose);

      // Nothing was watched before this — moving off nothing costs the operator
      // nothing, so it must not appear in the log.
      tracked.watch(macPane);
      emitOutput(mac, 'p-1', 'mac output');
      await pumpEventQueue();

      tracked.watch(const CellRef(mac, 'p-2'));

      final cleared = recorded(measurements).where((l) => l['metric'] == 'buffer.cleared');
      expect(cleared, hasLength(1));
      expect(cleared.single['value'], 'mac output'.length);
      expect(labelsOf(cleared.single)['paneId'], 'p-1');
    });

    test('every OutputBuffer gets its own log unless one is handed in', () {
      final a = OutputBuffer(events.stream);
      final b = OutputBuffer(events.stream);
      addTearDown(a.dispose);
      addTearDown(b.dispose);

      // Existing callers construct `OutputBuffer` with no third argument at all
      // (`agent_repository_test.dart`, `composition_root.dart` before this ticket);
      // this is what keeps that source compiling unchanged.
      expect(identical(a.measurements, b.measurements), isFalse);
    });
  });
}
