import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/clock.dart';
import '../models/bootstrap.dart';
import '../models/cell.dart';
import '../models/host_event.dart';
import '../models/host_id.dart';
import '../models/server_event.dart';

/// The merged, ordered fleet — one list, owned in one place (ADR-12).
///
/// `§4.2` binds the Agent pager's order to Home's list order. Rather than trusting
/// two surfaces to sort identically, both read [cells] from here: there is only one
/// order because there is only one list.
class FleetStore extends ChangeNotifier {
  FleetStore(Stream<HostEvent> events, {this.now = systemClock}) {
    _subscription = events.listen(_onEvent);
  }

  /// Injected so a test can move time instead of waiting for it (ADR-13 no. 4).
  /// Defaulted rather than required because the great majority of this store's tests
  /// have no opinion about the clock, and making all of them say so would bury the
  /// few that do.
  final Clock now;

  late final StreamSubscription<HostEvent> _subscription;

  /// Kept per host so one host's snapshot never erases another's — and so a host
  /// going quiet can be marked without dropping what it last told us.
  final Map<HostId, List<Cell>> _byHost = {};
  final Set<HostId> _stale = {};

  /// When each host last spoke — see [lastHeardFrom] for why it outlives staleness.
  final Map<HostId, DateTime> _heard = {};

  /// What each host says **exists**, as opposed to what is running (ADR-14). Kept
  /// per host for the same reason cells are: one machine going quiet must not erase
  /// another machine's projects.
  final Map<HostId, List<HostProject>> _projectsByHost = {};

  /// What each host says it can launch. Per host for the same reason as everything
  /// else here: a VPS and a laptop do not have the same CLIs on them.
  final Map<HostId, List<HostRunner>> _runnersByHost = {};

  List<Cell> _ordered = const [];

  /// Every cell from every paired host, ordered. Safe to hand to a widget: the list
  /// is replaced on change, never mutated in place.
  List<Cell> get cells => _ordered;

  bool isStale(HostId host) => _stale.contains(host);

  /// The cell behind a pane id from a push — which names no host, so every host is
  /// searched. `endsWith` too: the host matches a bare uuid against its prefixed pane
  /// id the same way, and the phone should not have to learn the desktop's spelling.
  Cell? cellForPane(String paneId) {
    if (paneId.isEmpty) return null;
    for (final cell in _ordered) {
      if (cell.paneId == paneId || cell.paneId.endsWith(paneId)) return cell;
    }
    return null;
  }

  /// When this host last said anything, or null if it never has.
  ///
  /// **Added 2026-08-09 to turn a bool into a fact.** [isStale] can say *this machine
  /// stopped answering*; until now nothing could say *when*, so Home's unreachable
  /// notice had to be written without an age — and inventing one on the single line
  /// whose job is to say **do not trust what is below me** would have been the exact
  /// lie it exists to prevent.
  ///
  /// Stamped in [adopt], which is the honest place: that is the one method both live
  /// paths funnel through — `fleet.changed` over the socket and `GET /m/bootstrap` on
  /// a cold start or a manual refresh — so this is *heard from*, not *dialled* or
  /// *believed reachable*.
  ///
  /// Deliberately **not** cleared by [markUnreachable]. A host going quiet is the
  /// moment this becomes interesting; wiping it then would answer "when did we last
  /// hear from it" with silence exactly when it is asked.
  DateTime? lastHeardFrom(HostId host) => _heard[host];

  /// How long this host has been silent, or null when it has never spoken.
  ///
  /// Offered next to [lastHeardFrom] because every caller wants the difference rather
  /// than the instant, and computing it here means one clock reads it — a widget doing
  /// `DateTime.now()` itself would be a second, untestable time source.
  Duration? silenceOf(HostId host) {
    final heard = _heard[host];
    return heard == null ? null : now().difference(heard);
  }

  /// Cells in one project. Home shows exactly one of these (ADR-3, second revision).
  ///
  /// Keyed by [ProjectRef], not by name: two hosts can each run a `CNVS`, and the
  /// label collides where the identity does not (R-10).
  List<Cell> inProject(ProjectRef project) =>
      _ordered.where((c) => c.project == project).toList(growable: false);

