import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import '../../models/cell.dart';

/// What the app can do to an agent, gathered into one object.
///
/// Deliberately **only the outward actions**. Asking *Close X?* and taking the question
/// back are not in here, because they change nothing outside the widget that is asking
/// — they belong to whoever owns that piece of state, and passing them through this
/// object would mean every surface handing itself its own callbacks in a circle.
///
/// Nothing here runs a mutation or asks a gate. These name a gesture; the screen above
/// decides what it costs.
class CellActionHandlers {
  const CellActionHandlers({
    required this.onStop,
    required this.onClose,
    required this.canClose,
    this.onDispatchHere,
  });

  /// Interrupt the current turn (ESC). Gated like every mutation (ADR-8).
  final void Function(Cell cell) onStop;

  /// End the cell. Only reachable after the row's own question has been answered.
  final void Function(Cell cell) onClose;

  /// Whether this cell's host will end a cell at all. False hides the control rather
  /// than disabling it: a host that cannot do this is not a host that is failing.
  final bool Function(Cell cell) canClose;

  /// Point the composer at this agent. Null on the agent's own page, where the composer
  /// is already aimed at it and the button would be a no-op wearing a label.
  final void Function(Cell cell)? onDispatchHere;
}

/// The actions that live **inside** a row, opened in place.
///
/// Not a sheet, and that was a real revision rather than a preference. A sheet covers
/// half the list to say something thinner than the row it came from, then charges a
/// second tap to leave. For the actions used every day, a surface that appears and
/// disappears is a tax, not structure — so this opens under the row that owns it, the
/// list stays put, and the neighbouring agents stay readable while the operator acts.
///
/// No glyphs on the pills, on purpose. `glyphs.dart` records what typing a character
/// costs here: `✳` came back green from Android's **emoji** font twice, ignoring the
/// colour it was given, on a screen where colour means *something is asked of you*.
/// Words carry these three actions perfectly well and cannot be re-served by a font.
class CellActions extends StatelessWidget {
  const CellActions({
    required this.cell,
    required this.handlers,
    required this.confirmingClose,
    required this.onAskClose,
    required this.onCancelClose,
    this.indent = 0,
    this.offerClose = true,
    this.closeLabel = 'Close',
    super.key,
  });

  /// False hides Close, for a page whose header already closes the agent (Done).
  final bool offerClose;
  final String closeLabel;

  final Cell cell;
  final CellActionHandlers handlers;

  /// Raise the question, and take it back. Owned by whoever owns [confirmingClose],
  /// which is the widget holding this one — see [CellActionHandlers] for why these two
  /// are not in there with the rest.
  final VoidCallback onAskClose;
  final VoidCallback onCancelClose;

  /// How far in the actions start, so they line up with the agent's name rather than
  /// with the edge of whatever surface they are on. The list and the agent page put
  /// that name in different places, and neither should be guessed here.
  final double indent;

  /// Whether this row is currently asking *Close X?* rather than offering the actions.
  ///
  /// The question replaces the strip instead of stacking under it, so the row's height
  /// does not jump and the two buttons land where the eye already is.
  final bool confirmingClose;

  /// Whether interrupting means anything right now.
  ///
  /// Disabled **only** for a cell the host reported `idle`. That is deliberately
  /// narrower than "not running": a runner with no stop hook reports no turn at all
  /// (`MVP.md` §2), and those are exactly the cells an operator most needs to be able
  /// to interrupt — a `codex` cell mid-edit looks identical to one doing nothing. So an
  /// unknown turn keeps the action live, and only the one silence the app is allowed to
  /// call finished takes it away.
  bool get _canStop => !cell.isIdle;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Padding(
      // Aligned to the text column, not the row edge: the actions belong to the name
      // above them, and starting them under the mark would read as a new list item.
      padding: EdgeInsets.only(left: indent, right: 12, bottom: 12),
      child: confirmingClose ? _confirm(t) : _strip(t),
    );
  }

  Widget _strip(AppTokens t) => Row(
        children: [
          if (handlers.onDispatchHere case final aim?) ...[
            _Pill(label: 'Send here', onTap: () => aim(cell)),
            const SizedBox(width: 8),
          ],
          _Pill(label: 'Stop turn', onTap: _canStop ? () => handlers.onStop(cell) : null),
          const Spacer(),
          // Last, and quieter than the two beside it: weight here comes from position
          // and from the question it raises, never from colour. `MVP.md` gives the one
          // warm colour a single meaning, and a destructive control that competed with
          // it would win — red is louder than amber, and it would be shouting about
          // something nobody is being asked to do.
          if (offerClose && handlers.canClose(cell)) _Quiet(label: closeLabel, onTap: onAskClose),
        ],
      );

  Widget _confirm(AppTokens t) => Row(
        children: [
          Expanded(
            // Names the agent, because a drawer can belong to a row the operator did not
            // think they opened — and naming the thing that might be misread is the only
            // way a confirmation earns its tap.
            child: Text(
              'Close ${cell.title}?',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: t.ui.copyWith(fontSize: 13, color: t.dim),
            ),
          ),
          const SizedBox(width: 8),
          _Pill(label: 'Cancel', onTap: onCancelClose),
          const SizedBox(width: 8),
          _Pill(
            label: 'Close',
            onTap: () => handlers.onClose(cell),
            // The only red on this screen, and it exists for the length of one
            // question. Off the list, it competes with nothing.
            danger: true,
          ),
        ],
      );
}

/// A filled action. Null [onTap] is the disabled state, drawn rather than hidden so
/// the destructive control below never moves under the thumb between one agent and
/// the next.
class _Pill extends StatelessWidget {
  const _Pill({required this.label, required this.onTap, this.danger = false});

  final String label;
  final VoidCallback? onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final enabled = onTap != null;
    final ink = danger ? t.error : (enabled ? t.dim : t.faint);

    return Material(
      color: t.raise,
      borderRadius: context.shape.radius(ShapeRole.pill),
      child: InkWell(
        onTap: onTap,
        borderRadius: context.shape.radius(ShapeRole.pill),
        splashColor: t.raise,
        highlightColor: t.raise,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: kMinHitTarget),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            child: Center(
              widthFactor: 1,
              child: Text(
                label,
                style: t.ui.copyWith(fontSize: 13, fontWeight: FontWeight.w500, color: ink),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// An action with no fill. Same hit target, less pull — for the one that should be
/// reachable without being inviting.
class _Quiet extends StatelessWidget {
  const _Quiet({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return InkWell(
      onTap: onTap,
      borderRadius: context.shape.radius(ShapeRole.pill),
      splashColor: t.raise,
      highlightColor: t.raise,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: kMinHitTarget),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Center(
            widthFactor: 1,
            child: Text(label, style: t.ui.copyWith(fontSize: 13, color: t.dim)),
          ),
        ),
      ),
    );
  }
}
