/// One clip, ready to be sent for transcription.
///
/// Base64 rather than bytes because that is the only shape `POST /m/stt` accepts, and
/// converting at the seam keeps the encoding in one place instead of at every caller.
class RecordedClip {
  const RecordedClip({required this.audioBase64, required this.mime});

  final String audioBase64;

  /// Handed to the host verbatim. It matters more than it looks: `voice_http.rs` picks
  /// the upload filename from this, and a provider that receives `audio.webm` holding
  /// AAC rejects the whole request.
  final String mime;
}

/// Normalize dBFS here for consistent levels and honest unavailable readings (ADR-13 no. 4).
abstract class VoiceRecorder {
  /// Whether recording could start right now: the hardware exists and the operator has
  /// granted the permission. Asking is allowed to prompt.
  Future<bool> get canRecord;

  /// Begins recording. Throws if the permission is refused, which is why [canRecord]
  /// exists — a refusal should be a state on screen, not an exception in a build.
  Future<void> start();

  /// Ends the recording and returns what was captured, or null when nothing usable was.
  Future<RecordedClip?> stop();

  /// Ends it and throws the audio away. Distinct from [stop] because it must leave no
  /// file behind: a recording the operator cancelled is one they decided not to keep,
  /// and a temp file outliving that decision is a small betrayal of it.
  Future<void> cancel();

  /// An empty stream means no measurement; simulated movement would mislead the operator.
  Stream<double> get level;

  /// Releases the platform recorder. Called when the app shuts down.
  Future<void> dispose();
}
