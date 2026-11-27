import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../models/cell.dart';
import '../../../models/host_id.dart';
import '../../shared/tactile.dart';
import '../cell_presentation.dart';

/// Who the Home composer is talking to.
///
/// A picker rather than a router, and that is the decision rather than a shortcut.
/// `MVP.md` §3 asked for a composer that routes itself — *"operator menulis maksud,
/// bukan alamat"* — and named `agent-delegation-compiler.ts` as the machinery to reuse.
/// Reading it settled the question the other way: that file takes `target` as an
/// **input**. It composes a delegation to an agent already chosen; it chooses nothing.
/// What does choose lives in `nl_model.rs`, reachable only through Tauri `invoke`, so
/// self-routing would mean a new Rust route, a BYOK key on the critical path, and an
/// LLM round trip inside the one interaction §2.4 requires to feel instant.
///
/// The argument for self-routing was made for a *desktop* command bar, where the fleet
/// can be large and off-screen. On Home the fleet is a short list **directly above the
/// composer**, so naming the target costs one tap and buys away a whole class of
/// wrong-repo dispatch (R-10). Auto-routing can be layered on later as a "route this for
/// me" affordance without changing this surface; the reverse order would ship a key and
/// a new failure mode before any evidence the operator wants them.
Future<TargetChoice?> showTargetPicker(
  BuildContext context, {
  required List<Cell> cells,
  CellRef? current,
  bool canStartAgent = false,
}) {
  final sheet = context.components.sheet;

  return showModalBottomSheet<TargetChoice>(
    context: context,
    // Fill and shape come from the theme, so they follow it while open.
    barrierColor: sheet.barrier,
    builder: (context) => TargetPicker(
      cells: cells,
      current: current,
      canStartAgent: canStartAgent,
    ),
  );
}

/// What came back from the sheet.
///
/// A sealed pair rather than a nullable `CellRef`, because the last row answers a
/// **different question** — not *which agent* but *an agent that does not exist yet* —
/// and a sentinel ref would be a lie the type system could not catch.
sealed class TargetChoice {
  const TargetChoice();
}

/// Aim the composer at an agent already in the list.
class SendToCell extends TargetChoice {
  const SendToCell(this.ref);

  final CellRef ref;
}

/// Turn the composer into the thing that starts one.
class StartNewAgent extends TargetChoice {
  const StartNewAgent();
}

/// The sheet's contents — the same shape as the project switcher, because it answers
/// the same kind of question and a second idiom would be a second thing to learn.
class TargetPicker extends StatelessWidget {
  const TargetPicker({
    required this.cells,
    required this.current,
    this.canStartAgent = false,
    super.key,
  });

  /// Whether this project's host will start an agent. False draws no row at all: a
  /// control the machine could not honour is worse than empty space (ADR-14).
  final bool canStartAgent;

  /// In `FleetStore` order, so the agent that needs the operator is nearest the thumb.
  final List<Cell> cells;

  /// Null on a project with no agents in it, where the sheet is only a way to make
  /// one — nothing is current because nothing exists.
  final CellRef? current;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return SafeArea(
      top: false,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 32,
            height: 4,
            margin: const EdgeInsets.only(top: 10, bottom: 16),
            decoration: BoxDecoration(
              color: t.lineStrong,
              borderRadius: BorderRadius.circular(3),
            ),
          ),
          Flexible(
            child: ListView(
              shrinkWrap: true,
              padding: const EdgeInsets.only(bottom: 20),
              children: [
                for (final cell in cells)
                  _TargetRow(
                    cell: cell,
                    isCurrent: cell.ref == current,
                    onSelect: () {
                      Tactile.chose();
                      Navigator.of(context).pop(SendToCell(cell.ref));
                    },
                  ),
                // Last, and separated by a hairline: every row above names something
                // that exists. This one is the only row that makes something.
                if (canStartAgent)
                  _NewAgentRow(
                    onSelect: () {
                      Tactile.chose();
                      Navigator.of(context).pop(const StartNewAgent());
                    },
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// `Atlas  claude            WAITING`
class _TargetRow extends StatelessWidget {
  const _TargetRow({
    required this.cell,
    required this.isCurrent,
    required this.onSelect,
  });

  final Cell cell;
  final bool isCurrent;
  final VoidCallback onSelect;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final p = CellPresentation.of(cell);

    return InkWell(
      onTap: onSelect,
      splashColor: t.raise,
      highlightColor: t.raise,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 13),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Flexible(
              child: Text(
                p.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: t.ui.copyWith(
                  fontSize: 14.5,
                  fontWeight: isCurrent ? FontWeight.w500 : FontWeight.w400,
                  color: isCurrent ? t.text : t.dim,
                ),
              ),
            ),
            const SizedBox(width: 9),
            Text(
              p.runner,
              style: t.mono.copyWith(fontSize: 11.5, color: t.muted),
            ),
            const Spacer(),
            const SizedBox(width: 9),
            Text(
              p.state.toUpperCase(),
              style: t.mono.copyWith(
                fontSize: 11.5,
                letterSpacing: 0.07 * 11.5,
                // The one row allowed colour, for the same reason it has it on Home:
                // amber means this agent needs you.
                color: p.emphasised ? t.waiting : t.muted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// `+  New agent` — the row that turns the composer into a way to start one.
///
/// Deliberately in the picker rather than as a button of its own. The picker already
/// answers *where do these words go*, and "to an agent that does not exist yet" is an
/// answer to that question — so the phone gains a capability without gaining a control.
class _NewAgentRow extends StatelessWidget {
  const _NewAgentRow({required this.onSelect});

  final VoidCallback onSelect;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          height: 1,
          color: t.line,
          margin: const EdgeInsets.symmetric(vertical: 6),
        ),
        InkWell(
          onTap: onSelect,
          splashColor: t.raise,
          highlightColor: t.raise,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: kMinHitTarget),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 13),
              child: Row(
                children: [
                  // The `+` sits where a runner mark sits on every row above, so the
                  // list keeps one left edge.
                  SizedBox(
                    width: 20,
                    child: Text(
                      '+',
                      style: t.ui.copyWith(fontSize: 15, color: t.dim),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Text(
                    'New agent',
                    style: t.ui.copyWith(fontSize: 14.5, color: t.dim),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
