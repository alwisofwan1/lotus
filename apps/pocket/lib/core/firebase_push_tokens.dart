import 'package:firebase_messaging/firebase_messaging.dart';

import 'push_tokens.dart';

/// Isolate FlutterFire from other layers; the OS handles notification display and taps.
class FirebasePushTokens implements PushTokens {
  const FirebasePushTokens();

  /// Do not probe with getToken: it registers the device before a token is needed.
  @override
  Future<bool> get available async => true;

  @override
  Future<String?> requestToken() async {
    try {
      // The first contact with Google, and it happens here rather than at launch:
      // auto-init is off in the manifest, so nothing is registered until a host is
      // paired and this runs. The setting persists, so later launches keep working
      // (including `onTokenRefresh`).
      await FirebaseMessaging.instance.setAutoInitEnabled(true);

      // Permission first: from Android 13 a notification cannot be shown without the
      // runtime grant, so a token obtained before asking would deliver wake-ups the
      // operator never sees. `provisional` is an iOS concept and harmless here.
      final settings = await FirebaseMessaging.instance.requestPermission();
      final granted = settings.authorizationStatus == AuthorizationStatus.authorized ||
          settings.authorizationStatus == AuthorizationStatus.provisional;
      if (!granted) return null;

      return await FirebaseMessaging.instance.getToken();
    } on Object {
      // Declined, no Play Services, or a misconfigured project. `PushRepository`
      // registers nothing on null and the app runs on its live socket as before.
      return null;
    }
  }

  @override
  Stream<String> get refreshed => FirebaseMessaging.instance.onTokenRefresh;
}
