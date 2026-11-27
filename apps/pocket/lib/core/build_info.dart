import 'package:package_info_plus/package_info_plus.dart';

import '../models/app_build.dart';

/// Prefer baked build identity because platform build numbers may include ABI offsets.
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
