import 'cell.dart';
import 'host_id.dart';
import 'host_runner.dart';

// Re-exported so every importer keeps its one path to these (`models/bootstrap.dart`).
export 'host_runner.dart';
export 'runner_tuning.dart';

/// One `GET /m/bootstrap` — everything a cold start needs from one host, in one
/// round-trip. Called per host in parallel so a slow host cannot hold the screen
/// (R-11).
class Bootstrap {
  const Bootstrap({
    required this.cells,
    required this.projects,
    required this.workspaces,
    required this.activeTasks,
    required this.runners,
    required this.caps,
    required this.hostId,
    required this.hostLabel,
    required this.mode,
  });

  final List<Cell> cells;

  /// Includes inactive projects absent from live workspaces (ADR-14).
  final List<HostProject> projects;

  final List<Workspace> workspaces;

  /// What this machine can actually start.
  ///
  /// Empty from a host that cannot say, and the phone then falls back to the handful
  /// of runners it knows by name — never to an empty picker, which would tell the
  /// operator their machine has no agents on it.
  final List<HostRunner> runners;

  /// Left as raw maps: tasks are out of MVP scope (MVP.md), so a model here would
  /// be shape we have not agreed on yet.
  final List<Map<String, Object?>> activeTasks;

  final HostCaps caps;

  /// Taken from the payload: the host declares its own id, and the cells below are
  /// stamped with it rather than with a caller's guess.
  final HostId hostId;
  final String hostLabel;
  final String mode;

  factory Bootstrap.fromJson(Map<String, Object?> json) {
    final hostId = HostId(json['hostId']! as String);
    return Bootstrap(
        cells: Cell.listFromJson(json['cells'], host: hostId),
        // Absent, not empty, from an older host — and the two must not be told
        // apart here. Both mean "this host named no projects", and the switcher
        // then has only the fleet to go on, exactly as before.
        projects: HostProject.listFromJson(json['projects'], host: hostId),
        workspaces: (json['workspaces']! as List<Object?>)
            .map((e) => Workspace.fromJson(e! as Map<String, Object?>))
            .toList(growable: false),
        activeTasks: (json['activeTasks']! as List<Object?>)
            .map((e) => e! as Map<String, Object?>)
            .toList(growable: false),
        runners: HostRunner.listFromJson(json['runners']),
        caps: HostCaps.fromJson(json['hostCaps']! as Map<String, Object?>),
        hostId: hostId,
        hostLabel: json['hostLabel']! as String,
        mode: json['mode']! as String,
      );
  }
}

/// Includes host identity to distinguish projects with the same name (R-10).
class HostProject {
  const HostProject({
    required this.project,
    required this.name,
    required this.path,
    required this.lastOpenedAt,
  });

  final ProjectRef project;

  /// What the operator calls it — the alias, else the root directory's last
  /// segment. The host resolves this, so the phone and the desktop menu cannot
  /// end up naming one project two ways.
  final String name;

  /// Absolute path on that machine. The one fact that tells two same-named
  /// projects apart, and the only reason the switcher can show them as two rows.
  final String path;

  /// Epoch ms, `0` where the host cannot know — a directory scan has no such
  /// record. Sorting on it puts those last, which is where a project with no
  /// recorded activity belongs.
  final int lastOpenedAt;

  factory HostProject.fromJson(Map<String, Object?> json, {required HostId host}) =>
      HostProject(
        project: ProjectRef(host, json['workspaceId']! as String),
        name: json['name']! as String,
        path: (json['path'] as String?) ?? '',
        lastOpenedAt: (json['lastOpenedAt'] as int?) ?? 0,
      );

  /// Tolerates a missing list: a host that predates the route sends no `projects`
  /// key at all, and that is a version difference rather than a malformed payload.
  static List<HostProject> listFromJson(Object? raw, {required HostId host}) {
    if (raw is! List<Object?>) return const [];
    return raw
        .map((e) => HostProject.fromJson(e! as Map<String, Object?>, host: host))
        .toList(growable: false);
  }
}

/// A project on one host. Two hosts can carry the same name, which is why the
/// switcher shows `CNVS · vps` and `CNVS · mac` as separate entries (R-10).
class Workspace {
  const Workspace({
    required this.workspaceId,
    required this.cellCount,
    required this.providers,
  });

  final String workspaceId;
  final int cellCount;
  final List<String> providers;

  factory Workspace.fromJson(Map<String, Object?> json) => Workspace(
        workspaceId: json['workspaceId']! as String,
        cellCount: json['cellCount']! as int,
        providers: (json['providers']! as List<Object?>).cast<String>(),
      );
}
