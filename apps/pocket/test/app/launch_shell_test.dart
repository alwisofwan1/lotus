import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/launch_shell.dart';
import 'package:lotus_pocket/app/splash_gate.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/data/intro_seen.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';

import '../support/fake_security.dart';

const pairing = Key('pairing');
const projects = Key('projects');

DateTime now() => DateTime(2026, 9, 8);

PairedDevice device() => PairedDevice(
      hostId: const HostId('mac'),
      hostLabel: 'MacBook',
      baseUri: Uri.parse('http://mac.local:8787'),
      deviceToken: 'tok',
      deviceId: 'dev',
      expiresAt: now().add(const Duration(hours: 48)),
      hardExpiresAt: now().add(const Duration(days: 20)),
      mode: 'client',
      caps: const HostCaps(protocol: 1, features: ['fleet']),
    );

void main() {
  late InMemorySecureStore store;
  late Credentials credentials;
  late IntroSeen introSeen;

  setUp(() async {
    store = InMemorySecureStore();
    credentials = Credentials(
      store: store,
      now: now,
      gate: BiometricGate(FakeBiometrics(), now: now),
    );
    introSeen = IntroSeen(store);
  });

  /// Pumps the shell and lets the splash finish, the way a launch does.
  Future<void> launch(WidgetTester tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: LaunchShell(
        credentials: credentials,
        introSeen: introSeen,
        pairing: (_) => const Scaffold(key: pairing),
        projects: (_) => const Scaffold(key: projects),
      ),
    ));
    await tester.pump(SplashGate.defaultHold);
    await tester.pumpAndSettle();
  }

  testWidgets('a launch shows the splash before anything else', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: LaunchShell(
        credentials: credentials,
        introSeen: introSeen,
        pairing: (_) => const Scaffold(key: pairing),
        projects: (_) => const Scaffold(key: projects),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('LOTUS'), findsOneWidget);
    expect(find.text('no machine paired'), findsOneWidget);
    expect(find.byKey(pairing), findsNothing);
  });

  testWidgets('a first run lands on the intro, and finishing it reaches the form',
      (tester) async {
    await launch(tester);
    expect(find.textContaining('remote control'), findsOneWidget);

    await tester.tap(find.text('Skip'));
    await tester.pumpAndSettle();

    expect(find.byKey(pairing), findsOneWidget);
    // Written when the intro ended, not when a pairing later succeeded — so a form
    // abandoned here does not bring the panes back.
    expect(store.entries[IntroSeen.key], isNotNull);
  });

  testWidgets('a phone with a machine never sees the intro', (tester) async {
    await credentials.remember(device());
    await credentials.load();
    // Deliberately left unseen: the stored bit did not exist when this operator
    // paired, and it must not put an introduction in front of a working setup.
    await introSeen.load();

    await launch(tester);

    expect(find.byKey(projects), findsOneWidget);
    expect(find.textContaining('remote control'), findsNothing);
  });

  testWidgets('pairing swaps the form for the index without a second launch',
      (tester) async {
    await introSeen.markSeen();
    await launch(tester);
    expect(find.byKey(pairing), findsOneWidget);

    // What `PairingRepository` does on success. The shell listens, so this is the
    // same rebuild that stored the token.
    await credentials.remember(device());
    await tester.pumpAndSettle();

    expect(find.byKey(projects), findsOneWidget);
  });

  testWidgets('the line counts the machines it is about to dial', (tester) async {
    await credentials.remember(device());
    await credentials.load();

    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: LaunchShell(
        credentials: credentials,
        introSeen: introSeen,
        pairing: (_) => const Scaffold(key: pairing),
        projects: (_) => const Scaffold(key: projects),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('1 machine · dialing'), findsOneWidget);
  });
}
