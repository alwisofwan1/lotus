import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/data/wake_resolver.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/server_event.dart';

const mac = HostId('mac');

Cell cell(String paneId) => Cell(
      host: mac,
      paneId: paneId,
      workspaceId: 'ws',
      agentType: 'claude',
      title: 'Atlas',
      status: 'live',
      isAlive: true,
    );

void main() {
  late StreamController<HostEvent> events;
  late FleetStore store;

  setUp(() {
    events = StreamController<HostEvent>(sync: true);
    store = FleetStore(events.stream);
  });

  tearDown(() {
    store.dispose();
    events.close();
  });

  test('answers at once when the pane is already in the fleet', () async {
    events.add((mac, FleetChangedEvent(cells: [cell('canvas:x:abc-1')])));

    final found = await WakeResolver(store).resolve('abc-1');

    expect(found?.ref, CellRef(mac, 'canvas:x:abc-1'));
  });

  test('waits for the fleet to arrive — the tap that launched the app comes first', () async {
    final pending = WakeResolver(store).resolve('p-1');
    await pumpEventQueue();

    events.add((mac, FleetChangedEvent(cells: [cell('p-1')])));

    expect((await pending)?.paneId, 'p-1');
    // ignore: invalid_use_of_protected_member
    expect(store.hasListeners, isFalse, reason: 'the wait must not leave a listener behind');
  });

  test('gives up after its patience, so a pane closed meanwhile does not hang the tap', () async {
    final resolver = WakeResolver(store, patience: const Duration(milliseconds: 30));

    expect(await resolver.resolve('gone'), isNull);
    // ignore: invalid_use_of_protected_member
    expect(store.hasListeners, isFalse);
  });
}
