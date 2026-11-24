import 'dart:async';

import 'package:firebase_messaging/firebase_messaging.dart';

import '../models/push_wake.dart';
import 'push_messages.dart';

class FirebasePushMessages implements PushMessages {
  const FirebasePushMessages();

  @override
  Stream<PushWake> get foreground =>
      FirebaseMessaging.onMessage.map(_wake).where((w) => w != null).cast<PushWake>();

  /// The tap that launched the app comes first (`getInitialMessage` answers once, null
  /// when the launch was ordinary), then every tap while it lives.
  @override
  Stream<PushWake> get opened async* {
    final initial = await FirebaseMessaging.instance.getInitialMessage();
    if (initial != null) {
      final wake = _wake(initial);
      if (wake != null) yield wake;
    }
    yield* FirebaseMessaging.onMessageOpenedApp.map(_wake).where((w) => w != null).cast<PushWake>();
  }

  static PushWake? _wake(RemoteMessage message) => PushWake.fromMessage(
        data: message.data,
        title: message.notification?.title,
        body: message.notification?.body,
      );
}
