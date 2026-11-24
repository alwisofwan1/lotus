import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import 'voice_recorder.dart';

/// The device microphone, behind [VoiceRecorder].
///
/// The only file in the app that names `record`, which is what the layering test
/// enforces (`transportPackages`).
class DeviceVoiceRecorder implements VoiceRecorder {
  DeviceVoiceRecorder();

  final AudioRecorder _recorder = AudioRecorder();

  /// Where the clip is written. Held so [stop] and [cancel] can delete it: `record`
  /// removes the file on its own `cancel`, but a `stop` that we then read leaves it
  /// behind, and a cache full of the operator's voice is not a thing to leave lying
  /// around on a phone.
  String? _path;

  /// dBFS below which the bar reads as silence.
  ///
  /// −45 rather than the −160 floor the platform can report: ordinary room tone sits
  /// around −50, and a scale anchored at the true floor leaves every human voice
  /// crammed into the top tenth of the bar, barely moving.
  static const double _silenceDb = -45;

  @override
  Future<bool> get canRecord => _recorder.hasPermission();

  @override
  Future<void> start() async {
    // The app's own cache directory. It is private to this package and the OS may
    // reclaim it, both of which are right for audio that exists for a few seconds.
    final dir = await getTemporaryDirectory();
    final path = '${dir.path}/dictation.m4a';
    _path = path;

    await _recorder.start(
      // AAC-LC in an m4a container, matching what the host can forward: `voice_http.rs`
      // maps `audio/mp4` to `audio.mp4`, a shape the provider accepts. 32 kbps mono at
      // 16 kHz is speech-recogniser territory — a minute lands near 240 KB, where WAV
      // would be ten times that on a link the operator may be paying for.
      const RecordConfig(
        encoder: AudioEncoder.aacLc,
        bitRate: 32000,
        sampleRate: 16000,
        numChannels: 1,
      ),
      path: path,
    );
  }

  @override
  Future<RecordedClip?> stop() async {
    final path = await _recorder.stop() ?? _path;
    _path = null;
    if (path == null) return null;

    final file = File(path);
    if (!file.existsSync()) return null;

    final bytes = await file.readAsBytes();
    // Deleted whether or not it is usable. The transcription has the audio now, and the
    // copy on disk only adds somewhere for it to be found later.
    await _delete(file);
    if (bytes.isEmpty) return null;

    return RecordedClip(audioBase64: base64Encode(bytes), mime: 'audio/mp4');
  }

  @override
  Future<void> cancel() async {
    final path = _path;
    _path = null;
    await _recorder.cancel();
    // Belt and braces: `cancel` deletes the file itself, but a recorder that was never
    // started throws rather than cleaning up, and the path is the only thing that knows.
    if (path != null) await _delete(File(path));
  }

  @override
  Stream<double> get level => _recorder
      // 120ms: fast enough that the bar tracks syllables, slow enough that it is not
      // sixty rebuilds a second on the one screen where the operator is talking.
      .onAmplitudeChanged(const Duration(milliseconds: 120))
      .map((amplitude) => _normalise(amplitude.current));

  @override
  Future<void> dispose() => _recorder.dispose();

  /// dBFS → `0.0`–`1.0`, clamped.
  static double _normalise(double dbfs) {
    if (dbfs.isNaN || dbfs.isInfinite) return 0;
    final ratio = (dbfs - _silenceDb) / (0 - _silenceDb);
    return ratio.clamp(0.0, 1.0);
  }

  Future<void> _delete(File file) async {
    try {
      if (file.existsSync()) await file.delete();
    } on FileSystemException {
      // A clip we could not remove is not worth failing a dictation over; the OS
      // reclaims this directory anyway.
    }
  }
}