  /// Waiting agents that the current project's list cannot show.
  ///
  /// This is what the `elsewhere` row renders, and it exists because the earlier
  /// per-host design let a waiting agent hide behind a switcher — the one thing the
  /// design says must never happen.
  ///
  /// Compared by [ProjectRef] for that same reason, and it is not a nicety: while
  /// viewing `CNVS · vps`, comparing on the name alone would exclude a waiting cell in
  /// `CNVS · mac` from this list *and* from the on-screen one, which is the exact
  /// disappearance this row exists to prevent.
  List<Cell> waitingOutside(ProjectRef project) => _ordered
      .where((c) => c.project != project && c.needsInput)
      .toList(growable: false);

  /// Every project that currently has a cell, in list order.
  ///
  /// The switcher's per-project counts are **not** a second accessor here: it draws
  /// a row per project through [inProject], and that one list already carries the
  /// waiting count, the total, and the project's label. A dedicated counter would
  /// have answered a third of the question and been read alongside this one anyway.
  List<ProjectRef> get runningProjects {
    final seen = <ProjectRef>{};
    return _ordered.map((c) => c.project).where(seen.add).toList(growable: false);
  }

  /// Every project the phone can select — **running first, then dormant** (ADR-14).
  ///
  /// Running projects keep fleet order, so the first entry still holds the most
  /// urgent cell in the whole fleet and Home's fallback still lands where the
  /// operator is needed. Dormant ones follow, most recently opened first, because
  /// the only ordering fact a closed project has is when it was last touched.
  ///
  /// This used to be derived from cells alone, and that is precisely the bug: a
  /// project vanished from the phone the moment its last agent ended, leaving the
  /// desktop as the only way back to it.
  List<ProjectRef> get projects {
    final running = runningProjects;
    final seen = running.toSet();
    final dormant = _catalog.where((p) => seen.add(p.project)).toList()
      ..sort((a, b) {
        final byRecency = b.lastOpenedAt.compareTo(a.lastOpenedAt);
        return byRecency != 0 ? byRecency : a.name.compareTo(b.name);
      });
    return List.unmodifiable([...running, ...dormant.map((p) => p.project)]);
  }

  /// What the host said about this project — its name and its path. Null for a
  /// project the phone only knows through its cells, which is what a host older
  /// than `projects[]` produces.
  HostProject? infoFor(ProjectRef project) {
    for (final candidate in _catalog) {
      if (candidate.project == project) return candidate;
    }
    return null;
  }

  /// Nothing is running here. Not the same as "unknown": a dormant project is one
  /// the host still lists, and the switcher shows it as a row rather than dropping it.
  bool isDormant(ProjectRef project) => inProject(project).isEmpty;

  /// Every project every paired host holds, in no particular order — [projects]
  /// owns ordering.
  List<HostProject> get _catalog =>
      _projectsByHost.values.expand((list) => list).toList(growable: false);

  /// What [host] can start, or empty when it never said. Empty is a real answer here
  /// and the caller is expected to fall back rather than draw an empty picker.
  List<HostRunner> runnersOn(HostId host) => _runnersByHost[host] ?? const [];

  /// Takes one host's runner registry, entire. Replacement, not merge: a runner the
  /// operator deleted in Settings is gone, and offering it would be a command this
  /// machine no longer has.
  void adoptRunners(HostId host, List<HostRunner> runners) {
    _runnersByHost[host] = List.unmodifiable(runners);
    notifyListeners();
  }

  /// Takes one host's project registry, entire — the same replacement semantics
  /// [adopt] uses for cells, and for the same reason: a project the host stopped
  /// listing has been closed, and keeping it would leave a row that goes nowhere.
  void adoptProjects(HostId host, List<HostProject> projects) {
    _projectsByHost[host] = List.unmodifiable(projects);
    notifyListeners();
  }

