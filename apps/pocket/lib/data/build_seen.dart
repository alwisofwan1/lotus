import '../core/secure_store.dart';
import '../models/app_build.dart';

/// Remembers the last build this phone launched, so the first launch of a newer one
/// can say so once.
///
/// This is the answer to "did the phone take the update?" that does not need a laptop:
/// the operator installs, opens Pocket, and either sees `Updated to …` or does not.
/// Diagnostics shows the running build permanently; this is the moment it changed.
///
/// **A notice, not a changelog.** `IntroSeen` explains why re-showing the intro after an
/// update is wrong; a snackbar naming the new build is the opposite case — one line,
/// dismissible, and it is exactly the fact the operator is checking for.
class BuildSeen {
  BuildSeen(this.store, {required this.current});

  /// Injected, kept visible (ADR-13 no. 4).
  final SecureStore store;

  final AppBuild current;

  /// Namespaced so `Credentials.load` skips it by prefix (see `IntroSeen.key`).
  static const String key = 'build:seen';

  bool _updated = false;

  /// True on the first launch of a build newer than the last one launched.
  bool get justUpdated => _updated;

  /// Reads the last build launched, decides, and records this one — all at boot, so a
  /// second launch of the same build is quiet even if the notice was never drawn.
  ///
  /// [returning] covers the phone that predates this class: it has no stored build,
  /// but a phone that has been through the intro is not a fresh install, so its first
  /// launch with this code *is* an update. A fresh install says nothing — there was no
  /// older Pocket for this one to replace.
  Future<void> load({required bool returning}) async {
    final all = await store.readAll();
    final previous = int.tryParse(all[key] ?? '');

    _updated = previous == null ? returning : current.supersedes(previous);
    if (previous != current.buildNumber) {
      await store.write(key, '${current.buildNumber}');
    }
  }
}
