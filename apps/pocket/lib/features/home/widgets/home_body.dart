import 'package:flutter/material.dart';

import '../../../models/cell.dart';
import '../../../models/host_id.dart';
import '../../shared/refreshable.dart';
import '../../shared/tactile.dart';
import '../composer_mode.dart';
import '../home_summary.dart';
import '../project_presentation.dart';
import 'cell_list.dart';
import 'project_header.dart';

/// Home with a project on it: title, agents, composer.
///
/// Split out of `HomeScreen` when that file crossed the 300-line limit `ADR-13` sets,
/// and the seam is the one the limit was pointing at rather than a place cut for the
/// sake of the count: the screen owns **state and policy** — which project is selected,
/// whether a dispatch is in flight, what a refresh reported — and this owns the
/// **arrangement**. Nothing here decides anything.
///
/// It sits beside `QuietProject` and `NothingYet`, which were already their own widgets
/// for the same reason. The three are the three answers to *what is on Home right now*,
/// and until this existed one of them was inline while the other two were not.
///
/// [composer] arrives built rather than as its ingredients: it needs `AgentRepository`
/// to know whether the target's host advertises `stt`, and a layout widget that held a
/// repository would be the thing ADR-13 no. 1 exists to prevent.
class HomeBody extends StatefulWidget {
  const HomeBody({
    required this.project,
    required this.cells,
    required this.isStale,
    required this.onRefresh,
    required this.onBack,
    required this.onOpenCell,
    required this.composer,
    required this.onClose,
    required this.canClose,
    required this.canStartAgent,
    this.isUnread,
    this.startAgent = false,
    super.key,
  });

  /// Finished since last opened — the row wears a background until it is.
  final bool Function(Cell cell)? isUnread;

  final ProjectPresentation project;

  /// This project's agents, in `FleetStore` order — waiting first (ADR-12 no. 1). The
  /// order is not re-derived here; this list and the Agent pager read the one the store
  /// already computed.
  final List<Cell> cells;

  /// The host stopped answering, so every row below is the last thing it said.
  final bool isStale;

  final Future<void> Function() onRefresh;
  /// Kembali ke indeks. Menggantikan pengalih: indeksnya **adalah** pengalihnya sekarang.
  final VoidCallback onBack;
  /// Opens the pager; `true` back means its Sessions sheet asked for a new agent
  /// (v4 tiket 08), which this list answers the way its own last row does.
  final Future<bool> Function(Cell cell) onOpenCell;

  /// Open already choosing a runner: the pager's `New`, reached from a pager that was not
  /// opened from this Home.
  final bool startAgent;

  /// Built here rather than handed in, because the mode it renders is this widget's
  /// own state — the list's last row is the other way into it. Still built *by the
  /// screen*, which is what keeps a repository out of a layout widget (ADR-13 no. 1).
  final Widget Function(ComposerMode mode) composer;

  /// Ends the cell and answers whether it ended. Runs its gate above this widget — nothing
  /// here holds a repository. The answer matters because a refused gate must leave the row
  /// exactly where it was.
  final Future<bool> Function(Cell cell) onClose;

  /// Whether this cell's host will end a cell at all, which decides if the control is
  /// drawn. Asked per cell rather than once, because a project can only live on one
  /// host today but the drawer should not be the thing that assumes it.
  final bool Function(Cell cell) canClose;

  /// Whether this project's host will start an agent at all.
  final bool canStartAgent;

  @override
  State<HomeBody> createState() => _HomeBodyState();
}

/// **Stateful for one reason: which lane is open is arrangement, not policy.**
///
/// It answers a question about this widget's own layout, it dies with the screen, and
/// nothing above needs it — so lifting it to `HomeScreen` would put a second kind of state
/// next to the one that matters there (which project, is a dispatch in flight).
class _HomeBodyState extends State<HomeBody> {
  /// The one row whose swipe action is showing. One at a time, so the list stays a list —
  /// the same rule the drawer followed before it.
  CellRef? _lane;

  /// Talking to an agent, or starting one. Shared with the composer below and with the
  /// last row of the list — the two ways into the same mode.
  final ComposerMode _mode = ComposerMode();

  @override
  void initState() {
    super.initState();
    // After the first frame: the composer listens for the summons, and must exist first.
    if (widget.startAgent && widget.canStartAgent) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _mode.summon();
      });
    }
  }

  /// The pager's `New` comes back here, and starts the same way the list's last row does.
  Future<void> _open(Cell cell) async {
    final startAgent = await widget.onOpenCell(cell);
    if (startAgent && mounted && widget.canStartAgent) _mode.summon();
  }

  @override
  void dispose() {
    _mode.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(HomeBody old) {
    super.didUpdateWidget(old);
    // Fleet snapshots land every few seconds, and one of them can carry away the agent whose
    // lane is open — it ended on its own, or the operator just closed it. A ref pointing at a
    // row that no longer exists would keep the next agent's lane open on its behalf.
    if (_lane != null && !widget.cells.any((c) => c.ref == _lane)) {
      _lane = null;
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      ProjectHeader(
        // The title and the index row that opens it read from the same rules, so they
        // cannot end up naming the same project two different ways.
        project: widget.project,
        summary: HomeSummary.of(widget.cells),
        onBack: widget.onBack,
        // Diteruskan hanya ketika kalimat basinya memang akan tampil, jadi kontrolnya tidak
        // pernah ada tanpa sebab yang tertulis di sebelahnya.
        onAskAgain: widget.project.isStale ? widget.onRefresh : null,
      ),
      Expanded(
        child: Refreshable(
          onRefresh: widget.onRefresh,
          child: CellList(
            cells: widget.cells,
            onOpen: _open,
            isStale: widget.isStale,
            openLane: _lane,
            onOpenLane: (ref, open) => setState(
              () => _lane = open ? ref : (_lane == ref ? null : _lane),
            ),
            onClose: widget.onClose,
            canClose: widget.canClose,
            isUnread: widget.isUnread,
            onStartAgent: widget.canStartAgent
                ? () {
                    setState(() => _lane = null);
                    Tactile.chose();
                    _mode.summon();
                  }
                : null,
          ),
        ),
      ),
      widget.composer(_mode),
    ],
  );
}
