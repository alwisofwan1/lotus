import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/tactile.dart';

/// The model picker: one pill, one segment per alias, the chosen one raised.
///
/// A segmented control and not a list, because the host sends three or four aliases
/// and the whole choice should be readable at once — a list would hide the alternatives
/// behind the current one, which is how a wrong model goes unnoticed until the bill.
/// Serif labels, like every word on this sheet that is read rather than scanned.
///
/// **Past four, the pill scrolls sideways instead of squeezing.** Measured 2026-08-27
/// on a real phone against a real Codex account: six aliases (`5.6-sol … 5.4-mini`)
/// shared one 342px pill and `5.6-terra 5.6-luna` ran into each other. Four equal
/// segments is the most a phone width holds legibly; beyond that each segment keeps a
/// readable minimum width and the row scrolls, with the chosen one brought into view.
class ModelSegment extends StatelessWidget {
  const ModelSegment({
    required this.labels,
    required this.selected,
    required this.onSelect,
    super.key,
  });

  final List<String> labels;
  final int selected;
  final ValueChanged<int> onSelect;

  /// How many segments share the width equally before the row starts to scroll.
  static const int fitsWithoutScrolling = 4;

  /// A segment's floor once the row scrolls — `5.6-terra` in serif 15 with its padding.
  static const double scrollingSegmentWidth = 96;

  bool get _scrolls => labels.length > fitsWithoutScrolling;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final segments = [
      for (var i = 0; i < labels.length; i++)
        _scrolls
            ? SizedBox(width: scrollingSegmentWidth, child: _segment(context, t, i))
            : Expanded(child: _segment(context, t, i)),
    ];

    return Container(
      height: 46,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: t.raise, borderRadius: context.shape.radius(ShapeRole.pill)),
      child: _scrolls
          ? _Scrolled(selected: selected, child: Row(mainAxisSize: MainAxisSize.min, children: segments))
          : Row(children: segments),
    );
  }

  Widget _segment(BuildContext context, AppTokens t, int i) => Semantics(
                button: true,
                selected: i == selected,
                label: 'Model ${labels[i]}',
                child: Material(
                  color: i == selected ? t.raise : Colors.transparent,
                  borderRadius: context.shape.radius(ShapeRole.pill),
                  child: InkWell(
                    onTap: () {
                      if (i == selected) return;
                      Tactile.chose();
                      onSelect(i);
                    },
                    borderRadius: context.shape.radius(ShapeRole.pill),
                    child: Center(
                      child: ExcludeSemantics(
                        child: Text(
                          labels[i],
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: t.serif.copyWith(
                            fontSize: 15,
                            fontWeight: i == selected ? FontWeight.w600 : FontWeight.w500,
                            color: i == selected ? t.text : t.dim,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              );
}

/// The scrolling half of [ModelSegment]: opens with the chosen segment on screen, so a
/// remembered `5.4-mini` is not hidden past the right edge when the sheet reopens.
class _Scrolled extends StatefulWidget {
  const _Scrolled({required this.selected, required this.child});

  final int selected;
  final Widget child;

  @override
  State<_Scrolled> createState() => _ScrolledState();
}

class _ScrolledState extends State<_Scrolled> {
  late final ScrollController _controller = ScrollController(
    // Centre the chosen segment; the controller clamps to the real extent.
    initialScrollOffset: (widget.selected - 1.5) * ModelSegment.scrollingSegmentWidth,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SingleChildScrollView(
        controller: _controller,
        scrollDirection: Axis.horizontal,
        physics: const ClampingScrollPhysics(),
        child: widget.child,
      );
}
