import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/output_buffer.dart';
import 'package:lotus_pocket/features/agent/input_latency_probe.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/server_event.dart';

/// v4 tiket 12: typing latency is counted into the log Settings copies out.
void main() {
  const mac = HostId('mac');
  const pane = CellRef(mac, 'p-1');

  late StreamController<HostEvent> events;
  late OutputBuffer buffer;
  late InputLatencyProbe probe;
  var offset = 0;

  setUp(() {
    events = StreamController<HostEvent>();
    buffer = OutputBuffer(events.stream)..watch(pane);
    probe = InputLatencyProbe(buffer, pane);
    offset = 0;
  });

  tearDown(() {
    probe.dispose();
    buffer.dispose();
    events.close();
  });

  Future<void> output(String paneId, String chunk) async {
    events.add((mac, CellOutputEvent(paneId: paneId, chunk: chunk, byteOffset: offset)));
    offset += chunk.length;
    await pumpEventQueue();
  }

  List<Map<String, Object?>> lines(String metric) => [
        for (final l in const LineSplitter().convert(buffer.measurements.copyText()))
          if ((jsonDecode(l) as Map<String, Object?>)['metric'] == metric)
            jsonDecode(l) as Map<String, Object?>,
      ];

  test('a key and the output after it make one echo; output with no key makes none', () async {
    await output('p-1', 'banner');
    expect(lines('input.echo'), isEmpty);

    probe.pressed('l');
    probe.pressed('s'); // the clock runs from the first key still waiting
    await output('p-1', 'l');
    await output('p-1', 's');

    expect(lines('input.echo'), hasLength(1));
    expect((lines('input.echo').single['labels']! as Map)['paneId'], 'p-1');
  });

  test("the emulator's own replies start no clock", () async {
    for (final reply in ['\x1b[12;40R', '\x1b[I', '\x1b[?1;2c', '\x1b]11;rgb:0/0/0\x1b\\']) {
      probe.pressed(reply);
    }
    await output('p-1', 'redraw');
    expect(lines('input.echo'), isEmpty);
  });

  test('each POST is timed with its size', () async {
    final send = probe.timed((_) async {});
    await send('hello');
    final post = lines('input.post').single;
    expect((post['labels']! as Map)['bytes'], '5');
    expect(post['value'], isA<int>());
  });
}
