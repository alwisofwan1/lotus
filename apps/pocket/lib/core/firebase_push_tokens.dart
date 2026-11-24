import 'package:firebase_messaging/firebase_messaging.dart';

import 'push_tokens.dart';

/// [PushTokens] over FlutterFire — the one file that names FCM.
///
/// Same shape as `DeviceBiometrics` and `KeychainStore`: everything above this is
/// testable without a platform channel, and nothing but `app/composition_root.dart`
/// imports it. That is what let the whole push path land and be tested before a
/// Firebase project existed (`UnavailablePushTokens` is still the default).
///
/// **No message handling here.** The host sends a `notification` block, so Android
/// draws the wake-up itself and this class never has to build one — the reason no
/// local-notification package is in `pubspec.yaml`. What arrives on tap is handled by
/// the app coming to the foreground, which already hydrates.
class FirebasePushTokens implements PushTokens {
  const FirebasePushTokens();

  /// True by construction: this class is only ever constructed after
  /// `Firebase.initializeApp()` succeeded (see `main.dart`), and a build without a
  /// usable `google-services.json` never gets that far.
  ///
  /// It deliberately does **not** ask FCM anything. The obvious test — call
  /// `getToken()` and see if it throws — is what this used to do, and it registers the
  /// device with Google as a side effect: exactly the contact that auto-init was
  /// switched off to prevent. Whether the device can really receive is answered by
  /// [requestToken] returning null, at the one moment there is a reason to ask.
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