  /// A host is no longer paired — drop everything it ever said.
  ///
  /// The opposite of [markUnreachable], and the distinction is the whole reason
  /// both exist. A machine that is asleep keeps its cells: they are still true,
  /// and a fleet that empties itself reads as "all my work is gone" (R-9). A
  /// machine that has been unpaired has no such claim — the phone cannot reach
  /// it, cannot refresh it, and cannot open anything on it, so every row it left
  /// behind is a row that goes nowhere.
  ///
  /// Without this the entries simply stayed: `_byHost` and `_projectsByHost` had
  /// no removal path at all, so an unpaired machine's projects sat in the
  /// switcher until the process was killed.
  void forget(HostId host) {
    final hadCells = _byHost.remove(host) != null;
    final hadProjects = _projectsByHost.remove(host) != null;
    final wasStale = _stale.remove(host);
    // Unpaired, so even *when we last heard from it* is no longer this phone's
    // business — unlike `markUnreachable`, which keeps it precisely to report it.
    _heard.remove(host);
    if (!hadCells && !hadProjects && !wasStale) return;
    _ordered = _merge();
    notifyListeners();
  }

  /// A host stopped answering. Its cells stay on screen, marked stale.
  ///
  /// Dropping them would be worse than showing something old: a fleet that suddenly
  /// empties reads as "all my work is gone" (R-9).
  void markUnreachable(HostId host) {
    if (_stale.add(host)) notifyListeners();
  }

  /// Takes one host's full cell list, from wherever it came.
  ///
  /// Both paths lead here on purpose: `fleet.changed` over the socket, and the cold
  /// start's `GET /m/bootstrap` (ADR-12 no. 3). They carry the same thing — this
  /// host's cells, entire — so merging and ordering must not be written twice. The
  /// list is a **replacement**, never a merge into the previous one: a cell that
  /// disappeared from the host's list is gone, and an append would keep a ghost on
  /// screen that the operator can still tap.
  void adopt(HostId host, List<Cell> cells) {
    _byHost[host] = cells;
    _stale.remove(host); // It just spoke, so it is reachable by definition.
    // …and this is when. Same statement as the line above, kept as a time rather than
    // as a flag — see [lastHeardFrom].
    _heard[host] = now();
    _ordered = _merge();
    notifyListeners();
  }

  void _onEvent(HostEvent hostEvent) {
    final (host, event) = hostEvent;
    if (event is! FleetChangedEvent) return;
    adopt(host, event.cells);
  }

  /// Waiting first, then error, then everything quiet — the only two states allowed
  /// to shout (MVP.md).
  ///
  /// Within a group the order is by host then pane id, which is **stable by
  /// construction**. That is the requirement, not a preference: a list that reorders
  /// itself between three-second snapshots moves the pager's targets while the
  /// operator's thumb is already moving.
  List<Cell> _merge() {
    final seen = <CellRef>{};
    final all = _byHost.entries
        .expand((entry) => entry.value)
        // One pane, one row. A host builds its list from several surfaces — the boards on
        // screen, the panes still running behind boards that are not, the swarm — and
        // nothing downstream of that join guarantees a pane appears in exactly one of
        // them. A duplicate is not cosmetic here: two rows for one agent make the pager
        // count wrong and give the operator two targets that are the same process.
        //
        // **First wins, and that is a decision.** The host emits its live surfaces before
        // its remembered ones, so the earlier entry is the one carrying this second's
        // status rather than whatever was true when a board was last on screen.
        .where((cell) => seen.add(cell.ref))
        .toList(growable: false)
      ..sort((a, b) {
        final byUrgency = _urgency(a).compareTo(_urgency(b));
        if (byUrgency != 0) return byUrgency;
        final byHost = a.host.value.compareTo(b.host.value);
        return byHost != 0 ? byHost : a.paneId.compareTo(b.paneId);
      });
    return List.unmodifiable(all);
  }

  static int _urgency(Cell cell) {
    if (cell.needsInput) return 0;
    if (cell.turn == 'error') return 1;
    return 2;
  }

  @override
  void dispose() {
    _subscription.cancel();
    super.dispose();
  }
}
