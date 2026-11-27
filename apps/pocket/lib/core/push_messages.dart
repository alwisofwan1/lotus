import '../models/push_wake.dart';

/// Foreground delivery and opened notifications need separate streams, including cold starts.
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
