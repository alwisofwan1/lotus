import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/composition_root.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/app/pocket_app.dart';
import 'package:lotus_pocket/models/app_build.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';

import '../support/fake_security.dart';
import '../support/fake_transport.dart';

/// The wiring test, and the reason it is worth its weight.
///
/// `CredentialKeeper` can be perfect and change nothing: before this, the renewal it
/// performs already existed inside `Credentials` and was simply never reached on an app
/// open. A unit test of the keeper would have passed against that world too. What was
/// missing was the **call**, so that is what this asserts — through the real app widget
/// and the real composition root.
const HostId mac = HostId('mac');

/// Answers by route, because an app open now fires **two** request streams at once —
/// the renewal this test is about and `FleetRepository.hydrate`. A queue-based fake
/// hands whichever arrives first the reply meant for the other, and the test then passes
/// or fails on scheduling rather than on behaviour.
class RefreshAwareTransport implements HttpTransport {
  final List<Uri> sent = [];
  String? nextToken;
  DateTime? nextExpiry;

  @override
  Future<HttpReply> send({
    required String method,
    required Uri uri,
    Map<String, String> headers = const {},
    String? body,
  }) async {
    sent.add(uri);
    if (uri.path.endsWith('/m/devices/refresh')) {
      final token = nextToken;
      if (token == null) return const HttpReply(status: 401, body: '{}');
      return HttpReply(
        status: 200,
        body: jsonEncode({
          'deviceToken': token,
          'expiresAt': (nextExpiry ?? DateTime.utc(2030)).millisecondsSinceEpoch,
        }),
      );
    }
    // Everything else is the fleet catching up; this test does not care what it says.
    return const HttpReply(status: 503, body: '{}');
  }

  bool get askedForRenewal => sent.any((u) => u.path.endsWith('/m/devices/refresh'));
}

DateTime now = DateTime.utc(2026, 9, 17, 12);

PairedDevice device({required Duration remaining}) => PairedDevice(
      deviceToken: 'tok-old',
      deviceId: 'dev_a',
      expiresAt: now.add(remaining),
      hardExpiresAt: now.add(const Duration(days: 20)),
      hostId: mac,
      hostLabel: 'VPS',
      mode: 'standalone',
      caps: const HostCaps(protocol: 1, features: ['fleet', 'dispatch']),
      baseUri: Uri.parse('http://mac:9877'),
    );

void main() {
  late InMemorySecureStore store;
  late RefreshAwareTransport http;

  setUp(() {
    store = InMemorySecureStore();
    http = RefreshAwareTransport();
  });

  Future<CompositionRoot> bootWith(PairedDevice paired) async {
    await store.write('host:${paired.hostId.value}', jsonEncode(paired.toJson()));
    return CompositionRoot.boot(
      secureStore: store,
      biometrics: FakeBiometrics(),
      httpTransport: http,
      transport: FakeTransport(),
      // The platform's version lookup never answers under `testWidgets`' fake clock.
      build: const AppBuild(version: '1.0.0', buildNumber: 1),
      now: () => now,
    );
  }

  /// A cold start is an app open, and `resumed` is never delivered for one — so the
  /// post-frame callback is the only thing that covers the case an operator actually
  /// hits after a weekend away.
  testWidgets('a cold start renews a credential that is inside its lead', (tester) async {
    final root = await bootWith(device(remaining: const Duration(hours: 6)));
    http.nextToken = 'tok-new';
    http.nextExpiry = now.add(const Duration(hours: 72));

    await tester.pumpWidget(PocketApp(root: root));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(
      http.askedForRenewal,
      isTrue,
      reason: 'opening the app is what the 2026-08-05 addendum promised would renew',
    );
    expect(root.credentials.deviceFor(mac)?.deviceToken, 'tok-new');
  });

  /// The other half: an open must not cost a request when nothing is close to lapsing.
  testWidgets('a cold start with a fresh credential asks the host nothing', (tester) async {
    final root = await bootWith(device(remaining: const Duration(hours: 70)));

    await tester.pumpWidget(PocketApp(root: root));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(http.askedForRenewal, isFalse);
  });

  /// Coming back from the pocket is the common case, and the one the addendum's
  /// "~48 jam" figure is actually about.
  testWidgets('a resume renews too', (tester) async {
    final root = await bootWith(device(remaining: const Duration(hours: 70)));
    await tester.pumpWidget(PocketApp(root: root));
    await tester.pump();

    // Two days pass with the app in the background.
    now = now.add(const Duration(hours: 50));
    http.nextToken = 'tok-after-resume';
    http.nextExpiry = now.add(const Duration(hours: 72));

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(root.credentials.deviceFor(mac)?.deviceToken, 'tok-after-resume');
  });
}
