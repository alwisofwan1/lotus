import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/projects_route.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/hosts/paired_host.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../support/fake_security.dart';
import '../support/fake_transport.dart';

const HostId vps = HostId('vps');

PairedHost pairedVps(List<String> features) => PairedHost(
      id: vps,
      label: 'vps',
      baseUri: Uri.parse('ws://vps:8787'),
      mode: 'standalone',
      caps: HostCaps(protocol: 1, features: features),
    );

Map<String, Object?> helloWith(List<String> features) => {
      'type': 'hello',
      'hostId': vps.value,
      'hostLabel': 'vps',
      'mode': 'standalone',
      'hostCaps': {'protocol': 1, 'features': features},
    };

/// The seam that the widget tests of `issues/03` could not reach, and that a real phone
/// found broken on 2026-09-11: the index has to redraw when a **machine** changes its mind,
/// not only when the fleet does.
///
/// `hostCaps` arrive on `hello`, seconds after this route is first built. Everything else
/// reactive on this screen hangs off `FleetStore`; capabilities do not, and nothing was
/// listening. The door never appeared against a host that was advertising it.
void main() {
  late FakeTransport sockets;
  late FakeHttpTransport http;
  late Credentials credentials;
  late HostRegistry registry;
  late FleetStore fleet;

  setUp(() {
    sockets = FakeTransport();
    http = FakeHttpTransport();
    credentials = Credentials(
      store: InMemorySecureStore(),
      now: DateTime.now,
      gate: BiometricGate(FakeBiometrics()),
    );
    registry = HostRegistry(
      transport: sockets,
      httpTransport: http,
      tokenReader: credentials.tokenFor,
      sleep: (_) async {},
    );
    fleet = FleetStore(registry.events);
  });

  tearDown(() {
    fleet.dispose();
    registry.dispose();
  });

  Widget route() => MaterialApp(
        theme: buildAppTheme(),
        home: ProjectsRoute(
          registry: registry,
          fleet: fleet,
          hostLabel: (_) => '',
          onOpenProject: (_) {},
          onOpenAgent: (_) {},
          onOpenDiagnostics: () {},
          onRefresh: () async {},
          onAddProject: (_) {},
        ),
      );

  testWidgets('the door appears when the machine says so, not only when the route is built',
      (tester) async {
    registry.add(pairedVps(const ['fleet', 'stream']));
    registry.connect(vps);
    await tester.pumpWidget(route());
    await tester.pumpAndSettle();

    expect(find.text('Add project'), findsNothing,
        reason: 'this host has not offered anything yet');

    // What a host sends the instant its socket attaches — the only signal the phone gets
    // that says "your picture of this machine may be out of date".
    sockets.channels.single.emit(helloWith(const ['fleet', 'stream', 'projects-create']));
    await tester.pumpAndSettle();

    expect(find.text('Add project'), findsOneWidget);
  });

  testWidgets('and it goes away again when a machine stops offering it', (tester) async {
    registry.add(pairedVps(const ['fleet', 'projects-create']));
    registry.connect(vps);
    await tester.pumpWidget(route());
    await tester.pumpAndSettle();

    expect(find.text('Add project'), findsOneWidget);

    // A host rolled back to an older binary. The door must not linger.
    sockets.channels.single.emit(helloWith(const ['fleet']));
    await tester.pumpAndSettle();

    expect(find.text('Add project'), findsNothing);
  });
}
