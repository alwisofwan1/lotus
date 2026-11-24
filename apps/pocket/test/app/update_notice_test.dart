import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/composition_root.dart';
import 'package:lotus_pocket/app/pocket_app.dart';
import 'package:lotus_pocket/data/build_seen.dart';
import 'package:lotus_pocket/data/intro_seen.dart';
import 'package:lotus_pocket/models/app_build.dart';

import '../support/fake_security.dart';
import '../support/fake_transport.dart';

/// Through the real app widget, like `credential_refresh_on_open_test.dart`: `BuildSeen`
/// can decide correctly and nothing reach the screen if the call is never made.
void main() {
  late InMemorySecureStore store;

  setUp(() {
    store = InMemorySecureStore();
    store.entries[IntroSeen.key] = '1';
  });

  Future<void> launch(WidgetTester tester, int buildNumber) async {
    final root = await CompositionRoot.boot(
      secureStore: store,
      biometrics: FakeBiometrics(),
      transport: FakeTransport(),
      build: AppBuild(version: '1.1.0', buildNumber: buildNumber),
    );
    await tester.pumpWidget(PocketApp(key: UniqueKey(), root: root));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }

  testWidgets('the first launch of a newer build says which build it is', (tester) async {
    store.entries[BuildSeen.key] = '100';
    await launch(tester, 200);

    expect(find.text('Updated to Lotus Pocket 1.1.0 (200)'), findsOneWidget);
  });

  testWidgets('a relaunch of the same build stays quiet', (tester) async {
    store.entries[BuildSeen.key] = '200';
    await launch(tester, 200);

    expect(find.textContaining('Updated to'), findsNothing);
  });
}
