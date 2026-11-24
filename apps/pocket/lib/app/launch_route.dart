/// Where the app lands once the splash lets go.
enum LaunchRoute {
  /// Three explanatory panes, then the pairing form. First run only.
  intro,

  /// The pairing form on its own.
  pairing,

  /// The project index — every subsequent launch, and the one that matters
  /// (`PocketApp`: Pocket is opened to find out whether an agent needs an answer).
  projects,
}

/// The whole launch decision, as a function of two facts.
///
/// A function rather than a branch inside `build` because it is the only place three
/// screens are chosen between, and because the third case below is a rule somebody
/// will eventually want to break. Written down here, it has a test naming it; written
/// inline, it is one `&&` away from being broken by accident.
///
/// **[paired] wins over [introSeen], always.** A phone that already holds a credential
/// has an operator who has used this app, whatever the stored bit says — the bit can
/// be absent because it was added after they paired, and walking a working setup
/// through an introduction is the failure mode this ordering forbids.
LaunchRoute launchRoute({required bool paired, required bool introSeen}) {
  if (paired) return LaunchRoute.projects;
  return introSeen ? LaunchRoute.pairing : LaunchRoute.intro;
}

/// What the splash says while it holds.
///
/// Three values, all locally true, none of them a percentage. This app has a
/// Diagnostics screen precisely because it refuses to hide state, and a launch screen
/// inventing progress would contradict that on the way in — so the line reports the
/// one thing genuinely happening behind it: sockets being dialled, and how many.
///
/// `dialing` rather than `connecting` because that is the word the rest of the product
/// uses for the same act (`registry`, `Diagnostics`), and a launch screen is a poor
/// place to introduce a synonym.
String launchLine(int machines) {
  if (machines == 0) return 'no machine paired';
  return '$machines ${machines == 1 ? 'machine' : 'machines'} · dialing';
}
