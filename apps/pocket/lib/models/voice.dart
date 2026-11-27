/// A null text with unsupported host requests device transcription (ADR-11, PLAN §7 no. 9).
class Transcription {
  const Transcription({required this.hostSupports, this.text, this.provider});

  final bool hostSupports;

  /// Null exactly when the host declined to transcribe.
  final String? text;

  /// Provider id — never its key. Enough to notice a wrong active provider, and
  /// to show what is being spent.
  final String? provider;

  bool get transcribedHere => text != null;

  factory Transcription.fromJson(Map<String, Object?> json) => Transcription(
        // Absent means supported: only a host that cannot do it says so out loud.
        hostSupports: json['hostSupports'] as bool? ?? true,
        text: json['text'] as String?,
        provider: json['provider'] as String?,
      );
}
