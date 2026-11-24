/// Which build of Pocket is running: what the operator compares against the build they
/// just made to know the phone took the update.
///
/// The fields mirror `scripts/version.sh` one for one, so the line `release.sh` prints
/// and the one Diagnostics shows are the same line.
class AppBuild {
  const AppBuild({
    required this.version,
    required this.buildNumber,
    this.commit,
    this.builtAt,
    this.channel = 'dev',
  });

  /// Semver — what a store listing calls the version.
  final String version;

  /// The number Android and iOS compare on upgrade, **before** the ABI offset that
  /// `--split-per-abi` adds to an APK's versionCode. It is the one number every store
  /// and every ABI agree on, so it is the one worth showing.
  final int buildNumber;

  /// Short git sha, `-dirty` when built from uncommitted changes. Null for a build
  /// made without `release.sh`, which has no way to know.
  final String? commit;

  final DateTime? builtAt;

  /// `sideload`, `play`, `appstore`, or `dev` for anything built by hand.
  final String channel;

  /// `1.0.0 (29850748)` — the store convention, and what `release.sh` prints.
  String get label => '$version ($buildNumber)';

  /// Whether this build replaced [previous] — strictly newer, never merely different,
  /// because a reinstall of the same build is not an update.
  bool supersedes(int previous) => buildNumber > previous;
}
