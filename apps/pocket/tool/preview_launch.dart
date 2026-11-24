// The launch sequence — splash, then the three intro panes — with nothing stored.
//
//   flutter run -t tool/preview_launch.dart -d chrome     # or -d <emulator>
//
// Same discipline as `preview_home.dart`: the app's own `LaunchShell`, `SplashGate`,
// `SplashScreen`, `IntroPages` and `buildAppTheme`, so what appears is what ships.
// What is invented here is **storage**, and that is the whole point of a separate
// entry point: the real launch path decides between three screens by asking the
// Keychain, and the two interesting answers ("no machine", "never seen the intro")
// are exactly the ones a paired phone cannot give.
//
// It writes nothing. `preview_home.dart` deliberately uses the real `KeychainStore`
// and has overwritten a live pairing doing it (see this package's README); this one
// keeps a `Map`, so it can be run against a phone that is genuinely paired without
// touching that pairing.
//
// Tap through to the pairing form, then hot-restart (`R`) to see the intro again —
// the bit lives in the map, and the map dies with the process.

import 'package:flutter/material.dart';
import 'package:lotus_pocket/app/launch_shell.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/core/secure_store.dart';
import 'package:lotus_pocket/data/intro_seen.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/core/biometrics.dart';

/// Storage that forgets, so a restart is a first run.
class _Ephemeral implements SecureStore {
  final Map<String, String> entries = {};

  @override
  Future<Map<String, String>> readAll() async => Map.of(entries);

  @override
  Future<void> write(String key, String value) async => entries[key] = value;

  @override
  Future<void> delete(String key) async => entries.remove(key);
}

/// A device with no lock — `BiometricGate` never reaches it on this path anyway,
/// since nothing here mutates anything.
class _NoLock implements Biometrics {
  @override
  Future<bool> get canPrompt async => false;

  @override
  Future<bool> prompt(String reason) async => true;
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final store = _Ephemeral();
  final credentials = Credentials(
    store: store,
    now: DateTime.now,
    gate: BiometricGate(_NoLock(), now: DateTime.now),
  );
  await credentials.load();
  final introSeen = IntroSeen(store);
  await introSeen.load();

  runApp(MaterialApp(
    title: 'Lotus Pocket · launch preview',
    theme: buildAppTheme(),
    debugShowCheckedModeBanner: false,
    home: LaunchShell(
      credentials: credentials,
      introSeen: introSeen,
      pairing: (_) => const _Landed('pairing form'),
      projects: (_) => const _Landed('project index'),
    ),
  ));
}

/// Stands in for the two real screens, which need a fleet and a socket. Named rather
/// than blank so a wrong turn in the routing is obvious instead of looking like a
/// screen that failed to draw.
class _Landed extends StatelessWidget {
  const _Landed(this.what);

  final String what;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Scaffold(
      backgroundColor: t.bg,
      body: Center(
        child: Text('→ $what', style: t.mono.copyWith(fontSize: 13, color: t.muted)),
      ),
    );
  }
}
