import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/wake_routing.dart';
import 'package:lotus_pocket/core/push_messages.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/data/wake_resolver.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/push_wake.dart';
import 'package:lotus_pocket/models/server_event.dart';

const mac = HostId('mac');

class FakePushMessages implements PushMessages {
  final foregroundCtl = StreamController<PushWake>.broadcast();
  final openedCtl = StreamController<PushWake>.broadcast();

  @override
  Stream<PushWake> get foreground => foregroundCtl.stream;

  @override
  Stream<PushWake> get opened => openedCtl.stream;
}

const atlas = PushWake(kind: WakeKind.attention, paneId: 'p-1', title: 'Atlas', body: 'needs you');

void main() {
  late StreamController<HostEvent> events;
  late FleetStore store;
  late FakePushMessages messages;
  late List<Cell> opened;
  WakeRouting? routing;
  final messenger = GlobalKey<ScaffoldMessengerState>();

  setUp(() {
    events = StreamController<HostEvent>(sync: true);
    store = FleetStore(events.stream);
    messages = FakePushMessages();
    opened = [];
  });

  tearDown(() {
    routing?.dispose();
    store.dispose();
    events.close();
  });

  // Inside the test body, not `setUp`: subscriptions and timers must be born in the
  // tester's zone, or `pump` cannot drive them.
  void start() => routing = WakeRouting(
        messages: messages,
        wakes: WakeResolver(store, patience: const Duration(milliseconds: 50)),
        messenger: messenger,
        open: opened.add,
      );

  Widget app() => MaterialApp(
        scaffoldMessengerKey: messenger,
        home: const Scaffold(body: SizedBox()),
      );

  void fleetHas(String paneId) => events.add((
        mac,
        FleetChangedEvent(cells: [
          Cell(host: mac, paneId: paneId, workspaceId: 'ws', agentType: 'claude', title: 'Atlas', status: 'live', isAlive: true),
        ]),
      ));

  testWidgets('a wake-up while the app is open is one sentence with a way there', (tester) async {
    await tester.pumpWidget(app());
    start();
    fleetHas('p-1');

    messages.foregroundCtl.add(atlas);
    await tester.pumpAndSettle();

    expect(find.text('Atlas needs you'), findsOneWidget);
    await tester.tap(find.text('OPEN'));
    await tester.pumpAndSettle();
    expect(opened.map((c) => c.paneId), ['p-1']);
  });

  testWidgets('a tapped notification opens the agent it names', (tester) async {
    await tester.pumpWidget(app());
    start();
    fleetHas('p-1');

    messages.openedCtl.add(atlas);
    await tester.pump();

    expect(opened.map((c) => c.paneId), ['p-1']);
    expect(find.byType(SnackBar), findsNothing);
  });

  testWidgets('says so when the agent is gone, instead of opening nothing silently', (tester) async {
    await tester.pumpWidget(app());
    start();

    messages.openedCtl.add(atlas);
    await tester.pump(const Duration(milliseconds: 100));

    expect(opened, isEmpty);
    expect(find.text('Atlas is no longer on any machine.'), findsOneWidget);
  });
}
