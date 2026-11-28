import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../../../app/theme/theme.dart';
import '../../shared/tactile.dart';

/// A 48 px track with the thumb in the middle: slide left for [noLabel], right for [yesLabel].
///
/// Equal weight on purpose (ADR-8): neither end is filled or coloured, and both need the
/// same 70% travel. Tapping a label only nudges the thumb; it never answers. Screen readers
/// get the two answers as plain actions instead of a drag.
class SlideToAnswer extends StatefulWidget {
  const SlideToAnswer({
    required this.yesLabel,
    required this.noLabel,
    required this.onYes,
    required this.onNo,
    this.yesHint,
    this.noHint,
    super.key,
  });

  /// Short words drawn at each end, taken from the prompt's own option labels.
  final String yesLabel;
  final String noLabel;

  /// The whole option label, read by a screen reader.
  final String? yesHint;
  final String? noHint;

  /// Each returns whether the answer landed; false puts the thumb back in the middle.
  final Future<bool> Function() onYes;
  final Future<bool> Function() onNo;

  static const double height = 48;
  static const double commitAt = 0.7;

  @override
  State<SlideToAnswer> createState() => _SlideToAnswerState();
}

class _SlideToAnswerState extends State<SlideToAnswer> with SingleTickerProviderStateMixin {
  static const double _thumb = 40;
  static const double _inset = 4;

  /// Thumb position: -1 is the No end, 0 the middle, 1 the Yes end.
  late final AnimationController _x = AnimationController(vsync: this, lowerBound: -1, upperBound: 1, value: 0);
  bool _busy = false;

  @override
  void dispose() {
    _x.dispose();
    super.dispose();
  }

  Duration get _settle => AppMotion.of(context, AppMotion.settle);

  Future<void> _to(double target) =>
      _x.animateTo(target, duration: _settle, curve: Curves.easeOutQuart).orCancel.catchError((_) {});

  void _drag(DragUpdateDetails d, double travel) {
    if (_busy || travel <= 0) return;
    final before = _x.value.abs() >= SlideToAnswer.commitAt;
    _x.value = (_x.value + d.delta.dx / travel).clamp(-1.0, 1.0);
    if (!before && _x.value.abs() >= SlideToAnswer.commitAt) Tactile.chose();
  }

  Future<void> _release() async {
    if (_busy) return;
    final v = _x.value;
    if (v.abs() < SlideToAnswer.commitAt) return _to(0);
    await _commit(v > 0);
  }

  Future<void> _commit(bool yes) async {
    setState(() => _busy = true);
    await _to(yes ? 1 : -1);
    final landed = await (yes ? widget.onYes() : widget.onNo());
    if (!mounted) return;
    setState(() => _busy = false);
    if (!landed) await _to(0);
  }

  Future<void> _nudge(bool yes) async {
    if (_busy) return;
    Tactile.chose();
    await _to(yes ? 0.22 : -0.22);
    if (mounted && !_busy) await _to(0);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Semantics(
      container: true,
      label: 'Slide to answer',
      customSemanticsActions: {
        CustomSemanticsAction(label: widget.noHint ?? widget.noLabel): () => _commit(false),
        CustomSemanticsAction(label: widget.yesHint ?? widget.yesLabel): () => _commit(true),
      },
      child: ExcludeSemantics(
        child: LayoutBuilder(
          builder: (context, box) {
            final travel = (box.maxWidth - _thumb) / 2 - _inset;
            return GestureDetector(
              behavior: HitTestBehavior.opaque,
              onHorizontalDragUpdate: (d) => _drag(d, travel),
              onHorizontalDragEnd: (_) => _release(),
              onHorizontalDragCancel: _release,
              child: AnimatedBuilder(animation: _x, builder: (context, _) => _track(context, t, travel)),
            );
          },
        ),
      ),
    );
  }

  Widget _track(BuildContext context, AppTokens t, double travel) {
    final v = _x.value;
    final past = v.abs() >= SlideToAnswer.commitAt;
    final label = t.ui.copyWith(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: t.text);
    return Container(
      height: SlideToAnswer.height,
      decoration: BoxDecoration(color: t.raise2, borderRadius: context.shape.radius(ShapeRole.pill)),
      child: Stack(
        alignment: Alignment.center,
        children: [
          Positioned(
            left: 0,
            top: 0,
            bottom: 0,
            child: _end(widget.noLabel, Icons.chevron_left, label, t, opacity: 1 - v.clamp(0.0, 1.0), yes: false),
          ),
          Positioned(
            right: 0,
            top: 0,
            bottom: 0,
            child: _end(widget.yesLabel, Icons.chevron_right, label, t, opacity: 1 + v.clamp(-1.0, 0.0), yes: true),
          ),
          Transform.translate(
            offset: Offset(v * travel, 0),
            child: Container(
              width: _thumb,
              height: _thumb,
              decoration: BoxDecoration(
                color: past ? t.text : t.raise,
                shape: BoxShape.circle,
                border: Border.all(color: t.lineStrong),
              ),
              child: _busy
                  ? Padding(
                      padding: const EdgeInsets.all(11),
                      child: CircularProgressIndicator(strokeWidth: 2, color: t.bg),
                    )
                  : Icon(
                      past ? (v > 0 ? Icons.check : Icons.close) : Icons.drag_indicator,
                      size: 20,
                      color: past ? t.bg : t.dim,
                    ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _end(
    String text,
    IconData chevron,
    TextStyle style,
    AppTokens t, {
    required double opacity,
    required bool yes,
  }) {
    final arrow = Icon(chevron, size: 18, color: t.muted);
    final words = Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: style);
    return Opacity(
      opacity: opacity.clamp(0.0, 1.0),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => _nudge(yes),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(mainAxisSize: MainAxisSize.min, children: yes ? [words, arrow] : [arrow, words]),
        ),
      ),
    );
  }
}
