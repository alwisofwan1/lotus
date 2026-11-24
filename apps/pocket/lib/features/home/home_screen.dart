import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/agent_repository.dart';
import '../../data/dictation.dart';
import '../../data/fleet_repository.dart';
import '../../data/fleet_store.dart';
import '../../data/seen_marks.dart';
import '../../models/cell.dart';
import '../../models/host_id.dart';
import '../shared/refresh_notice.dart';
import '../shared/agent_mutations.dart';
import 'composer_mode.dart';
import 'project_presentation.dart';
import 'widgets/home_body.dart';
import 'widgets/home_composer.dart';
import 'widgets/spawn_controls.dart';
import 'widgets/quiet_project.dart';
import 'spawn_choice.dart';
import 'spawn_flow.dart';

/// Home: one project's agents, and what is waiting outside it.
///
/// Answers one question — *what is happening, and what do I need to do?* — which is why
/// there is no tab bar and no navigation chrome (`MVP.md`). Everything it renders comes
/// from [FleetStore]; it holds no data beyond which project is on screen, and decides no
/// policy (ADR-13 no. 1).
class HomeScreen extends StatefulWidget {
  const HomeScreen({
    required this.fleet,
    required this.project,
    required this.hostLabel,
    required this.onOpenCell,
    required this.onBack,
    required this.onRefresh,
    required this.agents,
    this.dictation,
    this.seen,
    this.startAgent = false,
    super.key,
  });

  /// Which project is on screen. **Passed in, never chosen here** since 2026-08-11: the root
  /// is now the project index, so “which project” is a fact about the route rather than state
  /// this screen keeps. What went with it: the remembered selection, the fallback to
  /// `projects.first`, and the switcher sheet — three mechanisms that existed only because a
  /// screen with no route had to answer the question itself.
  final ProjectRef project;

  final FleetStore fleet;

  /// Resolves a host's name. A function rather than the registry: this screen needs one
  /// string, and taking the registry would drag socket lifecycle into a title test.
  final String Function(HostId host) hostLabel;

  /// Opens the agent pager; answers whether its Sessions sheet asked for a new agent.
  final Future<bool> Function(Cell cell) onOpenCell;

  /// Open already choosing a runner — see `HomeBody.startAgent`.
  final bool startAgent;

  /// Back to the index. Routing belongs to `app/`, so this screen reports the gesture and
  /// decides nothing about what happens.
  final VoidCallback onBack;

  /// Re-dials every socket and re-reads every host (`FleetRepository.refreshAll`).
  /// Required, not optional: a refresh a call site can omit is one it will omit.
  final Future<HydrationReport> Function() onRefresh;

  /// The only path to a mutation. Taken whole rather than as callbacks: `AgentRepository`
  /// is where the biometric gate and the freshness check live (ADR-8, ADR-12 no. 2), and
  /// callbacks would invite a second path that skips them.
  final AgentRepository agents;

  /// Null in a build with no microphone — see [HomeComposer.dictation].
  final Dictation? dictation;

  /// Which agents finished since they were last opened. Null draws no marks at all.
  final SeenMarks? seen;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  @override
  void initState() {
    super.initState();
    widget.seen?.addListener(_onSeen);
  }

  @override
  void didUpdateWidget(HomeScreen old) {
    super.didUpdateWidget(old);
    if (old.seen != widget.seen) {
      old.seen?.removeListener(_onSeen);
      widget.seen?.addListener(_onSeen);
    }
  }

  @override
  void dispose() {
    widget.seen?.removeListener(_onSeen);
    super.dispose();
  }

  /// A mark changed — the operator opened an agent — so the row it belongs to goes
  /// plain now, not at the next fleet snapshot up to three seconds later.
  void _onSeen() {
    if (mounted) setState(() {});
  }

  /// Who the composer is aimed at, once the operator has chosen. Null means "whoever
  /// the list puts first", which is the waiting agent — see [_target].
  CellRef? _targetRef;

  /// Tujuan yang dibekukan selama ada teks di composer.
  ///
  /// **Ini menutup salah-kirim yang nyata, bukan yang dibayangkan.** `revamp-audit.html`
  /// §9 no. 4 mencatatnya sebagai hipotesis; tesnya membuktikannya pada 2026-08-12.
  /// Mekanismenya: selama operator belum memilih, tujuan default adalah `cells.first`, dan
  /// `FleetStore` mengurutkan menunggu-dulu (ADR-12 no. 1) — jadi satu snapshot, yang datang
  /// tiap tiga detik, bisa menukar tujuan **di tengah operator mengetik**. Ia melihat
  /// `→ Atlas`, menekan kirim, dan kalimatnya mendarat di pane lain.
  ///
  /// Dibekukan hanya selama ada teks, bukan selamanya: pada field kosong default
  /// menunggu-dulu itu justru yang membuat kasus umum jadi ketik-lalu-kirim tanpa satu
  /// ketukan memilih. Ada tes untuk kedua sisinya.
  CellRef? _typingAt;

  /// In flight, so one gesture cannot become two — a dispatch, and a refresh.
  bool _sending = false;
  bool _refreshing = false;

