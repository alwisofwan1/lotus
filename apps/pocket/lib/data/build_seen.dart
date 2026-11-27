import '../core/secure_store.dart';
import '../models/app_build.dart';

/// Remember the last build so updates are announced once without repeating onboarding.
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

  /// Treat returning installs without a saved build as updates, but keep fresh installs quiet.
  Future<void> load({required bool returning}) async {
    final all = await store.readAll();
    final previous = int.tryParse(all[key] ?? '');

    _updated = previous == null ? returning : current.supersedes(previous);
    if (previous != current.buildNumber) {
      await store.write(key, '${current.buildNumber}');
    }
  }
}
