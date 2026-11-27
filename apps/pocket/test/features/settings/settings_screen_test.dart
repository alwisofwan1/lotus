import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/models/app_build.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/palettes/classic.dart';
import 'package:lotus_pocket/app/theme/theme.dart';
import 'package:lotus_pocket/app/theme/theme_variant.dart';
import 'package:lotus_pocket/core/push_tokens.dart';
import 'package:lotus_pocket/data/diagnostics.dart';
import 'package:lotus_pocket/data/measurement_log.dart';
import 'package:lotus_pocket/data/readdress_outcome.dart';
import 'package:lotus_pocket/data/push_repository.dart';
import 'package:lotus_pocket/features/settings/settings_screen.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/hosts/paired_host.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../../support/fake_security.dart';
import '../../support/fake_transport.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

/// A phone that holds one token, for the one test that needs the real push path.
class FixedPushTokens implements PushTokens {
  const FixedPushTokens(this.token);

  final String token;

  @override
  Future<bool> get available async => true;

  @override
  Future<String?> requestToken() async => token;

  @override
  Stream<String> get refreshed => const Stream<String>.empty();
}

HostDiagnosis host({
  HostId id = mac,
  String label = 'MacBook',
  String? nickname,
  String mode = 'client',
  bool connected = true,
  String reach = 'connected',
  List<String> features = const ['fleet', 'dispatch', 'transcript', 'permission'],
  CredentialRunway? credential = const CredentialRunway(
    tokenLeft: Duration(hours: 60),
    ceilingLeft: Duration(days: 28),
    refreshDue: false,
  ),
  PushState push = PushState.tokenSent,
}) =>
    HostDiagnosis(
      host: id,
      label: label,
      nickname: nickname,
      origin: 'http://${id.value}:8787',
      mode: mode,
      connected: connected,
      reach: reach,
      features: features,
      credential: credential,
      push: push,
    );

