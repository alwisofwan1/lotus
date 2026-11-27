import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';

/// How loud it has been, for the last few seconds.
///
/// Split out of `DictationRow` when that file crossed the 300-line limit, and the cut
/// is here because this answers one question — *what is the microphone hearing* — while
/// the row answers a different one: what the operator can do about it.
///
/// **It owns the honesty rule too.** A device that cannot measure loudness reports zero
/// forever, and this is the only place that can tell. Drawing bars from that would be a
/// flat line that looks broken; animating them on a timer would be worse, because a
/// waveform moving to a clock rather than to a voice tells the operator their microphone
/// works at exactly the moment it might not. So when there is no sound to draw, this
/// draws motion that claims nothing about sound.
class LevelTrace extends StatefulWidget {
  const LevelTrace({required this.level, super.key});

  /// The newest sample, `0.0`–`1.0`, already normalised by the recorder.
  final double level;

  @override
  State<LevelTrace> createState() => _LevelTraceState();
}

class _LevelTraceState extends State<LevelTrace> with SingleTickerProviderStateMixin {
  /// Recent samples, oldest first — a history rather than one value, so the trace reads
  /// as a voice moving through time instead of a meter twitching.
  final List<double> _history = [];

  /// Drives the fallback only, and is started and stopped rather than left repeating:
  /// on a device that does report loudness this never runs at all, and an animation
  /// nobody can see is still a frame every 16ms on the one screen where the operator is
  /// holding the phone to their face.
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  );

  /// Bar geometry. [_pitch] is what decides how many fit in a given width.
  static const double _barWidth = 3;
  static const double _gap = 3;
  static const double _pitch = _barWidth + _gap;

  /// Silence and full scale. A floor above zero because a gap in the trace reads as a
  /// fault; a peak of 20 because the pill's own text sits at 12–13, and a waveform that
  /// never out-reaches the type beside it does not look like sound.
  static const double _floor = 3;
  static const double _peak = 20;

  /// How much history is kept. More than any phone shows, so rotating or landing on a
  /// wider screen has samples to fill it rather than starting the trace again.
  static const int _capacity = 64;

  @override
  void initState() {
    super.initState();
    _history.add(widget.level);
    _syncPulse();
  }

  @override
  void didUpdateWidget(LevelTrace old) {
    super.didUpdateWidget(old);
    _history.add(widget.level);
    if (_history.length > _capacity) _history.removeAt(0);
    _syncPulse();
  }

  @override
  void dispose() {
    _pulse.dispose();
    super.dispose();
  }

  bool get _hasSound => _history.any((sample) => sample > 0.01);

  /// The pulse runs exactly while it is the thing being drawn.
  void _syncPulse() {
    if (!_hasSound && !_pulse.isAnimating) {
      _pulse.repeat(reverse: true);
    } else if (_hasSound && _pulse.isAnimating) {
      _pulse.stop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return _hasSound ? _bars(t) : _pulsing(t);
  }

  /// **Newest on the right, growing leftward, filling whatever width it is given.**
  ///
  /// A fixed number of bars left a third of the pill empty on a real phone — dead space
  /// that read as a layout nobody had finished. Counting how many fit means the row is
  /// full at any width, and putting the newest sample nearest the button that ends the
  /// recording is what the eye follows anyway.
  ///
  /// Early on there are fewer samples than slots, so `MainAxisAlignment.end` grows the
  /// trace out of the button rather than stranding four bars on the left.
  Widget _bars(AppTokens t) => LayoutBuilder(
        builder: (context, constraints) {
          // A pixel of slack, then clipped anyway. Sub-pixel widths round the wrong way
          // on some densities, and a trace that overflows by half a bar paints Flutter's
          // yellow-and-black stripes across the composer — caught at 260px in a test,
          // which is a width a small phone in a split view really has.
          final fits = ((constraints.maxWidth - 1) / _pitch).floor().clamp(1, _capacity);
          final shown = _history.length <= fits
              ? _history
              : _history.sublist(_history.length - fits);

          return ClipRect(
            child: SizedBox(
              height: _peak,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.end,
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  for (final sample in shown)
                    Padding(
                      padding: const EdgeInsets.only(left: _gap),
                      // Animated, and keyless on purpose: without keys each slot keeps
                      // its element as the data shifts left, so a bar eases to its
                      // neighbour's value and the trace flows instead of stepping eight
                      // times a second.
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 140),
                        curve: Curves.easeOut,
                        width: _barWidth,
                        // Never zero: a bar that disappears in a pause reads as the
                        // microphone dropping out, when silence is just silence.
                        height: _floor + sample * (_peak - _floor),
                        decoration: BoxDecoration(
                          color: t.dim,
                          borderRadius: BorderRadius.circular(_barWidth),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          );
        },
      );

  /// Motion that claims only "still recording", never "this is what I am hearing".
  Widget _pulsing(AppTokens t) => Row(
        children: [
          FadeTransition(
            opacity: Tween<double>(begin: 0.3, end: 1).animate(_pulse),
            child: Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(color: t.dim, shape: BoxShape.circle),
            ),
          ),
          const SizedBox(width: 10),
          // Flexible, because this word shares the row with a clock and two 44px
          // buttons: on a narrow phone the sentence is the part that can give.
          Flexible(
            child: Text(
              'listening',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: t.ui.copyWith(fontSize: 12.5, color: t.muted),
            ),
          ),
        ],
      );
}
