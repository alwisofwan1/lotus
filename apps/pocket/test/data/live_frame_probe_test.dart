import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/live_transcript.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/server_event.dart';

/// Verbatim off the wire on 2026-09-06, from a standalone host on devbox-vps.
const String WIRE = '{"type":"notification","event":{"kind":"agent_stop",'
    '"pane_id":"e7c2ded4-495b-47b3-9393-9b1eb5a9f06e","agent_type":"claude",'
    '"event":"stop","status":"idle","title":"Finished working",'
    '"body":"Hi — ada yang bisa dibantu?","user_prompt":"","tool_target":"",'
    '"cwd":"/home/alwi/lotus-probe","timestamp":1788712276908}}';

void main() {
  const host = HostId('vps');
  const paneId = 'e7c2ded4-495b-47b3-9393-9b1eb5a9f06e';

  test('the frame parses at all', () {
    final json = jsonDecode(WIRE) as Map<String, Object?>;
    final event = ServerEvent.fromJson(json, host: host);
    expect(event, isA<NotificationEvent>(), reason: 'the wire frame must become a notification');
    expect((event! as NotificationEvent).hook.paneId, paneId);
  });

  test('a followed cell appends it', () async {
    final controller = StreamController<HostEvent>();
    final live = LiveTranscript(controller.stream);
    live.follow(const [CellRef(host, paneId)]);

    controller.add((host, ServerEvent.fromJson(jsonDecode(WIRE) as Map<String, Object?>, host: host)!));
    await Future<void>.delayed(Duration.zero);

    expect(live.entriesFor(const CellRef(host, paneId)), hasLength(1));
  });
}
