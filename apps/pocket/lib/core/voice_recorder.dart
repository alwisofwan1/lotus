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

/// The microphone, narrowed to what dictation asks of it.
///
/// A seam like [Biometrics], [SecureStore] and [QrScanner], for the same reason
/// (ADR-13 no. 4) — and the same rule applies: `features/` may not import `core/`, so
/// what reaches a screen is the `data/` controller built on top of this, never this.
///
/// **Levels are normalised here, not at the call site.** The platform reports dBFS,
/// which is a logarithmic scale running to negative infinity in silence; a bar drawn
/// straight from it would sit pinned at one end and move in the wrong places. Doing the
/// mapping behind the seam also means a recorder that cannot measure amplitude at all
/// can answer honestly — an empty [level] stream — instead of every screen inventing a
/// fallback of its own.
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

  /// Loudness while recording, `0.0`–`1.0`.
  ///
  /// Empty when this recorder cannot measure it. That is a real answer, and the UI is
  /// expected to render motion that depends on nothing rather than a waveform that
  /// animates on a timer — a bar moving to a clock rather than to a voice tells the
  /// operator their microphone is working at exactly the moment it might not be.
  Stream<double> get level;

  /// Releases the platform recorder. Called when the app shuts down.
  Future<void> dispose();
}
