import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../models/cell.dart';
import '../../shared/age_label.dart';
import '../../shared/glyphs.dart';
import '../agent_activity.dart';
import 'changes_chip.dart';

/// `Atlas ▾` over `● working 2m · CNVS`, and the pager's pips under both.
///
/// The whole block is the drawer's handle — the `▾` says so — because a separate
/// disclosure button was a 44px target competing with the name for the same row, and the
/// name is the larger thing to hit (v4 tiket 03).
class TopBarTitle extends StatelessWidget {
  const TopBarTitle({
    required this.cell,
    required this.index,
    required this.total,
    required this.waitingAt,
    required this.open,
    this.done = false,
    this.onTap,
    super.key,
  });

  /// Marked Done by the operator: the status reads `done` rather than `idle`.
  final bool done;

  final Cell cell;

  /// Position in the pager, how many agents it spans, and which of them are waiting —
  /// so a waiting neighbour's pip is amber before the operator swipes there.
  final int index;
  final int total;
  final Set<int> waitingAt;

  /// Whether the drawer is out; turns the `▾` over.
  final bool open;

  /// Null when there is no drawer to open, which leaves the title plain text.
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final block = Padding(
      padding: const EdgeInsets.only(left: 2),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Flexible(child: _name(t)),
              if (onTap != null) ...[
                const SizedBox(width: 4),
                AnimatedRotation(
                  turns: open ? 0.5 : 0,
                  duration: const Duration(milliseconds: 220),
                  curve: Curves.easeOutQuart,
                  child: Chevron(color: t.muted, size: 13),
                ),
              ],
            ],
          ),
          const SizedBox(height: 2),
          _status(t),
          if (total > 1) Padding(padding: const EdgeInsets.only(top: 5), child: _pips(t)),
        ],
      ),
    );
    final tap = onTap;
    if (tap == null) return block;

    return Semantics(
      button: true,
      label: open ? 'Hide actions' : 'Actions for ${cell.title}',
      child: InkWell(
        onTap: tap,
        borderRadius: context.shape.radius(ShapeRole.key),
        splashColor: t.raise,
        highlightColor: t.raise,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: kMinHitTarget),
          child: Align(alignment: Alignment.centerLeft, widthFactor: 1, child: block),
        ),
      ),
    );
  }

  /// Serif, because it is the one *who* on a screen of *whats*. 18 rather than the old 21:
  /// the name now shares its row with the switch.
  Widget _name(AppTokens t) => Text(
        cell.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: t.serif.copyWith(fontSize: 18, letterSpacing: -0.2, color: t.text, height: 1.25),
      );

  /// A dot and a word, then where. Amber only while the agent is waiting on the
  /// operator — the one colour `MVP.md` allows to mean something — and the word changes
  /// with it, so the state never rests on colour alone. Green is the Home row's `live`,
  /// for an agent working on its own.
  Widget _status(AppTokens t) {
    final asks = cell.needsInput;
    final working = cell.turnKnown && !cell.isIdle && !asks;
    final age = ageLabel(cell.turnAgeMs);
    final style = t.ui.copyWith(fontSize: 12, height: 1.25, color: t.muted);

    return Row(
      children: [
        Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: asks ? t.waiting : (working ? t.live : t.faint),
          ),
        ),
        const SizedBox(width: 6),
        Text(
          done && cell.isIdle ? 'done' : stateLabel(cell),
          style: asks ? style.copyWith(color: t.waiting, fontWeight: FontWeight.w500) : style,
        ),
        Flexible(
          child: Text(
            [if (age != null && cell.turnKnown) ' $age', ' · ${cell.projectName}'].join(),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: style,
          ),
        ),
      ],
    );
  }

  /// Dots, the current one stretched into a short bar.
  Widget _pips(AppTokens t) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < total; i++) ...[
            if (i > 0) const SizedBox(width: 6),
            Container(
              width: i == index ? 18 : 5,
              height: 5,
              decoration: BoxDecoration(
                color: waitingAt.contains(i) ? t.waiting : (i == index ? t.dim : t.faint),
                borderRadius: BorderRadius.circular(2.5),
              ),
            ),
          ],
        ],
      );
}

/// `CNVS · mac · claude · 2m`, and `CHANGED n` beside it — the context the header's old
/// second row carried, now in the drawer above the actions.
///
/// Every small fact in one mono run so none can crowd another out. The host only when
/// [hostLabel] is non-empty, which is `CompositionRoot.hostLabel` saying it actually
/// distinguishes something (`issues/11`).
class TopBarContext extends StatelessWidget {
  const TopBarContext({
    required this.cell,
    required this.hostLabel,
    this.changedFiles,
    this.onOpenChanges,
    super.key,
  });

  final Cell cell;
  final String hostLabel;

  /// Null or zero draws no chip — a chip that opens an empty sheet is worse than none.
  final int? changedFiles;
  final VoidCallback? onOpenChanges;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final age = ageLabel(cell.turnAgeMs);
    final parts = [cell.projectName, if (hostLabel.isNotEmpty) hostLabel, cell.agentType, ?age];

    return Row(
      children: [
        Expanded(
          child: Text(
            parts.join(' · '),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: t.mono.copyWith(fontSize: 11, color: t.muted, height: 1.4),
          ),
        ),
        if ((changedFiles ?? 0) > 0) ChangesChip(files: changedFiles!, onTap: onOpenChanges),
      ],
    );
  }
}
