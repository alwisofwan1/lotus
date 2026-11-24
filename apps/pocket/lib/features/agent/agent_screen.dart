import 'package:flutter/material.dart';

import '../../app/theme/app_tokens.dart';
import '../../data/agent_repository.dart';
import '../../data/dictation.dart';
import '../../data/fleet_store.dart';
import '../../data/live_conversation.dart';
import '../../data/transcript_pager.dart';
import '../../data/draft_keeper.dart';
import '../../data/snippets.dart';
import '../../models/host_id.dart';
import '../shared/tactile.dart';
import 'agent_page.dart';
import 'widgets/sessions_sheet.dart';

/// The agent pager — swipe left and right instead of going home to switch.
///
/// **The order is Home's order** (`MVP.md`), which costs nothing to guarantee because
/// `FleetStore` computes it once and both surfaces read the same list (ADR-12 no. 1). So
/// right always means "next, less urgent"; a pager without a meaningful order is a lottery.
///
/// **And it is Home's *list*, not merely Home's ordering.** That sentence used to be
/// false in the second half: this screen read `fleet.cells` — every pane on every host in
/// every project — while Home draws `fleet.inProject` (ADR-3, second revision: Home shows
/// exactly one project). So a project holding one agent still paged into other projects'
/// agents, and the pips claimed three where the operator had one. Reported 2026-08-09 on a
/// `codespace-demo` with a single agent that swiped straight into `Atlas`.
///
/// [project] is therefore required rather than inferred. Passing it explicitly is what
/// stops the two surfaces from ever answering "which agents are these" differently: Home
/// hands over the cell it drew, and the cell carries the project it belongs to.
class AgentScreen extends StatefulWidget {
  const AgentScreen({
    required this.fleet,
    required this.repository,
    required this.live,
    required this.pager,
    required this.initial,
    required this.hostLabel,
    required this.project,
    required this.snippets,
    required this.drafts,
    this.dictation,
    super.key,
  });

  final FleetStore fleet;
  final AgentRepository repository;

  /// Handed straight through to every page in the pager — the terminal's palette reads
  /// it, keyed by the cell's own host.
  final Snippets snippets;

  /// Passed straight through to each page — a draft belongs to one agent, and this screen
  /// is only the thing that pages between them.
  final DraftKeeper drafts;

  /// The microphone, or null in a build without one. Handed straight through to the
  /// composer on every page in the pager.
  final Dictation? dictation;

  /// Chat's transcript, following the socket.
  ///
  /// **This screen owns it** (`issues/12`). Pages read it and never point it: a
  /// `PageView` has two live pages during a swipe, and when each one drove the store
  /// from its own `initState`/`dispose` the outgoing page's teardown wiped the incoming
  /// page's transcript — leaving the operator on the right agent with an empty Chat and
  /// no way back except going to Home. One writer removes the question.
  final LiveConversation live;

  /// Walks a cell's transcript backwards as the operator scrolls up (Fase 3). Owned
  /// above the pager widget for the same reason [live] is: cursors must survive a swipe.
  final TranscriptPager pager;

  /// Resolves a host's operator-facing name — `CompositionRoot.hostLabel`, the one rule
  /// Home and the switcher already share. Handed down rather than re-derived so this
  /// screen cannot become the copy that disagrees.
  final String Function(HostId host) hostLabel;

  /// The cell the operator tapped on Home.
  final CellRef initial;

  /// Which project's agents this pager may reach — the one Home was showing, taken from
  /// the tapped cell so the two cannot disagree.
  final ProjectRef project;

  @override
  State<AgentScreen> createState() => _AgentScreenState();
}

class _AgentScreenState extends State<AgentScreen> {
  /// The order and membership of the pager, **frozen when it opened**.
  ///
  /// Deliberate, and the one place this screen departs from following the store live.
  /// `FleetStore` re-sorts when a cell starts waiting, and a list that reorders itself
  /// between three-second snapshots moves the pager's targets while the operator's thumb
  /// is already moving — `FleetStore` says exactly that about its own ordering. Cell
  /// *contents* still update live, because each page looks its cell up by ref on every
  /// build; only what is reachable by swiping stays put. A cell that appears while this is
  /// open shows up on Home, which is where the operator is choosing from anyway.
  late final List<CellRef> _refs;
  late final PageController _controller;

  /// Which page is current. Read only by [_windowAt] — see [_pager] for why a swipe
  /// deliberately does not `setState`.
  late int _index;

  /// [_index] as something a page can listen to. It is what decides who tails the host's
  /// output — read by pages themselves, so a swipe still needs no `setState` here.
  late final ValueNotifier<int> _active;

  @override
  void initState() {
    super.initState();
    final cells = widget.fleet.inProject(widget.project);
    _refs = cells.map((c) => c.ref).toList(growable: false);
    _index = _refs.indexOf(widget.initial);
    if (_index < 0) _index = 0;
    _controller = PageController(initialPage: _index);
    _active = ValueNotifier(_index);
    // Before the first page is built, so the transcript is already collecting when
    // that page's read goes out. `AgentPage` used to do this for itself, which is the
    // defect `issues/12` names.
    widget.live.follow(_windowAt(_index));
  }

