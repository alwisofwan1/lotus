import 'dart:async';

import 'package:lotus_pocket/core/voice_recorder.dart';

/// A microphone the test drives by hand.
///
/// The whole reason [VoiceRecorder] is a seam: without it, dictation could only be
/// exercised on a device, out loud, which is to say never in a suite.
class FakeRecorder implements VoiceRecorder {
  FakeRecorder({this.permitted = true, this.clip = _silence});

  /// What [canRecord] answers — the permission the operator either granted or did not.
  bool permitted;

  /// What [stop] hands back. Null models a recording that produced nothing usable.
  RecordedClip? clip;

  /// Thrown by [start], for the device that has a microphone it cannot open.
  Object? failStart;

  /// Thrown by [stop], for a clip that cannot be read back.
  Object? failStop;

  int starts = 0;
  int stops = 0;
  int cancels = 0;
  int disposals = 0;

  final StreamController<double> _levels = StreamController<double>.broadcast();

  /// Pushes one loudness sample, as the platform would every 120ms.
  void hear(double level) => _levels.add(level);

  static const RecordedClip _silence =
      RecordedClip(audioBase64: 'AAAA', mime: 'audio/mp4');

  @override
  Future<bool> get canRecord async => permitted;

  @override
  Future<void> start() async {
    starts += 1;
    final failure = failStart;
    if (failure != null) throw failure;
  }

  @override
  Future<RecordedClip?> stop() async {
    stops += 1;
    final failure = failStop;
    if (failure != null) throw failure;
    return clip;
  }

  @override
  Future<void> cancel() async => cancels += 1;

  @override
  Stream<double> get level => _levels.stream;

  @override
  Future<void> dispose() async {
    disposals += 1;
    await _levels.close();
  }
}
