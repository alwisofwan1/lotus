import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/measurement_log.dart';

void main() {
  test('one JSON object per line, in the record format issues/01 fixes', () {
    final log = MeasurementLog(now: () => DateTime.fromMillisecondsSinceEpoch(1786591386106));

    log.record('terminal.rebuild', 65536, labels: {'paneId': 'p-1'});

    final decoded = jsonDecode(log.copyText()) as Map<String, Object?>;
    expect(decoded, {
      'at': 1786591386106,
      'layer': 'pocket',
      'metric': 'terminal.rebuild',
      'value': 65536,
      'labels': {'paneId': 'p-1'},
    });
  });

  test('labels default to empty rather than null, so a reader never sees a missing key',
      () {
    final log = MeasurementLog();

    log.record('buffer.cleared', 0);

    final decoded = jsonDecode(log.copyText()) as Map<String, Object?>;
    expect(decoded['labels'], <String, Object?>{});
  });

  test('each call is its own line', () {
    final log = MeasurementLog();

    log.record('output.evicted', 10);
    log.record('output.evicted', 20);

    expect(log.copyText().split('\n'), hasLength(2));
    expect(log.length, 2);
  });

  test('bounded: the oldest line is dropped and the drop is counted, not silent', () {
    final log = MeasurementLog(capacity: 2);

    log.record('output.evicted', 1);
    log.record('output.evicted', 2);
    log.record('output.evicted', 3);

    expect(log.length, 2);
    expect(log.droppedLines, 1);
    // The oldest (value 1) is what left, not the newest.
    final values = log
        .copyText()
        .split('\n')
        .map((line) => (jsonDecode(line) as Map<String, Object?>)['value'])
        .toList();
    expect(values, [2, 3]);
  });

  test('a failure inside record() never reaches the caller', () {
    // `record()` is called from inside `OutputBuffer._trim` and
    // `LiveTranscript._sortAndTrim` — a real render/stream path, not a test harness —
    // so this exercises the actual guarantee rather than trusting the `try` reads right.
    final log = MeasurementLog(now: () => throw StateError('clock is broken'));

    expect(() => log.record('output.evicted', 1), returnsNormally);
    expect(log.copyText(), isEmpty);
  });
}
