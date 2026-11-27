import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../models/cell.dart';
import '../../../models/host_id.dart';
import '../../home/cell_presentation.dart';
import '../../home/widgets/cell_row.dart';
import '../../shared/runner_mark.dart';
import '../../shared/tactile.dart';

/// The dock's Sessions sheet (v4 tiket 08, mockup B5): this pager's agents, by machine.
///
/// **Only this pager's agents**, decided 2026-10-05. A project is one machine's
/// (`ProjectRef` is host + workspace), so the pager never holds a second machine and the
/// sheet shows one group. The grouping stays: it names which machine these are on, and it
/// is where a cross-project sheet would add its second group without a new idiom. Moving
/// between projects stays Home's job — the pager's order is frozen on purpose (ADR-6
/// addendum, ADR-15).
Future<SessionChoice?> showSessionsSheet(
  BuildContext context, {
  required List<Cell> cells,
  required CellRef current,
  required String Function(HostId host) machine,
  bool canStart = false,
}) {
  final sheet = context.components.sheet;
  return showModalBottomSheet<SessionChoice>(
    context: context,
    backgroundColor: sheet.fill,
    shape: sheet.shape,
    barrierColor: sheet.barrier,
    isScrollControlled: true,
    builder: (context) => SessionsSheet(
      cells: cells,
      current: current,
      machine: machine,
      canStart: canStart,
    ),
  );
}

/// What came back: an agent already in the pager, or one that does not exist yet.
sealed class SessionChoice {
  const SessionChoice();
}

class OpenSession extends SessionChoice {
  const OpenSession(this.ref);

  final CellRef ref;
}

/// Start one through Home's spawn flow — the one that runs the gate and watches it land.
class StartSession extends SessionChoice {
  const StartSession();
}

class SessionsSheet extends StatelessWidget {
  const SessionsSheet({
    required this.cells,
    required this.current,
    required this.machine,
    this.canStart = false,
    super.key,
  });

  /// In pager order, so the sheet and a swipe agree on what comes next.
  final List<Cell> cells;
  final CellRef current;
  final String Function(HostId host) machine;

  /// Whether this machine starts agents. False draws no `New`: a control the machine
  /// could not honour is worse than empty space (ADR-14).
  final bool canStart;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final groups = <HostId, List<Cell>>{};
    for (final cell in cells) {
      (groups[cell.host] ??= []).add(cell);
    }

    return SafeArea(
      top: false,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.7),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Container(
                width: 32,
                height: 4,
                margin: const EdgeInsets.only(top: 10, bottom: 8),
                decoration: BoxDecoration(color: t.lineStrong, borderRadius: BorderRadius.circular(3)),
              ),
            ),
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 12),
                children: [
                  for (final MapEntry(key: host, value: rows) in groups.entries) ...[
                    _header(t, machine(host)),
                    for (final cell in rows)
                      _SessionRow(
                        cell: cell,
                        active: cell.ref == current,
                        onTap: () {
                          Tactile.chose();
                          Navigator.of(context).pop(OpenSession(cell.ref));
                        },
                      ),
                  ],
                ],
              ),
            ),
            if (canStart) _newRow(context, t),
          ],
        ),
      ),
    );
  }

  Widget _header(AppTokens t, String name) => Padding(
        padding: const EdgeInsets.fromLTRB(20, 12, 20, 6),
        child: Text(
          name.toUpperCase(),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: t.mono.copyWith(fontSize: 11, letterSpacing: 1.1, color: t.faint),
        ),
      );

  Widget _newRow(BuildContext context, AppTokens t) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
        child: Semantics(
          button: true,
          label: 'New session',
          excludeSemantics: true,
          child: Material(
            color: t.raise2,
            borderRadius: BorderRadius.circular(12),
            child: InkWell(
              borderRadius: BorderRadius.circular(12),
              onTap: () {
                Tactile.chose();
                Navigator.of(context).pop(const StartSession());
              },
              child: SizedBox(
                height: 48,
                child: Center(
                  child: Text('+  New', style: t.ui.copyWith(fontSize: 14, color: t.text)),
                ),
              ),
            ),
          ),
        ),
      );
}

/// `[mark] Atlas            ● needs you` over the last line, mono.
class _SessionRow extends StatelessWidget {
  const _SessionRow({required this.cell, required this.active, required this.onTap});

  final Cell cell;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final p = CellPresentation.of(cell);
    final waiting = p.emphasised;

    return Semantics(
      selected: active,
      child: Material(
        color: active ? t.keyHi : Colors.transparent,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
            child: Row(
              children: [
                SizedBox.square(
                  dimension: 36,
                  child: Center(
                    child: RunnerMarkGlyph(
                      agentType: cell.agentType,
                      color: brandColorFor(cell.agentType) ?? t.dim,
                      size: 24,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              p.name,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: t.ui.copyWith(
                                fontSize: 14.5,
                                fontWeight: active ? FontWeight.w600 : FontWeight.w500,
                                color: waiting ? t.waiting : t.text,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Container(
                            width: 6,
                            height: 6,
                            decoration: BoxDecoration(
                              color: CellRow.dotColor(t, p.state, waiting),
                              borderRadius: BorderRadius.circular(3),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            p.state,
                            style: t.mono.copyWith(fontSize: 11, color: waiting ? t.waiting : t.muted),
                          ),
                        ],
                      ),
                      if (p.detail.isNotEmpty) ...[
                        const SizedBox(height: 3),
                        Text(
                          p.detail,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: t.mono.copyWith(fontSize: 11, color: t.muted),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
