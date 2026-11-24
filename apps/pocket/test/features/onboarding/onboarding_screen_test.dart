import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/data/snippets.dart';
import 'package:lotus_pocket/data/pairing_repository.dart';
import 'package:lotus_pocket/features/onboarding/onboarding_screen.dart';
import 'package:lotus_pocket/features/shared/back_glyph.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';

import '../../support/fake_security.dart';
import '../../support/fake_transport.dart';

String get pairReply => jsonEncode({
      'deviceToken': 'tok_live',
      'deviceId': 'dev_abc',
      'expiresAt': DateTime(2026, 8, 9).millisecondsSinceEpoch,
      'hardExpiresAt': DateTime(2026, 9, 5).millisecondsSinceEpoch,
      'hostId': 'mac',
      'hostLabel': 'MacBook',
      'mode': 'client',
      'hostCaps': {
        'protocol': 1,
        'features': ['fleet', 'dispatch', 'stop', 'stream'],
      },
    });

/// An HTTP seam that answers only when the test says so.
///
/// Needed for one behaviour that cannot be seen otherwise: what a second tap does
/// while the first request is still in the air. A pairing code is single-use and the
/// host drops every pending code after five failed attempts, so a double tap is not a
/// cosmetic problem.
class PendingHttpTransport implements HttpTransport {
  final List<Uri> sent = [];
  final List<Completer<HttpReply>> _pending = [];

  int get inFlight => _pending.length;

  void answer(String body, {int status = 200}) =>
      _pending.removeAt(0).complete(HttpReply(status: status, body: body));

  @override
  Future<HttpReply> send({
    required String method,
    required Uri uri,
    Map<String, String> headers = const {},
    String? body,
  }) {
    sent.add(uri);
    final completer = Completer<HttpReply>();
    _pending.add(completer);
    return completer.future;
  }
}

