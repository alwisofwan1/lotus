import 'package:package_info_plus/package_info_plus.dart';

import '../models/app_build.dart';

/// Reads which build is running.
///
/// Two sources, in order. `scripts/release.sh` bakes the build's identity in with
/// `--dart-define` (see `scripts/version.sh`), and that wins: it carries the commit and
/// the build time, and its build number is the bare one — the platform's own versionCode
/// has the `--split-per-abi` offset added, so it reads 2000 higher on an arm64 phone.
///
/// Anything else — `flutter run`, or a store pipeline that never ran the script — falls
/// back to what the platform reports, so a build is never shown as unknown just because
/// it was made another way.
Future<AppBuild> readAppBuild() async {
  const version = String.fromEnvironment('POCKET_VERSION');
  const buildNumber = int.fromEnvironment('POCKET_BUILD_NUMBER');
  const commit = String.fromEnvironment('POCKET_COMMIT');
  const builtAt = String.fromEnvironment('POCKET_BUILT_AT');
  const channel = String.fromEnvironment('POCKET_CHANNEL', defaultValue: 'dev');

  if (version.isNotEmpty && buildNumber > 0) {
    return AppBuild(
      version: version,
      buildNumber: buildNumber,
      commit: commit.isEmpty ? null : commit,
      builtAt: DateTime.tryParse(builtAt),
      channel: channel,
    );
  }

  // Guarded because a widget test has no platform channel behind it, and a missing
  // version is not worth a boot that never finishes.
  try {
    final info = await PackageInfo.fromPlatform();
    return AppBuild(
      version: info.version,
      buildNumber: int.tryParse(info.buildNumber) ?? 0,
      channel: channel,
    );
  } on Object {
    return const AppBuild(version: 'unknown', buildNumber: 0, channel: channel);
  }
}
