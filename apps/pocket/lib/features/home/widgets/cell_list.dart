import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../../models/cell.dart';
import '../../../models/host_id.dart';
import 'cell_row.dart';
import 'swipe_to_close.dart';

/// One project's agents, in `FleetStore` order — waiting first (ADR-12 no. 1).
///
/// Only the hairlines live here; a row draws itself. The last one closes the list
/// off, mirroring the mockup's `.item:last-of-type { border-bottom }` — a list that
/// ends on an open edge reads as scrolled rather than finished.
///
/// **The action drawer left on 2026-08-11** and a left swipe took over the one action that
/// was worth keeping in the list ([SwipeToClose]). The list holds the *which lane is open*
/// state for the same reason it used to hold *which drawer is open*: one at a time, or a
/// list of agents becomes a list of control panels.
class CellList extends StatelessWidget {
  const CellList({
    required this.cells,
    required this.onOpen,
    this.isStale = false,
    this.onStartAgent,
    this.onClose,
    this.canClose,
    this.openLane,
    this.onOpenLane,
    this.isUnread,
    super.key,
  });

  final List<Cell> cells;
  final void Function(Cell cell) onOpen;

  /// Ends this cell, and answers whether it really ended. Null on a host that never
  /// advertised `close`, and then no row gets a swipe lane at all — a gesture the machine
  /// could not honour is worse than none (ADR-14).
  final Future<bool> Function(Cell cell)? onClose;

  /// Asked per cell rather than once: a project lives on one host today, but this list is
  /// not the place to assume it always will.
  final bool Function(Cell cell)? canClose;

  /// Which lane is swiped open, and how it changes. Held above this widget so **one at a
  /// time** is a property of the list rather than of each row.
  final CellRef? openLane;
  final void Function(CellRef ref, bool open)? onOpenLane;

  /// Turns the composer into the way to start an agent. Null draws no row at all —
  /// on a host that never advertised `spawn` there is nothing to offer, and ADR-14's
  /// rule is that an unhonourable control is worse than empty space.
  final VoidCallback? onStartAgent;

  /// Finished since last opened. Null: no row is ever marked.
  final bool Function(Cell cell)? isUnread;

  /// The host stopped answering, so every row here is the last thing it said rather
  /// than what is true now.
  ///
  /// Drawn as a single dimming of the whole list, which is the honest shape: staleness
  /// is a property of the *source*, not of any one agent, so marking rows individually
  /// would suggest the phone had checked them one by one. [ProjectHeader] says it in
  /// words directly above; this is what makes it legible without reading.
  ///
  /// **The amber of a waiting row recedes with everything else, and that is intended.**
  /// A cell cannot be answered while its machine is unreachable — the dispatch fails at
  /// the transport — so a mark at full strength would be calling the operator to an
  /// action that cannot complete. Amber still means *something is asked of you*; it is
  /// simply reported at the confidence the connection actually justifies.
  final bool isStale;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Opacity(opacity: isStale ? 0.45 : 1, child: _list(t));
  }

  Widget _list(AppTokens t) => ListView.builder(
    // Flutter's documented requirement for pull-to-refresh over a list shorter than
    // the viewport. Verified 2026-08-09 that removing it does **not** break the
    // gesture today — a `ListView` notifies overscroll even at zero extent — so this
    // is insurance against a `ScrollBehavior` change rather than the thing that makes
    // it work. Stated because a comment claiming otherwise would send the next reader
    // hunting for a dependency that is not there.
    physics: const AlwaysScrollableScrollPhysics(),
    padding: const EdgeInsets.only(top: 20),
    // One past the agents when there is a row to add: the list closes on it, so the
    // hairline that used to end the list now sits under something pressable rather
    // than under nothing.
    itemCount: cells.length + (onStartAgent == null ? 0 : 1),
    itemBuilder: (context, i) {
      final last = i == cells.length + (onStartAgent == null ? 0 : 1) - 1;
      // No hairlines since the 2026-08-27 revamp: rows are 76px and told apart by
      // their own height and mark. One rule below the last row keeps the list's foot
      // where the composer begins.
      return DecoratedBox(
        decoration: BoxDecoration(
          border: Border(bottom: last ? BorderSide(color: t.line) : BorderSide.none),
        ),
        child: i < cells.length
            ? _tile(cells[i])
            : _StartAgentRow(onTap: onStartAgent!),
      );
    },
  );

  /// A row, wrapped in its swipe lane where the host allows one.
  ///
  /// The lane is absent rather than inert on a host that cannot end a cell, so the gesture
  /// never exists somewhere it would fail — the same rule the drawer's `Close` followed.
  Widget _tile(Cell cell) {
    final close = onClose;
    if (close == null || !(canClose?.call(cell) ?? false)) {
      return CellRow(cell: cell, onOpen: () => onOpen(cell), unread: isUnread?.call(cell) ?? false);
    }

    return SwipeToClose(
      agent: cell.title,
      isOpen: openLane == cell.ref,
      onOpenChanged: (open) => onOpenLane?.call(cell.ref, open),
      onClose: () => close(cell),
      child: CellRow(cell: cell, onOpen: () => onOpen(cell), unread: isUnread?.call(cell) ?? false),
    );
  }
}

/// `+  New agent` — the last row, and the same shape as the agents above it.
///
/// In the list rather than floating over it. A button that hovers would be the first
/// piece of chrome on a screen whose whole discipline is *no navigation, one control*,
/// and it would hover exactly where the composer is. As a row it closes the list, fills
/// the space an operator's eye already lands on, and needs no new idiom to read.
class _StartAgentRow extends StatelessWidget {
  const _StartAgentRow({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return InkWell(
      onTap: onTap,
      splashColor: t.raise,
      highlightColor: t.raise,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 76),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          child: Row(
            children: [
              // The `+` stands in the mark column, so every row on Home shares one left
              // edge whether it names an agent or makes one. Thin, because it is an
              // affordance beside seven brand marks, not an eighth mark.
              SizedBox(
                width: CellRow.markColumn,
                height: CellRow.markColumn,
                child: Center(
                  child: Text(
                    '+',
                    style: t.ui.copyWith(fontSize: 26, fontWeight: FontWeight.w300, height: 1, color: t.muted),
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    'New agent',
                    style: t.serif.copyWith(fontSize: 19, fontWeight: FontWeight.w500, letterSpacing: -0.3, color: t.dim),
                  ),
                  const SizedBox(height: 5),
                  // What the tap does, because it now opens the sheet at once.
                  Text('choose a runner', style: t.mono.copyWith(fontSize: 11.5, height: 1.4, color: t.faint)),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
