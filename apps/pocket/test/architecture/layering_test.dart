import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// ADR-13 no. 1, as a test rather than a convention.
///
/// A convention that nobody enforces is a convention that rots. The rule that
/// matters most here is the last one: the moment a widget opens a socket itself,
/// socket lifecycle stops being owned by one place, and a reconnect bug goes from
/// "one file" to "search the whole UI".
/// `app` may reach `core` and every layer below it, and that is not a weakening of
/// the rule below it — it is what gives that rule teeth. `app/` holds the
/// **composition root**: the one place allowed to name concrete implementations
/// (`WebSocketTransport`, `KeychainStore`, `DeviceBiometrics`) and hand them down.
/// Because it exists, `features/` never has to construct anything, which is exactly
/// what makes "features never touch transport" enforceable rather than aspirational.
/// ADR-13's diagram writes `app ──► features` only; that was drawn before there was
/// a graph to wire, and wiring it somewhere lower would put Flutter startup concerns
/// inside `data/` or `hosts/`.
const Map<String, Set<String>> mayImport = {
  'models': {},
  'core': {'models'},
  'hosts': {'core', 'models'},
  'data': {'hosts', 'core', 'models'},
  'features': {'data', 'hosts', 'models'},
  'app': {'features', 'data', 'hosts', 'core', 'models'},
};

/// Transport packages belong behind `core/`. Naming them here keeps a widget from
/// reaching for a socket directly and bypassing the layering above.
///
/// `firebase_messaging` is one of them for the same reason, not by analogy: a screen
/// that asked FCM for a token itself would leave `PushRepository` unaware of it, so the
/// token would reach whichever hosts that screen happened to know about (ADR-4).
/// `mobile_scanner` is on the list for a third reason again: it is not a transport,
/// but it *is* a plugin that owns a hardware resource with a lifecycle. A screen that
/// constructed a camera preview itself would decide when the camera stops, and the one
/// place that question is answered correctly is `core/camera_qr_scanner.dart` — which
/// documents why it lets the plugin own its own controller.
const Set<String> transportPackages = {
  'web_socket_channel',
  'http',
  'firebase_messaging',
  'firebase_core',
  'mobile_scanner',
  // Same third reason as `mobile_scanner`: not a transport, but a plugin owning a
  // hardware resource with a lifecycle. A widget that started the microphone itself
  // would decide when it stops, and `Dictation` in `data/` is the one place that
  // answers that — including on cancel, where a leftover clip is the operator's voice
  // left on disk after they decided not to keep it.
  'record',
};

Iterable<File> dartFiles(String dir) => Directory(dir)
    .listSync(recursive: true)
    .whereType<File>()
    .where((f) => f.path.endsWith('.dart'));

/// The layer a path belongs to: `lib/hosts/registry.dart` → `hosts`.
String? layerOf(String path) {
  final parts = path.split(Platform.pathSeparator);
  final i = parts.indexOf('lib');
  if (i == -1 || i + 2 > parts.length - 1) return null;
  return parts[i + 1];
}

void main() {
  final files = dartFiles('lib').toList();

  test('lib is laid out in the layers ADR-13 names', () {
    final layers = files.map((f) => layerOf(f.path)).whereType<String>().toSet();

    expect(layers.difference(mayImport.keys.toSet()), isEmpty,
        reason: 'a new top-level directory under lib/ needs a rule in ADR-13 first');
  });

  test('every import obeys the dependency direction', () {
    final violations = <String>[];

    for (final file in files) {
      final from = layerOf(file.path);
      if (from == null) continue;
      final allowed = mayImport[from];
      if (allowed == null) continue;

      for (final line in file.readAsLinesSync()) {
        final match = RegExp("import 'package:lotus_pocket/([a-z_]+)/").firstMatch(line);
        // A relative import stays inside its own layer by construction, so only
        // package-qualified ones can cross a boundary.
        if (match == null) continue;
        final to = match.group(1)!;
        if (to == from || allowed.contains(to)) continue;
        violations.add('${file.path}: $from → $to');
      }
    }

    expect(violations, isEmpty);
  });

  test('features never reach transport directly', () {
    final violations = <String>[];

    for (final file in files.where((f) => layerOf(f.path) == 'features')) {
      for (final line in file.readAsLinesSync()) {
        for (final package in transportPackages) {
          if (line.contains("import 'package:$package/")) {
            violations.add('${file.path}: imports $package');
          }
        }
      }
    }

    expect(violations, isEmpty,
        reason: 'sockets and http live behind core/; hosts/ owns their lifecycle');
  });
}
