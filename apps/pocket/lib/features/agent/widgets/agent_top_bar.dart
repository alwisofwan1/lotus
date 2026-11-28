import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../models/cell.dart';
import '../../shared/back_glyph.dart';
import '../../shared/cell_actions.dart';
import '../page_mode.dart';
import 'top_bar_title.dart';
import 'view_switch.dart';

/// The agent page's header, in one row: `‹ · Atlas ▾ / ● working 2m · CNVS · Chat|Terminal`.
///
/// Replaces `AgentHeader` and `AgentPageBar` (v4 tiket 03), which spent three rows and
/// ±90px on identity, context and activity. The ranking survived; the rows did not.
/// Identity and live state share the title block, context and actions moved behind the
/// title's `▾`, and the row's right end holds the switch — the one control every visit
/// to this page might want.
///
/// `‹` **always leaves the page.** It never means *back to Chat*: that is the switch's
/// job, and system back's (`PageMode.back`). One glyph with two meanings depending on a
/// state nobody labelled is the ambiguity the sheet was first built to avoid.
class AgentTopBar extends StatefulWidget {
  const AgentTopBar({
    required this.cell,
    required this.index,
    required this.total,
    required this.waitingAt,
    required this.hostLabel,
    required this.shown,
    required this.onBack,
    this.onShow,
    this.actions,
    this.changedFiles,
    this.onOpenChanges,
    this.done = false,
    super.key,
  });

  /// The operator marked the agent Done; the status line says so.
  final bool done;

  final Cell cell;
  final int index;
  final int total;
  final Set<int> waitingAt;

  /// This cell's machine, **already qualified** by `CompositionRoot.hostLabel` — empty
  /// when it distinguishes nothing, so this screen cannot be the one that disagrees.
  final String hostLabel;

  final AgentSurface shown;

  /// Null while there is no terminal to show — the read failed, or has not landed — which
  /// keeps a switch that would open a pane for an unreachable host off the bar.
  final ValueChanged<AgentSurface>? onShow;

  final VoidCallback onBack;

  /// What this agent can be told to do. Here so no action is reachable from only one
  /// screen: an operator inside an agent should not have to go back to the list to stop
  /// it. Null leaves the title without a drawer.
  final CellActionHandlers? actions;

  final int? changedFiles;
  final VoidCallback? onOpenChanges;

  @override
  State<AgentTopBar> createState() => _AgentTopBarState();
}

/// Stateful for the same reason `HomeBody` is: whether the drawer is open, and whether
/// it is asking, are facts about this surface and die with it.
class _AgentTopBarState extends State<AgentTopBar> {
  bool _open = false;
  bool _confirming = false;

  void _toggle() => setState(() {
        _open = !_open;
        _confirming = false;
      });

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final actions = widget.actions;
    final onShow = widget.onShow;
    final onTerminal = widget.shown == AgentSurface.terminal;

    return AnimatedContainer(
      duration: const Duration(milliseconds: 180),
      curve: Curves.easeOutQuart,
      // The terminal's ground follows it up into the header, so Terminal reads as one
      // dark surface rather than a pane with the page's chrome on top.
      color: onTerminal ? t.termBg : t.bg,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(2, 5, 12, 5),
            child: Row(
              children: [
                BackGlyph(onTap: widget.onBack),
                Expanded(
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: TopBarTitle(
                      cell: widget.cell,
                      index: widget.index,
                      total: widget.total,
                      waitingAt: widget.waitingAt,
                      open: _open,
                      done: widget.done,
                      onTap: actions == null ? null : _toggle,
                    ),
                  ),
                ),
                // On Chat the switch sits by the composer, near the thumb.
                if (onShow != null && onTerminal) ...[
                  const SizedBox(width: 8),
                  ViewSwitch(shown: widget.shown, onShow: onShow),
                ],
                // On Terminal the switch takes this place; the title still opens the actions.
                if (actions != null && !onTerminal)
                  IconButton(
                    tooltip: 'More actions',
                    onPressed: _toggle,
                    icon: Text('⋯', style: t.ui.copyWith(fontSize: 20, color: t.muted, height: 1)),
                  ),
              ],
            ),
          ),
          if (actions != null)
            AnimatedSize(
              duration: const Duration(milliseconds: 240),
              curve: Curves.easeOutCubic,
              alignment: Alignment.topCenter,
              child: _open ? _drawer(actions) : const SizedBox(width: double.infinity),
            ),
          Container(height: 1, color: t.line),
        ],
      ),
    );
  }

  /// Context first, then verbs — indented to the title, which is what both describe.
  Widget _drawer(CellActionHandlers actions) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: _indent, right: 12),
              child: TopBarContext(
                cell: widget.cell,
                hostLabel: widget.hostLabel,
                changedFiles: widget.changedFiles,
                onOpenChanges: widget.onOpenChanges,
              ),
            ),
            const SizedBox(height: 8),
            CellActions(
              cell: widget.cell,
              handlers: actions,
              confirmingClose: _confirming,
              onAskClose: () => setState(() => _confirming = true),
              onCancelClose: () => setState(() => _confirming = false),
              indent: _indent,
            ),
          ],
        ),
      );

  /// Back's 44px plus the row's 2px lead: where the title starts.
  static const double _indent = kMinHitTarget + 4;
}
