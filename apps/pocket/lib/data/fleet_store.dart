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

  /// Every host that stopped answering, for the one capsule that says so on Home.
  List<HostId> get staleHosts => List.unmodifiable(_stale);

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

  /// Keep the last-heard timestamp when unreachable so stale data has an age.
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

  /// Compare full project identities so same-named projects on different hosts do not hide waiting cells.
  List<Cell> waitingOutside(ProjectRef project) => _ordered
      .where((c) => c.project != project && c.needsInput)
      .toList(growable: false);

  /// Reuse per-project lists for counts and labels.
  List<ProjectRef> get runningProjects {
    final seen = <ProjectRef>{};
    return _ordered.map((c) => c.project).where(seen.add).toList(growable: false);
  }

  /// Keep running projects first and dormant projects selectable (ADR-14).
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

  /// Remove unpaired hosts while retaining unreachable hosts as stale (R-9).
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

  /// Replace each host snapshot so removed cells do not remain as ghosts (ADR-12 no. 3).
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

  /// Keep ordering stable within priority groups so targets do not move between updates (MVP.md).
  List<Cell> _merge() {
    final seen = <CellRef>{};
    final all = _byHost.entries
        .expand((entry) => entry.value)
        // Keep the first pane occurrence because live surfaces precede remembered ones.
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