  @override
  void dispose() {
    widget.live.forget();
    _controller.dispose();
    _active.dispose();
    super.dispose();
  }

  /// The cells the viewport can **build** while sitting on page [i].
  ///
  /// Not "what one gesture can reach", and the difference is measured rather than
  /// reasoned: with [PageView.allowImplicitScrolling] the cache is one viewport wide on
  /// each side, so a drag away from `i` lays out `i+2` **before** `onPageChanged` commits
  /// `i+1`. A ±1 window left that page's read arriving at a cell nothing was collecting
  /// for, and it rendered *"Nothing recorded for this agent yet"* — the same empty Chat
  /// this issue exists to remove, one page further along.
  ///
  /// So the rule is: follow every page that can exist, not every page that can be
  /// arrived at. This is the single place the bound is named; `LiveConversation.maxCells`
  /// is the same fact stated as a ceiling.
  static const int _reach = 2;

  List<CellRef> _windowAt(int i) => [
        for (var at = i - _reach; at <= i + _reach; at++)
          if (at >= 0 && at < _refs.length) _refs[at],
      ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        // The page paints the status bar itself, so Terminal's ground can reach the top of
        // the glass (v4 tiket 03) — see `AgentPage.build`.
        top: false,
        // Listens so a cell's own fields — its turn, its preview — stay current while the
        // page is open, without the set of pages changing underneath the gesture.
        child: ListenableBuilder(
          listenable: widget.fleet,
          builder: (context, _) => _pager(context),
        ),
      ),
    );
  }

  Widget _pager(BuildContext context) {
    if (_refs.isEmpty) return _gone(context);

    final byRef = {for (final cell in widget.fleet.inProject(widget.project)) cell.ref: cell};
    // Amber pips for agents that are waiting, so the pager shows where you are needed
    // before you swipe there.
    final waitingAt = <int>{
      for (var i = 0; i < _refs.length; i++)
        if (byRef[_refs[i]]?.needsInput ?? false) i,
    };

    return PageView.builder(
      controller: _controller,
      itemCount: _refs.length,
      allowImplicitScrolling: true,
      // A swipe lands on a different agent, which is a selection change like any
      // other — and the one case where the operator's eyes may still be on the
      // gesture rather than on the header that just changed.
      //
      // **No `setState`, and that is not an oversight.** Nothing this method builds
      // depends on which page is current: each page is handed its own `i`, and the pips
      // come from the fleet. The old `setState` rebuilt the whole pager on every swipe
      // for a field no build read. What does need to redraw is Chat, and `follow`
      // notifies the store the pages are listening to — from a scroll callback, which
      // is outside anyone's build.
      onPageChanged: (i) {
        Tactile.chose();
        _index = i;
        _active.value = i;
        widget.live.follow(_windowAt(_index));
      },
      itemBuilder: (context, i) {
        final cell = byRef[_refs[i]];
        if (cell == null) return _gone(context);
        return AgentPage(
          cell: cell,
          repository: widget.repository,
          live: widget.live,
          pager: widget.pager,
          snippets: widget.snippets,
          drafts: widget.drafts,
          dictation: widget.dictation,
          index: i,
          total: _refs.length,
          active: _active,
          waitingAt: waitingAt,
          hostLabel: widget.hostLabel(cell.host),
          onBack: () => Navigator.of(context).maybePop(),
          onSessions: () => _sessions(context),
        );
      },
    );
  }

  /// The dock's Sessions sheet (v4 tiket 08): the pager's own agents, in the pager's order.
  ///
  /// A row jumps the pager — a swipe without the swiping, so `onPageChanged` moves the
  /// tail and the transcript exactly as a swipe would. `New` closes the pager with `true`:
  /// starting an agent is Home's flow (runner sheet, gate, the wait for it to appear), and
  /// whoever pushed this screen takes it from there rather than this screen growing a copy.
  Future<void> _sessions(BuildContext context) async {
    final byRef = {for (final cell in widget.fleet.inProject(widget.project)) cell.ref: cell};
    final choice = await showSessionsSheet(
      context,
      cells: [for (final ref in _refs) ?byRef[ref]],
      current: _refs[_index],
      machine: widget.hostLabel,
      canStart: widget.repository.canSpawnOn(widget.project.host),
    );
    if (!context.mounted) return;
    switch (choice) {
      case OpenSession(:final ref):
        final i = _refs.indexOf(ref);
        if (i >= 0 && i != _index) _controller.jumpToPage(i);
      case StartSession():
        Navigator.of(context).pop(true);
      case null:
    }
  }

  /// The cell left the fleet while this page was open — it exited, or its host went away.
  ///
  /// Shown rather than skipped: silently removing a page would slide the operator onto a
  /// different agent mid-gesture, which is the same class of surprise the frozen order
  /// exists to prevent.
  Widget _gone(BuildContext context) {
    final t = context.tokens;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'This agent is no longer in the fleet.',
              textAlign: TextAlign.center,
              style: t.ui.copyWith(fontSize: 13, color: t.muted),
            ),
            const SizedBox(height: 14),
            TextButton(
              onPressed: () => Navigator.of(context).maybePop(),
              child: Text(
                'BACK',
                style: t.mono.copyWith(fontSize: 11, letterSpacing: 1.47, color: t.dim),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
