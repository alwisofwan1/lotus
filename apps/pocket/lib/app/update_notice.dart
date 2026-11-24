import 'package:flutter/material.dart';

import '../data/build_seen.dart';

/// Says once, on the first launch of a newer build, which build the phone now runs.
///
/// Through the app-wide messenger rather than a screen, because the launch screen is
/// decided by credentials and intro state — the notice must not care which one it is.
/// `BuildSeen` has already recorded this build at boot, so a relaunch stays quiet.
void announceUpdate(ScaffoldMessengerState? messenger, BuildSeen seen) {
  if (!seen.justUpdated) return;
  messenger?.showSnackBar(SnackBar(
    content: Text('Updated to Lotus Pocket ${seen.current.label}'),
    duration: const Duration(seconds: 6),
  ));
}
