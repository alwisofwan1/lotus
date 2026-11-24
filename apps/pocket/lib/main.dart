import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

import 'app/composition_root.dart';
import 'app/pocket_app.dart';
import 'core/firebase_push_messages.dart';
import 'core/firebase_push_tokens.dart';
import 'core/push_messages.dart';
import 'core/push_tokens.dart';

/// Entry point, and nothing else.
///
/// The graph is built in [CompositionRoot] rather than here, so the wiring stays
/// testable and this file remains the one thing it should be: bind, boot, run.
Future<void> main() async {
  // Required before the Keychain is read: `boot` awaits a platform channel, and doing
  // that before the bindings exist throws.
  WidgetsFlutterBinding.ensureInitialized();

  final firebase = await _firebaseReady();
  final root = await CompositionRoot.boot(
    pushTokens: firebase ? const FirebasePushTokens() : const UnavailablePushTokens(),
    pushMessages: firebase ? const FirebasePushMessages() : const UnavailablePushMessages(),
  );

  // Sockets open and `/m/bootstrap` fans out without being awaited: a sleeping host
  // retries for as long as it stays asleep, and holding the first frame for it would
  // put the whole screen behind the slowest machine (R-11). Progress arrives through
  // the stores the screen is already listening to.
  root.start();

  runApp(PocketApp(root: root));
}

/// Firebase, or an honest admission that this build cannot receive wake-ups.
///
/// `initializeApp` reads `google-services.json` through the platform, so it fails on a
/// build where that file is absent or names another package. Falling back to
/// [UnavailablePushTokens] rather than rethrowing is the same discipline the whole push
/// path follows: the app then registers no token, runs on its live socket exactly as it
/// did before push existed, and the operator gets a working app instead of a crash on
/// the only screen there is.
Future<bool> _firebaseReady() async {
  try {
    await Firebase.initializeApp();
    return true;
  } on Object {
    return false;
  }
}