  /// How Home spells a mutation: reason string, notice, haptic, written once so the
  /// composer and the drawer cannot word the same act two ways.
  late final AgentMutations _mutations = AgentMutations(widget.agents);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: widget.fleet,
          builder: (context, _) => _body(context),
        ),
      ),
    );
  }

  /// Runs the refresh and says only what went wrong. Guarded against overlap: it is
  /// reachable from the list, both empty states, and a host reconnecting on its own.
  Future<void> _refresh() async {
    if (_refreshing) return;
    _refreshing = true;
    try {
      final report = await widget.onRefresh();
      if (!mounted) return;
      showRefreshOutcome(context, report, label: widget.hostLabel);
    } finally {
      _refreshing = false;
    }
  }

  Widget _body(BuildContext context) {
    final project = widget.project;
    final cells = widget.fleet.inProject(project);
    final canStart = widget.agents.canSpawnOn(project.host);

    // A real project with nothing running in it. Since ADR-14 that is a fact about a healthy
    // machine, not a fault — so it never points at Diagnostics.
    if (cells.isEmpty) {
      return QuietProject(
        project: _present(project),
        onBack: widget.onBack,
        onRefresh: _refresh,
        composer: canStart ? (mode) => _composer(project, cells, mode) : null,
      );
    }

    return HomeBody(
      project: _present(project),
      cells: cells,
      isUnread: (cell) => widget.seen?.isUnread(cell) ?? false,
      isStale: widget.fleet.isStale(project.host),
      onRefresh: _refresh,
      onBack: widget.onBack,
      onOpenCell: widget.onOpenCell,
      startAgent: widget.startAgent,
      onClose: _close,
      canClose: (cell) => widget.agents.canCloseOn(cell.host), // ADR-14
      canStartAgent: canStart,
      composer: (mode) => _composer(project, cells, mode),
    );
  }

  /// Who the composer is aimed at: the chosen cell while it is still in this project's
  /// list, otherwise the first — which `FleetStore` makes the waiting one (ADR-12 no. 1).
  /// The fallback is not cosmetic: the selection survives snapshots arriving every three
  /// seconds, and must not survive a switch to a project the target does not live in.
  Cell _target(List<Cell> cells) {
    final chosen = _targetRef ?? _typingAt;
    if (chosen == null) return cells.first;
    return cells.firstWhere((c) => c.ref == chosen, orElse: () => cells.first);
  }

  /// Sends to the chosen agent, through the one path that runs the gate. Answers
  /// whether the words landed — see [AgentMutations.dispatch].
  Future<bool> _dispatch(Cell target, String text) =>
      _run(() => _mutations.dispatch(context, target, text));

  /// Starts an agent in the project on screen. Passed rather than re-read, so it lands
  /// where the operator was looking even if a snapshot moves the selection mid-gate.
  /// Memulai agen di proyek yang di layar, lalu menonton ia lahir ([startAgentAndWatch]).
  /// Proyeknya diteruskan, bukan dibaca ulang: ia harus mendarat di tempat operator melihat
  /// meski snapshot memindahkan pilihan di tengah gerbang.
  Future<bool> _startAgent(ProjectRef project, SpawnChoice choice, String? brief) =>
      startAgentAndWatch(
        context,
        fleet: widget.fleet,
        project: project,
        shown: _present(project),
        choice: choice,
        brief: brief,
        mutations: _mutations,
        guard: _run,
      );

  Future<bool> _close(Cell cell) => _run(() => _mutations.close(context, cell));

  /// The one composer, for both bodies. A project with no agents gets the same control
  /// with a null target, which is what puts a way out on the screen that had none.
  Widget _composer(ProjectRef project, List<Cell> cells, ComposerMode mode) {
    final target = cells.isEmpty ? null : _target(cells);
    return HomeComposer(
      target: target,
      cells: cells,
      mode: mode,
      onPickTarget: (ref) => setState(() => _targetRef = ref),
      // Yang dilihat operator saat ia mulai mengetik adalah ke mana kalimatnya pergi.
      onComposing: (composing) =>
          setState(() => _typingAt = composing ? target?.ref : null),
      onSend: (text) =>
          target == null ? Future.value(false) : _dispatch(target, text),
      onStartAgent: (choice, brief) => _startAgent(project, choice, brief),
      canStartAgent: widget.agents.canSpawnOn(project.host),
      runners: widget.fleet
          .runnersOn(project.host)
          // Headless is a fact about this host *and* this runner, and the host now states
          // both: `structured-spawn` in its caps, and `headless` per runner. Reading the
          // second instead of guessing it is what lets a runner arrive without an app update.
          .map((r) => SpawnRunner.of(r,
              headless: widget.agents.canRunHeadlessOn(project.host) && r.headless))
          .toList(growable: false),
      projectPath: _present(project).path,
      dictation: widget.agents.canDictateOn(project.host)
          ? widget.dictation
          : null,
      dictateOn: project.host,
      enabled: !_sending,
    );
  }

  /// One gesture at a time, and whether it went through. The drawer and the composer
  /// are two entrances to one repository; one flag between them is what keeps a double
  /// tap from becoming two mutations.
  Future<bool> _run(Future<bool> Function() go) async {
    if (_sending) return false;
    setState(() => _sending = true);
    final done = await go();
    if (!mounted) return false;
    setState(() => _sending = false);
    return done;
  }

  ProjectPresentation _present(ProjectRef project) => presentProject(
    widget.fleet,
    project,
    hostLabel: widget.hostLabel(project.host),
  );
}