void main() {
  late List<HostId> unpaired;

  /// Every (host, name) the screen asked to store. Null is the operator clearing it.
  late List<(HostId, String?)> renamed;

  /// Every (host, address) the screen asked to move, and what it is told back.
  late List<(HostId, String)> moved;
  late ReaddressOutcome readdressAnswer;

  /// How many times the screen asked to open the pairing flow.
  late int pairRequests;

  /// Every address the screen asked to re-pair at.
  late List<String> repairs;

  setUp(() {
    unpaired = [];
    renamed = [];
    moved = [];
    pairRequests = 0;
    repairs = [];
    readdressAnswer = const ReaddressDone();
  });

  Future<void> show(
    WidgetTester tester, {
    List<HostDiagnosis> hosts = const [],
    List<String> unreadable = const [],
    MeasurementLog? measurements,
    ValueNotifier<ThemeData>? theme,
  }) =>
      tester.pumpWidget(ValueListenableBuilder<ThemeData>(
        valueListenable: theme ?? ValueNotifier(buildAppTheme()),
        builder: (_, data, _) => MaterialApp(
          theme: data,
          home: SettingsScreen(
            read: () => Diagnostics(hosts: hosts, unreadableEntries: unreadable),
            revision: ChangeNotifier(),
            onUnpair: (id) async => unpaired.add(id),
            onReaddress: (id, address) async {
              moved.add((id, address));
              return readdressAnswer;
            },
            onRename: (id, name) async => renamed.add((id, name)),
            onPairAnother: () => pairRequests += 1,
            onPairAgain: repairs.add,
            onRefresh: () async {},
            measurements: measurements ?? MeasurementLog(),
            running: const AppBuild(version: '1.0.0', buildNumber: 29850748),
          ),
        ),
      ));

  testWidgets('names the host, its mode and the full origin', (tester) async {
    await show(tester, hosts: [host()]);

    expect(find.text('MacBook'), findsOneWidget);
    expect(find.text('client'), findsOneWidget);
    // The scheme is on screen, not trimmed away: `ws` against `wss` is decided by it,
    // and a host that paired over the wrong one streams nothing.
    expect(find.text('http://mac:8787'), findsOneWidget);
  });

  testWidgets('lists what the host advertised, which is the only place that is readable',
      (tester) async {
    await show(tester, hosts: [host(features: ['fleet', 'dispatch', 'stream'])]);

    // Everywhere else the app *hides* what a host does not advertise, so a missing Chat
    // and a broken Chat look identical. This row is the difference.
    expect(find.text('fleet · dispatch · stream'), findsOneWidget);
  });

  testWidgets('a host that advertises nothing says so rather than showing a blank',
      (tester) async {
    await show(tester, hosts: [host(features: [])]);

    expect(find.text('none advertised'), findsOneWidget);
  });

  group('reach', () {
    testWidgets('a failure keeps its stable slug, which is what a bug report can carry',
        (tester) async {
      await show(tester, hosts: [host(connected: false, reach: 'host_asleep')]);

      expect(find.text('host_asleep'), findsOneWidget);
    });
  });

  group('credential', () {
    testWidgets('shows both clocks, because neither is meaningful alone', (tester) async {
      await show(tester, hosts: [host()]);

      expect(find.text('60h left · ceiling 28d'), findsOneWidget);
    });

    testWidgets('warns before the biometric prompt appears, not after', (tester) async {
      await show(
        tester,
        hosts: [
          host(
            credential: const CredentialRunway(
              tokenLeft: Duration(hours: 20),
              ceilingLeft: Duration(days: 12),
              refreshDue: true,
            ),
          )
        ],
      );

      // An unexplained biometric prompt on the next foreground reads as something being
      // broken. Announced, it reads as the app doing its job.
      expect(find.text('renews on next unlock · ceiling 12d'), findsOneWidget);
    });

    testWidgets('expired and past-ceiling are different sentences', (tester) async {
      await show(tester, hosts: [
        host(
          credential: const CredentialRunway(
            tokenLeft: Duration(hours: -2),
            ceilingLeft: Duration(days: 4),
            refreshDue: true,
          ),
        ),
        host(
          id: vps,
          label: 'VPS',
          credential: const CredentialRunway(
            tokenLeft: Duration(hours: 5),
            ceilingLeft: Duration(days: -1),
            refreshDue: true,
          ),
        ),
      ]);

      expect(find.text('expired — pair again'), findsOneWidget);
      expect(find.text('past the 30-day ceiling — pair again'), findsOneWidget);
    });

    testWidgets('a dead credential offers to pair again at the address it had',
        (tester) async {
      await show(tester, hosts: [
        host(
          id: vps,
          credential: const CredentialRunway(
            tokenLeft: Duration(hours: -2),
            ceilingLeft: Duration(days: 4),
            refreshDue: true,
          ),
        ),
      ]);

      await tester.tap(find.text('Pair again'));

      expect(repairs, ['http://vps:8787']);
    });

    testWidgets('a revoked credential offers it too, even with time left on the clock',
        (tester) async {
      await show(tester, hosts: [host(connected: false, reach: 'credential_revoked')]);

      expect(find.text('Pair again'), findsOneWidget);
    });

    testWidgets('a working credential does not offer it', (tester) async {
      await show(tester, hosts: [host(connected: false, reach: 'host_asleep')]);

      expect(find.text('Pair again'), findsNothing);
    });

    testWidgets('a host with no stored token is named, not drawn as zero', (tester) async {
      await show(tester, hosts: [host(credential: null)]);

      expect(find.text('missing — this host has no stored token'), findsOneWidget);
    });
  });

  group('push', () {
    testWidgets('names which half is missing, since the two need opposite fixes',
        (tester) async {
      await show(tester, hosts: [
        host(push: PushState.hostCannotSend),
        host(id: vps, label: 'VPS', push: PushState.phoneHasNoToken),
      ]);

      expect(find.text('this host cannot send — no service account on it'), findsOneWidget);
      expect(find.text('no token on this phone'), findsOneWidget);
    });

    testWidgets('the registration token is never on screen', (tester) async {
      // Built through the **real** `Diagnostics.of` over a real `PushRepository` holding a
      // real-shaped token, because a hand-made `HostDiagnosis` could not leak one even if
      // the type carried it — that version of this test would pass by construction.
      //
      // What it guards: the token is the capability to ring this phone. The host keeps it
      // out of its own audit log for that reason (`device-routes.ts`), and this asserts
      // the phone's only diagnostic surface holds the same line.
      const token = 'fZ1kQx8mTgyQ:APA91bH-a-registration-token-shaped-string';

      final registry = HostRegistry(
        transport: FakeTransport(),
        httpTransport: FakeHttpTransport(),
        tokenReader: (h) => 'bearer',
        sleep: (_) async {},
      );
      addTearDown(registry.dispose);
      registry.add(PairedHost(
        id: mac,
        label: 'MacBook',
        baseUri: Uri.parse('http://mac:8787'),
        mode: 'client',
        caps: const HostCaps(protocol: 1, features: ['fleet', 'push']),
      ));

      final push = PushRepository(tokens: FixedPushTokens(token), registry: registry);
      await push.start();
      expect(push.currentToken, token, reason: 'the token must really be held');

      final credentials = Credentials(
        store: InMemorySecureStore(),
        now: DateTime.now,
        gate: BiometricGate(FakeBiometrics()),
      );

      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: SettingsScreen(
          read: () => Diagnostics.of(
            registry: registry,
            credentials: credentials,
            push: push,
            now: DateTime.now(),
          ),
          revision: ChangeNotifier(),
          onPairAnother: () {},
          onPairAgain: (_) {},
          onUnpair: (id) async {},
          onReaddress: (id, address) async => const ReaddressDone(),
          onRename: (id, name) async {},
          onRefresh: () async {},
          measurements: MeasurementLog(),
          running: const AppBuild(version: '1.0.0', buildNumber: 29850748),
        ),
      ));

      final rendered = tester
          .widgetList<Text>(find.byType(Text))
          .map((t) => t.data ?? t.textSpan?.toPlainText() ?? '')
          .join('\n');

      expect(rendered, isNot(contains(token)));
      expect(rendered, isNot(contains('APA91')));
      // …while still reporting that one exists, which is the whole value of the row.
      expect(find.text('token sent to this host'), findsOneWidget);
    });
  });

  group('unpairing', () {
    testWidgets('the open dialog follows a theme change', (tester) async {
      final dark = classic.dark;
      final light = ThemeVariant(
        brightness: Brightness.light,
        tokens: dark.tokens.copyWith(
          colors: dark.tokens.colors.copyWith({ColorRole.ground: const Color(0xFFFFFFFF)}),
        ),
        terminal: dark.terminal,
        shape: dark.shape,
        elevation: dark.elevation,
      );
      final theme = ValueNotifier(buildAppTheme(dark));
      await show(tester, hosts: [host()], theme: theme);
      await tester.tap(find.text('Unpair'));
      await tester.pumpAndSettle();

      theme.value = buildAppTheme(light);
      await tester.pumpAndSettle();

      final fill = tester.widget<AlertDialog>(find.byType(AlertDialog)).backgroundColor;
      expect(fill, Color.alphaBlend(light.tokens.raise, light.tokens.bg));
    });

    testWidgets('asks first, and says what it does not undo', (tester) async {
      await show(tester, hosts: [host()]);

      await tester.tap(find.text('Unpair'));
      await tester.pumpAndSettle();

      expect(find.text('Unpair MacBook?'), findsOneWidget);
      // The part nobody guesses: Pocket is a remote control, and putting the remote down
      // does not stop the machine.
      expect(find.textContaining('Agents there keep running'), findsOneWidget);
      expect(unpaired, isEmpty);
    });

    testWidgets('cancelling leaves the host paired', (tester) async {
      await show(tester, hosts: [host()]);

      await tester.tap(find.text('Unpair'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(unpaired, isEmpty);
    });

    testWidgets('confirming unpairs exactly the host whose button was tapped',
        (tester) async {
      await show(tester, hosts: [host(), host(id: vps, label: 'VPS')]);

      await tester.tap(find.text('Unpair').last);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Unpair'));
      await tester.pumpAndSettle();

      expect(unpaired, [vps]);
    });
  });

  /// The cheaper of the two answers to `not connected`, and the reason it sits beside
  /// Unpair rather than under a disclosure: the host binds a literal IP, so a DHCP
  /// lease moving is enough to strand a perfectly good credential.
  group('changing the address', () {
    Future<void> openDialog(WidgetTester tester) async {
      await tester.tap(find.text('Change address'));
      await tester.pumpAndSettle();
    }

    testWidgets('offers the current origin, scheme and all', (tester) async {
      await show(tester, hosts: [host()]);

      await openDialog(tester);

      expect(find.text('Where is MacBook now?'), findsOneWidget);
      // Prefilled WITH the scheme. Trimming to `host:port` would read better and would
      // silently downgrade an https host to http through `readAddress`'s default.
      final field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller!.text, 'http://mac:8787');
      // What it does not do is the part nobody guesses.
      expect(find.textContaining('keeps its key'), findsOneWidget);
    });

    testWidgets('sends what was typed, for the host whose button was tapped',
        (tester) async {
      await show(tester, hosts: [host(), host(id: vps, label: 'VPS')]);

      await tester.tap(find.text('Change address').last);
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), '192.168.1.11:8787');
      await tester.tap(find.text('Move it'));
      await tester.pumpAndSettle();

      expect(moved, [(vps, '192.168.1.11:8787')]);
    });

    testWidgets('cancelling asks for nothing', (tester) async {
      await show(tester, hosts: [host()]);

      await openDialog(tester);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(moved, isEmpty);
    });

    testWidgets('success is silent, because the screen behind it is the report',
        (tester) async {
      await show(tester, hosts: [host()]);

      await openDialog(tester);
      await tester.tap(find.text('Move it'));
      await tester.pumpAndSettle();

      // The origin line and `reach` are already rebuilding from the registry. A
      // snackbar declaring victory would cover the evidence.
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('a typo comes back in the parser own words', (tester) async {
      readdressAnswer = const ReaddressUnreadable('An address has no spaces in it.');
      await show(tester, hosts: [host()]);

      await openDialog(tester);
      await tester.tap(find.text('Move it'));
      await tester.pumpAndSettle();

      expect(find.text('An address has no spaces in it.'), findsOneWidget);
    });

    testWidgets('a refused gate says the old address still stands', (tester) async {
      readdressAnswer = const ReaddressRefused();
      await show(tester, hosts: [host()]);

      await openDialog(tester);
      await tester.tap(find.text('Move it'));
      await tester.pumpAndSettle();

      // Not "authentication failed": what the operator needs to know is that nothing
      // changed, so the host they are looking at is in the state they left it.
      expect(find.textContaining('stays as it was'), findsOneWidget);
    });
  });

  group('unreadable storage', () {
    testWidgets('is absent on a phone that has not hit it', (tester) async {
      await show(tester, hosts: [host()]);

      expect(find.textContaining('could not be read'), findsNothing);
    });

    testWidgets('names the keys, so a rotted entry is not read as an unpaired phone',
        (tester) async {
      await show(tester, hosts: [host()], unreadable: ['host:mac', 'host:vps']);

      expect(find.text('2 stored entries could not be read'), findsOneWidget);
      expect(find.text('host:mac'), findsOneWidget);
    });

    testWidgets('counts one in the singular', (tester) async {
      await show(tester, hosts: const [], unreadable: ['host:mac']);

      expect(find.text('1 stored entry could not be read'), findsOneWidget);
    });
  });

  group('naming a machine', () {
    testWidgets('the hostname leads until the operator has said otherwise',
        (tester) async {
      await show(tester, hosts: [host(label: 'Alwis-MacBook-Air')]);

      expect(find.text('Alwis-MacBook-Air'), findsOneWidget);
    });

    testWidgets('a named machine leads with the name, and keeps its hostname below',
        (tester) async {
      await show(tester, hosts: [host(label: 'Alwis-MacBook-Air', nickname: 'mac')]);

      expect(find.text('mac'), findsOneWidget);
      // Two MacBooks on one tailnet are told apart by the hostname and nothing else,
      // so renaming must not be the same as hiding.
      expect(find.textContaining('Alwis-MacBook-Air'), findsOneWidget);
    });

    testWidgets('renaming stores the word and asks for no fingerprint', (tester) async {
      await show(tester, hosts: [host(label: 'Alwis-MacBook-Air')]);

      await tester.tap(find.text('Rename'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, 'studio');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(renamed, [(mac, 'studio')]);
    });

    testWidgets('the field opens on the name it already has', (tester) async {
      await show(tester, hosts: [host(label: 'Alwis-MacBook-Air', nickname: 'mac')]);

      await tester.tap(find.text('Rename'));
      await tester.pumpAndSettle();

      // Opening empty would make a rename feel like starting over, and opening on the
      // guess would quietly discard a name the operator chose.
      expect(
        tester.widget<TextField>(find.byType(TextField).last).controller!.text,
        'mac',
      );
    });

    testWidgets('clearing it goes back to the hostname rather than storing a blank',
        (tester) async {
      await show(tester, hosts: [host(label: 'Alwis-MacBook-Air', nickname: 'mac')]);

      await tester.tap(find.text('Rename'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, '   ');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();

      expect(renamed, [(mac, null)]);
    });

    testWidgets('dismissing changes nothing at all', (tester) async {
      await show(tester, hosts: [host()]);

      await tester.tap(find.text('Rename'));
      await tester.pumpAndSettle();
      await tester.tapAt(const Offset(10, 10)); // the barrier above the sheet
      await tester.pumpAndSettle();

      expect(renamed, isEmpty);
    });
  });

  group('the Fase 0 measurement log (issues/01)', () {
    testWidgets('an empty session says so, and offers no live copy', (tester) async {
      await show(tester, hosts: [host()]);

      expect(find.text('Nothing recorded yet this session.'), findsOneWidget);
      final button = tester.widget<InkWell>(find.widgetWithText(InkWell, 'Copy log'));
      expect(button.onTap, isNull);
    });

    testWidgets('what has been counted copies to the clipboard verbatim', (tester) async {
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(() => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));

      final measurements = MeasurementLog()
        ..record('terminal.rebuild', 4096, labels: {'paneId': 'p-1'});
      await show(tester, hosts: [host()], measurements: measurements);

      expect(find.text('1 line(s) recorded this session.'), findsOneWidget);

      await tester.tap(find.text('Copy log'));
      await tester.pumpAndSettle();

      expect(copied, measurements.copyText());
      expect(copied, contains('"metric":"terminal.rebuild"'));
    });

    testWidgets(
        'a bounded session says what it dropped, so the count is never silently short',
        (tester) async {
      final measurements = MeasurementLog(capacity: 1)
        ..record('output.evicted', 1)
        ..record('output.evicted', 2);

      await show(tester, hosts: [host()], measurements: measurements);

      expect(
        find.text('1 line(s) held, 1 older line(s) dropped to stay bounded.'),
        findsOneWidget,
      );
    });
  });

  group('adding a second machine', () {
    /// The gap this group closes. `OnboardingScreen` was built in exactly one place
    /// and reached only when `credentials.devices.isEmpty`, so the pairing surface
    /// vanished the moment one machine was paired — and the only way to reach it again
    /// was to unpair the machine you already had.
    ///
    /// ADR-3 makes multi-host a v1 requirement and the whole data layer already
    /// carries it (`Map<HostId, …>` throughout, push registered with every host, one
    /// merged fleet). This was a missing door, not a missing capability. Found by an
    /// operator with a desktop and a VPS who could only ever hold one.
    testWidgets('Diagnostics offers a way in, and it is not hidden behind unpairing',
        (tester) async {
      await show(tester, hosts: [host()]);

      expect(find.text('Pair another machine'), findsOneWidget);
    });

    testWidgets('tapping it asks to open the pairing flow, and changes nothing itself',
        (tester) async {
      await show(tester, hosts: [host()]);

      await tester.tap(find.text('Pair another machine'));
      await tester.pump();

      expect(pairRequests, 1);
      // Routing belongs to `app/`, and adding a machine must not disturb the one
      // already there — the failure this whole group exists because of.
      expect(unpaired, isEmpty);
      expect(moved, isEmpty);
    });

    testWidgets('it is offered on a phone with no machines too', (tester) async {
      // Reachable from Diagnostics even when the list is empty: unpairing the last
      // machine drops the operator here, and a dead end at that moment is the worst
      // possible time for one.
      await show(tester, hosts: []);

      expect(find.text('Pair another machine'), findsOneWidget);
    });

    testWidgets('it clears the minimum hit target', (tester) async {
      await show(tester, hosts: [host()]);

      final size = tester.getSize(
        find.ancestor(of: find.text('Pair another machine'), matching: find.byType(InkWell)).first,
      );
      expect(size.height, greaterThanOrEqualTo(kMinHitTarget));
    });
  });
}
