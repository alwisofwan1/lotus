import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import '../../data/dictation.dart';
import 'level_trace.dart';

/// What the composer becomes while it is listening.
///
/// It replaces the field rather than opening anything: the row is already there, and a
/// sheet or a full-screen recorder is the most expensive way to say "I can hear you".
///
/// **No colour, and that is a rule rather than a preference.** Every recorder in the
/// world draws a red dot; this app cannot, because red is `error` and means something
/// failed, while amber is `waiting` and means something is being asked of the operator.
/// Recording is neither — the operator is the one acting. So liveness is carried by
/// motion, and the palette stays where it was.
///
/// The trace itself lives in [LevelTrace]: this row is the three controls and the two
/// states they sit in, and what the microphone is hearing is a separate question.
class DictationRow extends StatelessWidget {
  const DictationRow({
    required this.state,
    required this.onCancel,
    required this.onStop,
    super.key,
  });

  final DictationState state;

  /// Throws the audio away. First in reading order, because while recording it is the
  /// action most likely to be wanted in a hurry.
  final VoidCallback onCancel;

  /// Ends the recording and sends it to be transcribed.
  final VoidCallback onStop;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final current = state;

    return Row(
      children: [
        _glyph(t, '×', onCancel, 'Discard recording'),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 13),
            child: current is DictationRecording ? _listening(t, current) : _working(t),
          ),
        ),
        const SizedBox(width: 4),
        _accept(t, enabled: current is DictationRecording),
      ],
    );
  }

  Widget _listening(AppTokens t, DictationRecording current) => Row(
        children: [
          const SizedBox(width: 2),
          Expanded(child: LevelTrace(level: current.level)),
          // 14, not 10: the accept button is a filled circle, and a number touching it
          // reads as part of it. This is the gap that lets the clock be its own thing.
          const SizedBox(width: 14),
          Text(
            _clock(current.elapsed),
            // Tabular figures. Without them the row twitches sideways every time a digit
            // changes width — on a counter that redraws once a second, beside a waveform
            // that is already moving.
            style: t.mono.copyWith(
              fontSize: 12,
              color: t.muted,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(width: 6),
        ],
      );

  /// Transcribing: a hairline, not a spinner. Over a tailnet this is seconds, and a
  /// spinner in a text field is a shape this app does not otherwise own.
  Widget _working(AppTokens t) => Row(
        children: [
          Text('transcribing', style: t.ui.copyWith(fontSize: 12.5, color: t.muted)),
          const SizedBox(width: 12),
          Expanded(
            child: LinearProgressIndicator(
              minHeight: 1,
              backgroundColor: t.line,
              valueColor: AlwaysStoppedAnimation<Color>(t.dim),
            ),
          ),
        ],
      );

  /// The same `Material` + `InkWell` pair the send button and the terminal button use.
  ///
  /// A bare `InkResponse` looked tidier and did not receive taps here at all — the pill
  /// around it is a `Container` with a decoration, not a `Material`, so there was no ink
  /// surface for the response to belong to. Caught by a widget test that tapped cancel
  /// and watched the recording carry on.
  Widget _glyph(AppTokens t, String glyph, VoidCallback onTap, String label) => Semantics(
        button: true,
        label: label,
        child: Material(
          color: Colors.transparent,
          shape: const CircleBorder(),
          child: InkWell(
            onTap: onTap,
            customBorder: const CircleBorder(),
            child: SizedBox(
              width: 44,
              height: 44,
              child: Center(
                child: Text(glyph,
                    style: t.ui.copyWith(fontSize: 17, height: 1, color: t.dim)),
              ),
            ),
          ),
        ),
      );

  /// The same filled circle the send button uses, because it does the same kind of
  /// thing: it is the one control here that commits.
  Widget _accept(AppTokens t, {required bool enabled}) => Semantics(
        button: true,
        enabled: enabled,
        label: 'Stop and transcribe',
        child: Material(
          color: enabled ? t.text : t.raise,
          shape: const CircleBorder(),
          child: InkWell(
            onTap: enabled ? onStop : null,
            customBorder: const CircleBorder(),
            child: SizedBox(
              width: 44,
              height: 44,
              child: Center(
                child: Text(
                  '✓',
                  style: t.ui.copyWith(
                    fontSize: 17,
                    height: 1,
                    fontWeight: FontWeight.w600,
                    color: enabled ? t.bg : t.faint,
                  ),
                ),
              ),
            ),
          ),
        ),
      );

  static String _clock(Duration elapsed) {
    final seconds = elapsed.inSeconds;
    return '${seconds ~/ 60}:${(seconds % 60).toString().padLeft(2, '0')}';
  }
}
