import '../models/push_wake.dart';

/// Wake-ups as they reach this phone: while the app is open, and when one is tapped.
///
/// Two streams because the OS treats the two moments differently. A message that
/// lands while the app is in the foreground is handed to the app and drawn by nobody
/// else — so [foreground] exists, or a wake-up during use would vanish. A tap on a
/// tray entry brings the app up with the message attached; [opened] carries that,
/// including the cold-start case where the tap *is* the launch.
abstract interface class PushMessages {
  Stream<PushWake> get foreground;

  Stream<PushWake> get opened;
}

class UnavailablePushMessages implements PushMessages {
  const UnavailablePushMessages();

  @override
  Stream<PushWake> get foreground => const Stream<PushWake>.empty();

  @override
  Stream<PushWake> get opened => const Stream<PushWake>.empty();
}