void main() {
  late InMemorySecureStore store;
  late Credentials credentials;
  late HostRegistry registry;
  int paired = 0;

  Credentials buildCredentials() => Credentials(
        store: store,
        now: () => DateTime(2026, 8, 6),
        gate: BiometricGate(FakeBiometrics()),
      );

  setUp(() {
    paired = 0;
    store = InMemorySecureStore();
    credentials = buildCredentials();
  });

  tearDown(() {
    registry.dispose();
    credentials.dispose();
  });

  /// A repository wired to the same fakes `show` uses, for the tests that care about
  /// the screen's shape rather than about a pairing round trip.
  PairingRepository repository() {
    registry = HostRegistry(
      transport: FakeTransport(),
      httpTransport: PendingHttpTransport(),
      tokenReader: credentials.tokenFor,
      sleep: (_) async {},
    );
    return PairingRepository(
      credentials: credentials,
      registry: registry,
      transport: PendingHttpTransport(),
      fleet: FleetStore(registry.events),
      snippets: Snippets(store),
    );
  }

  Future<void> show(WidgetTester tester, HttpTransport http) {
    registry = HostRegistry(
      transport: FakeTransport(),
      httpTransport: http,
      tokenReader: credentials.tokenFor,
      sleep: (_) async {},
    );
    return tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: OnboardingScreen(
        pairing: PairingRepository(
          credentials: credentials,
          registry: registry,
          transport: http,
          fleet: FleetStore(registry.events),
          snippets: Snippets(store),
        ),
        onPaired: () => paired += 1,
      ),
    ));
  }

  Future<void> fillIn(
    WidgetTester tester, {
    String address = '100.64.0.3:8787',
    String code = '12345678',
    String name = 'Pixel 8',
  }) async {
    await tester.enterText(find.byType(TextField).at(0), address);
    await tester.enterText(find.byType(TextField).at(1), code);
    await tester.enterText(find.byType(TextField).at(2), name);
  }

  Future<void> tapPair(WidgetTester tester) async {
    await tester.tap(find.text('Pair'));
    await tester.pumpAndSettle();
  }

  /// Answers the naming sheet the way an operator in a hurry does.
  ///
  /// It only appears on a **successful** pairing, so this is a no-op on every failure
  /// test — which is the point: a sheet that appeared after a refused code would be
  /// asking the operator to name a machine they are not paired with.
  Future<void> skipNaming(WidgetTester tester) async {
    final skip = find.text('Use its own name');
    if (skip.evaluate().isEmpty) return;
    await tester.tap(skip);
    await tester.pumpAndSettle();
  }

  testWidgets('names where the code comes from on the other machine', (tester) async {
    await show(tester, FakeHttpTransport());

    // The operator is holding two devices; "check your settings" would make them hunt
    // on the one they cannot see from here.
    expect(
      find.textContaining('Settings → Mobile access → Pair a phone'),
      findsOne,
    );
  });

  testWidgets('the code field takes digits only', (tester) async {
    await show(tester, FakeHttpTransport());

    // The desktop prints `1234 5678`, so typing it back with the space is the faithful
    // reading — and the host wants eight bare digits.
    await tester.enterText(find.byType(TextField).at(1), '1234 5678');
    await tester.pump();

    expect(find.text('12345678'), findsOne);
  });

  testWidgets('a good code pairs and reports it once', (tester) async {
    final http = FakeHttpTransport()..enqueue(pairReply);
    await show(tester, http);

    await fillIn(tester);
    await tapPair(tester);
    await skipNaming(tester);

    expect(http.last.uri, Uri.parse('http://100.64.0.3:8787/m/pair'));
    expect(http.last.json['deviceName'], 'Pixel 8');
    expect(paired, 1);
  });

  testWidgets('a refused code stays on this screen and says what to do',
      (tester) async {
    final http = FakeHttpTransport()..enqueue('{"error":"expired"}', status: 401);
    await show(tester, http);

    await fillIn(tester);
    await tapPair(tester);

    expect(paired, 0);
    expect(find.text('That code did not work.'), findsOne);
    expect(find.textContaining('five minutes'), findsOne);
  });

  testWidgets('a sleeping machine is diagnosed as asleep, not as a bad code',
      (tester) async {
    final http = FakeHttpTransport()
      ..failWith = const TransportUnavailable('…', cause: TransportCause.timedOut);
    await show(tester, http);

    await fillIn(tester);
    await tapPair(tester);

    expect(find.text('That machine did not answer.'), findsOne);
  });

  testWidgets('a typo is caught before anything is sent', (tester) async {
    final http = FakeHttpTransport();
    await show(tester, http);

    await fillIn(tester, address: 'not an address');
    await tapPair(tester);

    expect(http.sent, isEmpty);
    expect(find.textContaining('spaces'), findsOne);
  });

  testWidgets('a second tap cannot spend the code twice', (tester) async {
    final http = PendingHttpTransport();
    await show(tester, http);
    await fillIn(tester);

    await tester.tap(find.text('Pair'));
    await tester.pump();
    // The button now reads its own state, so there is no invisible in-flight request.
    expect(find.text('Pairing…'), findsOne);

    await tester.tap(find.text('Pairing…'));
    await tester.pump();

    // A code is single-use, and five failed attempts drop every pending code on the
    // host — so a doubled request is not cosmetic.
    expect(http.inFlight, 1);
    expect(http.sent, hasLength(1));

    http.answer(pairReply);
    await tester.pumpAndSettle();
    await skipNaming(tester);
    expect(paired, 1);
  });

  testWidgets('a failed attempt leaves what was typed alone', (tester) async {
    final http = FakeHttpTransport()..enqueue('{"error":"expired"}', status: 401);
    await show(tester, http);

    await fillIn(tester);
    await tapPair(tester);

    // Read off the controllers, not off the rendered text: the address hint happens to
    // be the same string, so a text finder would pass on an empty field.
    String valueAt(int i) =>
        tester.widget<TextField>(find.byType(TextField).at(i)).controller!.text;

    // Only the code needs replacing, and clearing the address would make a five-minute
    // window shorter for no reason.
    expect(valueAt(0), '100.64.0.3:8787');
    expect(valueAt(1), '12345678');
    expect(valueAt(2), 'Pixel 8');
  });

  group('the code cells on this screen', () {
    FocusNode? focusOf(WidgetTester tester, int i) =>
        tester.widget<TextField>(find.byType(TextField).at(i)).focusNode;

    int redCells(WidgetTester tester) {
      final error = tester.element(find.byType(TextField).at(1)).tokens.error;
      return tester
          .widgetList<AnimatedContainer>(find.byType(AnimatedContainer))
          .where((c) => (c.decoration as BoxDecoration?)?.border == Border.all(color: error))
          .length;
    }

    // C1: never a submit on the eighth digit — "This phone" is below the code and
    // names this device in the desktop's revoke list.
    testWidgets('a complete code hands the keyboard to the empty address', (tester) async {
      final http = FakeHttpTransport();
      await show(tester, http);

      await tester.enterText(find.byType(TextField).at(1), '12345678');
      await tester.pumpAndSettle();

      expect(focusOf(tester, 0)!.hasFocus, isTrue);
      expect(http.sent, isEmpty);
    });

    testWidgets('…and to the name once the address is there, still without sending',
        (tester) async {
      final http = FakeHttpTransport();
      await show(tester, http);

      await tester.enterText(find.byType(TextField).at(0), '100.64.0.3:8787');
      await tester.enterText(find.byType(TextField).at(1), '12345678');
      await tester.pumpAndSettle();

      expect(focusOf(tester, 2)!.hasFocus, isTrue);
      expect(http.sent, isEmpty);
    });

    testWidgets('only a refused code turns red', (tester) async {
      final http = FakeHttpTransport()..enqueue('{"error":"expired"}', status: 401);
      await show(tester, http);
      await fillIn(tester);
      await tapPair(tester);

      expect(redCells(tester), 8);
    });

    testWidgets('a throttled host leaves the code looking good — it may be',
        (tester) async {
      final http = FakeHttpTransport()
        ..enqueue('{"error":"Too many pairing attempts"}', status: 429);
      await show(tester, http);
      await fillIn(tester);
      await tapPair(tester);

      expect(find.textContaining('turning attempts away'), findsOne);
      expect(redCells(tester), 0);
    });

    testWidgets('a retry clears the red while it is in flight', (tester) async {
      final http = PendingHttpTransport();
      await show(tester, http);
      await fillIn(tester);
      await tester.tap(find.text('Pair'));
      await tester.pump();
      http.answer('{"error":"expired"}', status: 401);
      await tester.pumpAndSettle();
      expect(redCells(tester), 8);

      await tester.tap(find.text('Pair'));
      await tester.pump();

      // Nothing has been refused this time, yet — and a second refusal is a rise again,
      // so it shakes again.
      expect(find.text('Pairing…'), findsOne);
      expect(redCells(tester), 0);
      http.answer('{"error":"expired"}', status: 401);
      await tester.pumpAndSettle();
      expect(redCells(tester), 8);
    });
  });

  group('scanning', () {
    /// A camera that reads exactly one thing, when the test presses it.
    ///
    /// The whole reason `QrScanner` is a seam: without it this flow could only be
    /// exercised on a device with a lens pointed at a real monitor, which is to say
    /// never in a suite.
    Widget Function(void Function(String)) scannerReading(String payload) =>
        (onPayload) => Center(
              child: TextButton(
                onPressed: () => onPayload(payload),
                child: const Text('read a code'),
              ),
            );

    Future<void> showWithScanner(
      WidgetTester tester,
      HttpTransport http,
      String payload,
    ) {
      registry = HostRegistry(
        transport: FakeTransport(),
        httpTransport: http,
        tokenReader: credentials.tokenFor,
        sleep: (_) async {},
      );
      return tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: OnboardingScreen(
          pairing: PairingRepository(
            credentials: credentials,
            registry: registry,
            transport: http,
            fleet: FleetStore(registry.events),
            snippets: Snippets(store),
          ),
          scanner: scannerReading(payload),
          onPaired: () => paired += 1,
        ),
      ));
    }

    Future<void> scan(WidgetTester tester) async {
      await tester.tap(find.text('Scan the QR'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('read a code'));
      await tester.pumpAndSettle();
      await skipNaming(tester);
    }

    String valueAt(WidgetTester tester, int i) =>
        tester.widget<TextField>(find.byType(TextField).at(i)).controller!.text;

    testWidgets('a scan pairs without anything being typed', (tester) async {
      final http = FakeHttpTransport()..enqueue(pairReply);
      await showWithScanner(
        tester,
        http,
        'lotus-pair://invite?v=1&address=192.168.1.11%3A8787&code=75447516',
      );

      await scan(tester);

      expect(paired, 1);
      // The address the QR carried is the address that was dialled — the property the
      // contract fixture exists to keep true from the other end.
      expect(http.last.uri.toString(), startsWith('http://192.168.1.11:8787/'));
    });

    testWidgets('what was scanned stays on screen afterwards', (tester) async {
      final http = FakeHttpTransport()..enqueue(pairReply);
      await showWithScanner(
        tester,
        http,
        'lotus-pair://invite?v=1&address=192.168.1.11%3A8787&code=75447516',
      );

      await scan(tester);

      // A QR is opaque. Writing it into the fields is what turns "it failed" into "it
      // failed with *this* address" — and lets a wrong one be corrected by editing a
      // character instead of by scanning again.
      expect(valueAt(tester, 0), '192.168.1.11:8787');
      expect(valueAt(tester, 1), '75447516');
    });

    testWidgets('a barcode that is not ours is refused without a request', (tester) async {
      final http = FakeHttpTransport();
      await showWithScanner(tester, http, 'WIFI:S:cafe;T:WPA;P:hunter2;;');

      await scan(tester);

      expect(find.textContaining('not a Lotus pairing code'), findsOne);
      // Nothing was dialled: the refusal happens on the phone, before anything leaves.
      expect(http.sent, isEmpty);
      expect(paired, 0);
    });

    testWidgets('backing out of the camera is not a failure', (tester) async {
      final http = FakeHttpTransport();
      await showWithScanner(tester, http, 'lotus-pair://invite?v=1&address=a%3A1&code=2');

      await tester.tap(find.text('Scan the QR'));
      await tester.pumpAndSettle();
      await tester.pageBack();
      await tester.pumpAndSettle();

      // A diagnosis here would describe a failure that did not happen, on the one
      // screen whose entire job is naming causes accurately.
      expect(find.textContaining('not a Lotus'), findsNothing);
      expect(find.textContaining('incomplete'), findsNothing);
      expect(http.sent, isEmpty);
    });

    testWidgets('the typed fields survive alongside the scanner', (tester) async {
      // Not decoration: a Standalone Host has no screen to show a QR on, and a refused
      // camera permission would otherwise leave a phone that can never be paired.
      final http = FakeHttpTransport()..enqueue(pairReply);
      await showWithScanner(tester, http, 'lotus-pair://invite?v=1&address=a%3A1&code=2');

      await tester.enterText(find.byType(TextField).at(0), '100.64.0.3:8787');
      await tester.enterText(find.byType(TextField).at(1), '12345678');
      await tapPair(tester);
      await skipNaming(tester);

      expect(paired, 1);
      expect(http.last.uri.toString(), startsWith('http://100.64.0.3:8787/'));
    });

    testWidgets('without a scanner there is no button to press', (tester) async {
      await show(tester, FakeHttpTransport());

      expect(find.text('Scan the QR'), findsNothing);
      expect(find.text('or type it'), findsNothing);
    });
  });

  group('naming the machine that just paired', () {
    testWidgets('asks after the pairing, pre-filled with a guess', (tester) async {
      final http = FakeHttpTransport()..enqueue(pairReply);
      await show(tester, http);

      await fillIn(tester);
      await tapPair(tester);

      // The hostname in `pairReply` is what the guess is derived from — first segment,
      // `.local` gone. Asking before the pairing would be asking about a machine that
      // does not exist yet.
      expect(find.text('What do you call this machine?'), findsOne);
      expect(
        tester.widget<TextField>(find.byType(TextField).last).controller!.text,
        isNotEmpty,
      );
    });

    testWidgets('the name is stored against that host', (tester) async {
      final http = FakeHttpTransport()..enqueue(pairReply);
      await show(tester, http);

      await fillIn(tester);
      await tapPair(tester);
      await tester.enterText(find.byType(TextField).last, 'studio');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(credentials.devices.single.nickname, 'studio');
      // And the screen still hands over exactly once — naming defers that, never
      // duplicates it.
      expect(paired, 1);
    });

    testWidgets('skipping leaves the machine with its own name', (tester) async {
      final http = FakeHttpTransport()..enqueue(pairReply);
      await show(tester, http);

      await fillIn(tester);
      await tapPair(tester);
      await skipNaming(tester);

      expect(credentials.devices.single.nickname, isNull);
      expect(paired, 1);
    });

    testWidgets('a refused code is never asked to be named', (tester) async {
      final http = FakeHttpTransport()..enqueue('{"error":"expired"}', status: 401);
      await show(tester, http);

      await fillIn(tester);
      await tapPair(tester);

      // There is no machine to name — the sheet here would be asking about a pairing
      // that did not happen.
      expect(find.text('What do you call this machine?'), findsNothing);
    });
  });

  group('reached as a second machine rather than as the first screen', () {
    /// This screen was written as the app's root, so it had no way back — correct
    /// while it was the only thing a phone with no credential could show. Diagnostics
    /// now pushes it to add a machine alongside the ones already paired, and a pushed
    /// route with no way out is a trap: the operator came to *add* something, and
    /// changing their mind must not cost them the screen they came from.
    testWidgets('draws a way back, and leaving is not a failed pairing', (tester) async {
      var backs = 0;
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: OnboardingScreen(
          pairing: repository(),
          onPaired: () {},
          onBack: () => backs += 1,
        ),
      ));

      await tester.tap(find.byType(BackGlyph));
      await tester.pump();

      expect(backs, 1);
    });

    testWidgets('as the first screen there is nothing to go back to', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: OnboardingScreen(pairing: repository(), onPaired: () {}),
      ));

      // Absent rather than disabled: a control that cannot do anything is worse than
      // no control, and on a phone with no machine paired there is no route beneath
      // this one.
      expect(find.byType(BackGlyph), findsNothing);
    });

    testWidgets('the title says which of the two situations this is', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: OnboardingScreen(
          pairing: repository(),
          onPaired: () {},
          onBack: () {},
        ),
      ));

      // "Pair this phone" is the first-run sentence and it is wrong here: the phone is
      // already paired with something. What is being added is a machine.
      expect(find.text('Pair another machine'), findsOneWidget);
      expect(find.text('Pair this phone'), findsNothing);
    });

    /// Re-pairing a machine whose credential died: the address never changed, so only
    /// the code is asked for — and the title says it is the same machine, not a new one.
    testWidgets('re-pairing starts from the address the machine already had',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: OnboardingScreen(
          pairing: repository(),
          onPaired: () {},
          onBack: () {},
          initialAddress: 'http://100.64.0.10:8787',
        ),
      ));

      expect(find.text('Pair this machine again'), findsOneWidget);
      expect(find.text('http://100.64.0.10:8787'), findsOneWidget);
    });
  });
}
