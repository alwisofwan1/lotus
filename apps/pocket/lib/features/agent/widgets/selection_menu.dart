import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import '../../../app/theme/theme.dart';
import '../../shared/tactile.dart';

/// What can be done with the text the operator just held their thumb on — floated by the
/// selection rather than docked at the foot (v4 tiket 07, B4).
///
/// It replaces `SelectionBar`, a row at the bottom of the pane: the thumb that made the
/// selection is up in the output, and the bar sent it to the far end of the screen for
/// every copy.
///
/// **Selection was always possible and never readable.** `TerminalView` binds it to a
/// long press and a move — but both surfaces left the controller null, so the selection
/// lived inside the library where nothing could reach it (measured 2026-08-10). Passing
/// a [TerminalController] fixed all of it, and this reads that controller back.
///
/// Three actions. `To chat` and `Ask` are the ones Termius cannot have: the agent is on
/// the other side of the same page, so a stack trace read here reaches it without being
/// retyped on glass. Neither sends — the text lands in Chat's field and waits.
class SelectionMenu extends StatelessWidget {
  const SelectionMenu({
    required this.terminal,
    required this.controller,
    required this.anchor,
    this.agent,
    this.onSendToChat,
    this.onAsk,
    super.key,
  });

  final Terminal terminal;
  final TerminalController controller;

  /// The selected text's bounds, in the surface's own coordinates ([selectionBounds]).
  /// The menu sits just above it, or below when there is no room above — never over
  /// it. Null before any touch: top centre.
  final ValueListenable<Rect?> anchor;

  /// Who `Ask` names. Null reads `Ask agent`.
  final String? agent;

  /// Hands the text to Chat's field, unsent. Null drops `To chat`.
  final ValueChanged<String>? onSendToChat;

  /// Hands the text to Chat as a quote, and goes there. Null drops `Ask`.
  final ValueChanged<String>? onAsk;

  /// The gap between the text and the menu.
  static const double _gap = 8;

  /// Null when nothing is held, or when a reflow detached the anchors — a real state:
  /// re-wrapping the buffer moves the cells the selection was pinned to.
  String? get _text {
    final range = controller.selection;
    if (range == null) return null;
    final text = terminal.buffer.getText(range);
    return text.trim().isEmpty ? null : text;
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        // The selection is made by a gesture the emulator handles, so nothing else here
        // rebuilds when it lands; the anchor moves after it, on the lift.
        listenable: Listenable.merge([controller, anchor]),
        builder: (context, _) {
          final text = _text;
          if (text == null) return const SizedBox.shrink();
          return CustomSingleChildLayout(
            delegate: _Beside(anchor.value, _gap),
            child: _menu(context, text),
          );
        },
      );

  Widget _menu(BuildContext context, String text) {
    final t = context.tokens;
    void done() => controller.clearSelection();

    // The phone's own text menu, in this app's colours: one dark pill, no outline, the
    // actions split by hairlines. The bordered box it replaced read as a dialog (LOT2-104).
    final actions = <Widget>[
      _action(t, 'Copy', () async {
        Tactile.sent();
        await Clipboard.setData(ClipboardData(text: text));
        done();
      }),
      if (onSendToChat case final send?)
        _action(t, 'To chat', () {
          Tactile.chose();
          send(text);
          done();
        }),
      // The one label of unknown length — a persona name — so the one that gives way.
      if (onAsk case final ask?)
        Flexible(
          child: _action(t, 'Ask ${agent ?? 'agent'}', () {
            Tactile.chose();
            ask(text);
            done();
          }),
        ),
    ];

    return Material(
      color: t.raise2,
      elevation: context.elevation[ElevationRole.menu],
      shadowColor: t.shadow,
      borderRadius: context.shape.radius(ShapeRole.pill),
      clipBehavior: Clip.antiAlias,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (i, a) in actions.indexed) ...[
            if (i > 0) Container(width: 1, height: 20, color: t.lineStrong),
            a,
          ],
        ],
      ),
    );
  }

  /// 44 tall, like every other control this screen added.
  Widget _action(AppTokens t, String label, VoidCallback onTap) => Semantics(
        button: true,
        label: label,
        excludeSemantics: true,
        child: InkWell(
          onTap: onTap,
          child: Container(
            height: kMinHitTarget,
            constraints: const BoxConstraints(minWidth: kMinHitTarget),
            padding: const EdgeInsets.symmetric(horizontal: 16),
            // Centred down, never across: an `alignment` here filled the width it was
            // offered, and a Flexible `Ask` was offered the whole pane.
            child: Center(
              widthFactor: 1,
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: t.ui.copyWith(fontSize: 14, fontWeight: FontWeight.w500, color: t.text),
              ),
            ),
          ),
        ),
      );
}

/// Where the selected text is on screen, in [into]'s coordinates — read off the emulator
/// under [surface], so it holds through a pan and a zoom. Null when there is none.
Rect? selectionBounds(BuildContext surface, BufferRange range, RenderBox into) {
  TerminalViewState? view;
  void find(Element e) {
    if (view != null) return;
    if (e is StatefulElement && e.state is TerminalViewState) {
      view = e.state as TerminalViewState;
    } else {
      e.visitChildren(find);
    }
  }

  surface.visitChildElements(find);
  final render = view?.renderTerminal;
  if (render == null || !render.attached) return null;
  final r = range.normalized;
  Offset at(int x, int y) =>
      into.globalToLocal(render.localToGlobal(render.getOffset(CellOffset(x, y))));
  final top = at(r.begin.x, r.begin.y);
  final bottom = at(r.end.x, r.end.y + 1);
  // One line: centred on the words. Several: the lines run the full width anyway.
  return r.begin.y == r.end.y
      ? Rect.fromLTRB(top.dx, top.dy, bottom.dx, bottom.dy)
      : Rect.fromLTRB(0, top.dy, into.size.width, bottom.dy);
}

/// Puts the menu above [anchor], or below it when the top is too close, centred on it
/// and kept inside the surface on every side.
class _Beside extends SingleChildLayoutDelegate {
  const _Beside(this.anchor, this.gap);

  final Rect? anchor;
  final double gap;

  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) =>
      constraints.loosen().deflate(const EdgeInsets.all(8));

  @override
  Offset getPositionForChild(Size size, Size child) {
    final at = anchor ?? Rect.fromLTWH(size.width / 2, 0, 0, 0);
    final above = at.top - gap - child.height;
    final y = above >= 8 ? above : at.bottom + gap;
    double clamp(double v, double max) => v.clamp(8.0, (max).clamp(8.0, double.infinity));
    return Offset(
      clamp(at.center.dx - child.width / 2, size.width - child.width - 8),
      clamp(y, size.height - child.height - 8),
    );
  }

  @override
  bool shouldRelayout(_Beside old) => old.anchor != anchor;
}
