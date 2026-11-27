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

/// The single file of a disallowed layer a layer may still reach: the theme barrel.
const Map<String, Set<String>> mayImportFile = {
  'features': {'app/theme/theme.dart'},
};

/// Camera surfaces stay black whatever the theme, like the viewfinder in core/.
const Set<String> hardCodedColourAllowlist = {'lib/features/onboarding/widgets/scan_screen.dart'};

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

/// Every import/export/part target in [source]: either quote, split across lines.
Iterable<String> directiveTargets(String source) => RegExp(
      r'''^\s*(?:import|export|part)\s+r?(['"])(.*?)\1''',
      multiLine: true,
      dotAll: true,
    ).allMatches(source).map((m) => m.group(2)!);

/// What a `lib/` file imports, as paths under `lib/` — relative imports resolved.
Iterable<String> importsOf(String path, String source) sync* {
  final dir = File(path).absolute.parent.uri;
  for (final target in directiveTargets(source)) {
    if (target.startsWith('package:lotus_pocket/')) {
      yield target.substring('package:lotus_pocket/'.length);
    } else if (!target.contains(':')) {
      final resolved = dir.resolve(target).path;
      final i = resolved.lastIndexOf('/lib/');
      if (i != -1) yield resolved.substring(i + 5);
    }
  }
}

/// Offsets of colour literals in [source], whitespace and line breaks included.
Iterable<int> colourLiterals(String source) => RegExp(
      r'\bColor\s*\(\s*0x|\bColor\.fromA?RGB[OA]?\s*\(|\bColors\s*\.\s*(?!transparent\b)',
    ).allMatches(source).map((m) => m.start);

void main() {
  final files = dartFiles('lib').toList();

  test('lib is laid out in the layers ADR-13 names', () {
    final layers = files.map((f) => layerOf(f.path)).whereType<String>().toSet();

    expect(layers.difference(mayImport.keys.toSet()), isEmpty,
        reason: 'a new top-level directory under lib/ needs a rule in ADR-13 first');
  });

  test('every import obeys the dependency direction, relative ones included', () {
    final violations = <String>[];

    for (final file in files) {
      final from = layerOf(file.path);
      if (from == null) continue;
      final allowed = mayImport[from];
      if (allowed == null) continue;

      for (final target in importsOf(file.path, file.readAsStringSync())) {
        final to = target.split('/').first;
        if (to == from || allowed.contains(to)) continue;
        if (mayImportFile[from]?.contains(target) ?? false) continue;
        violations.add('${file.path}: $from → $target');
      }
    }

    expect(violations, isEmpty);
  });

  test('relative imports are resolved, in every spelling Dart accepts', () {
    const path = 'lib/features/agent/x.dart';
    const source = '''
import "../../core/a.dart";
import
    '../../core/b.dart'
    show B;
export '../../data/c.dart';
import 'package:lotus_pocket/hosts/d.dart';
import 'sibling.dart';
// import '../../core/commented.dart';
''';
    expect(importsOf(path, source), [
      'core/a.dart',
      'core/b.dart',
      'data/c.dart',
      'hosts/d.dart',
      'features/agent/sibling.dart',
    ]);
  });

  test('colour literals are found however they are spelled', () {
    const source = 'a = Color(0xFF000000); b = Color(\n  0x12345678); c = Colors\n.black;'
        ' d = Color.fromRGBO(0, 0, 0, 1); e = Colors.transparent;';
    expect(colourLiterals(source), hasLength(4));
  });

  test('features colour only through theme tokens', () {
    final violations = <String>[];
    for (final file in files.where((f) => layerOf(f.path) == 'features')) {
      if (hardCodedColourAllowlist.contains(file.path)) continue;
      final source = file.readAsStringSync();
      for (final at in colourLiterals(source)) {
        violations.add('${file.path}:${'\n'.allMatches(source.substring(0, at)).length + 1}');
      }
    }
    expect(violations, isEmpty, reason: 'add a role to app/theme instead of a literal');
  });

  test('features never reach transport directly', () {
    final violations = <String>[];

    for (final file in files.where((f) => layerOf(f.path) == 'features')) {
      for (final target in directiveTargets(file.readAsStringSync())) {
        for (final package in transportPackages) {
          if (target.startsWith('package:$package/')) {
            violations.add('${file.path}: imports $package');
          }
        }
      }
    }

    expect(violations, isEmpty,
        reason: 'sockets and http live behind core/; hosts/ owns their lifecycle');
  });
}
