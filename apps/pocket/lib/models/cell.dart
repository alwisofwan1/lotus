import 'host_id.dart';

/// One agent, as the host reports it.
///
/// `status`, `turn` and `gating` stay **raw strings**, not enums. The host keeps
/// them open on purpose so a desktop newer than this app can add values, and a
/// closed enum would throw on the first one it had never heard of. The meaning
/// lives in the predicates below instead.
class Cell {
  const Cell({
    required this.host,
    required this.paneId,
    required this.workspaceId,
    required this.agentType,
    this.runnerLabel,
    required this.title,
    required this.status,
    required this.isAlive,
    this.terminal = true,
    this.cwd,
    this.workspaceLabel,
    this.lastOutputPreview,
    this.headline,
    this.sessionId,
    this.turn,
    this.turnAgeMs,
    this.gating,
    this.usage,
    this.profileId,
    this.model,
    this.branch,
  });

  /// Which paired host this came from. **Not in the payload** — fixtures are
  /// per-host, so the client attaches it at parse time. The impurity is paid on
  /// purpose: a `Cell` that does not know its host makes R-10 representable, and a
  /// dispatch addressed by `paneId` alone reaches the wrong machine (ADR-13).
  final HostId host;

  final String paneId;
  final String workspaceId;

  /// Runner driving the cell: `claude`, `codex`, … Rendered as small text, never
  /// a logo — a logo is unreadable at 12px (MVP.md).
  ///
  /// The *family*, not the name: every custom Claude-family runner reports `claude`
  /// here on purpose, because that is what a client routes on. [runnerLabel] is what
  /// the operator reads.
  final String agentType;

  /// What the desktop calls this runner — `acme`, `HSS`, `Claude Code`.
  ///
  /// **Added 2026-08-10 because the two screens disagreed.** The desktop's node header
  /// read `Atlas · acme` while this phone read `Atlas claude`, describing one cell
  /// two ways with nothing on the wire to reconcile them — [agentType] cannot carry it,
  /// since collapsing custom Claude-family runners to `claude` is what makes it useful
  /// for routing.
  ///
  /// Null when the host is older than the field or genuinely cannot name the runner;
  /// [runner] falls back to [agentType], which is exactly what this app showed before.
  final String? runnerLabel;

  /// The runner as a human reads it — the host's own name for it when there is one.
  String get runner => runnerLabel ?? agentType;

  /// Persona name, never the pane id. The operator thinks "Atlas", not `cell-7f3a`.
  final String title;

  /// Launch phase: does this pane exist and run. NOT whether the agent is mid-turn.
  final String status;
  final bool isAlive;

  /// False for a Chat cell the host runs with no terminal: there is no Terminal view to show.
  /// Absent on the wire means true — every cell before the host sent this had one.
  final bool terminal;

  final String? cwd;
  final String? workspaceLabel;
  final String? lastOutputPreview;

  /// What this agent was asked to do, as the desktop card shows it. Absent for a pane
  /// the desktop never saw asked. Preferred over [lastOutputPreview] on Home: the ask
  /// says what the agent is *for*, the tail says what it last printed.
  final String? headline;
  final String? sessionId;

  /// Turn phase from the agent's stop hook. **Absent means unknown**, never
  /// "not waiting" — see [turnKnown].
  final String? turn;
  final int? turnAgeMs;

  /// Whether this cell asks before acting: `asks`, `skipped`, `runner_cannot`.
  final String? gating;

  /// Which account this cell works as, when one was chosen at spawn.
  ///
  /// Null means the runner's own default. Worth showing: with several accounts on a machine
  /// nothing else answers "which one is this", and a running cell cannot be moved.
  final String? profileId;

  /// What the runner behind this cell last said about its plan.
  ///
  /// **Null means the runner does not say** — never that the plan is fine. Only Claude
  /// volunteers it today; Codex reports tokens but no quota, and ACP carries no usage at all.
  /// Reading silence as health is the failure this exists to prevent: an exhausted plan once
  /// arrived as an ordinary-looking reply (`contract/README.md`).
  final PlanWindow? usage;

  /// The model this session last answered with, as the agent CLI wrote it
  /// (`claude-opus-5-5`). **Null means the host does not know** — never a runner default.
  final String? model;

  /// The git branch the session reports. Null outside a repo or when unknown.
  final String? branch;

  static const String turnNeedsInput = 'needs-input';
  static const String turnIdle = 'idle';
  static const String gatingRunnerCannot = 'runner_cannot';

  /// The one state that means a human is actually needed.
  bool get needsInput => turn == turnNeedsInput;

  /// Reported idle — which is **not** the same as [turnKnown] being false. Only a
  /// runner that files a stop hook can claim this, so it is the one silence a
  /// screen is allowed to describe as finished.
  bool get isIdle => turn == turnIdle;

  /// False for every runner that reports no turn at all. A UI that renders this
  /// as `idle` says "done" about an agent that may be deleting files.
  bool get turnKnown => turn != null;

  /// Codex and friends: silence here cannot be interpreted at all.
  bool get neverAsks => gating == gatingRunnerCannot;

  /// The key this cell is addressed by, everywhere.
  CellRef get ref => CellRef(host, paneId);

  /// Which project on which host this belongs to — what Home selects by.
  ProjectRef get project => ProjectRef(host, workspaceId);

  /// The project's name as a human would say it.
  ///
  /// **`workspaceLabel` is null in production, always** — measured against a live
  /// desktop on 2026-08-06: every canvas cell came back with `workspaceLabel: null`
  /// and `workspaceId: "canvas:cp_2c7308855b8de2c9"`. The mockup's `CNVS` was invented
  /// for the mockup, and `preview_home.dart` set the label itself, so nothing before
  /// this had ever seen what the host actually sends.
  ///
  /// [cwd] is where the readable name lives — `…/experiments/codespace-demo` — so the
  /// last path segment is used before falling back to the id. The id stays as the last
  /// resort rather than being dropped: an opaque title is bad, but a project with no
  /// title at all cannot be told from another one.
  String get projectName => workspaceLabel ?? _cwdBasename ?? workspaceId;

  /// Last segment of [cwd], ignoring a trailing slash. Null when there is no cwd, or
  /// when it is `/` — a repo is never the filesystem root, so an empty answer there is
  /// a wrong answer, not a short one.
  String? get _cwdBasename {
    final path = cwd?.trim();
    if (path == null || path.isEmpty) return null;
    final segments = path.split('/').where((s) => s.isNotEmpty);
    return segments.isEmpty ? null : segments.last;
  }

  factory Cell.fromJson(Map<String, Object?> json, {required HostId host}) => Cell(
        host: host,
        paneId: json['paneId']! as String,
        workspaceId: json['workspaceId']! as String,
        agentType: json['agentType']! as String,
        runnerLabel: json['runnerLabel'] as String?,
        title: json['title']! as String,
        status: json['status']! as String,
        isAlive: json['isAlive']! as bool,
        terminal: json['terminal'] as bool? ?? true,
        cwd: json['cwd'] as String?,
        workspaceLabel: json['workspaceLabel'] as String?,
        lastOutputPreview: json['lastOutputPreview'] as String?,
        headline: json['headline'] as String?,
        sessionId: json['sessionId'] as String?,
        turn: json['turn'] as String?,
        turnAgeMs: json['turnAgeMs'] as int?,
        gating: json['gating'] as String?,
        usage: PlanWindow.fromJson(json['usage']),
        profileId: json['profileId'] as String?,
        model: json['model'] as String?,
        branch: json['branch'] as String?,
      );

  static List<Cell> listFromJson(Object? raw, {required HostId host}) =>
      (raw! as List<Object?>)
          .map((e) => Cell.fromJson(e! as Map<String, Object?>, host: host))
          .toList(growable: false);
}

/// The pane a host registered for an agent the phone just started.
///
/// Answered as soon as the pane **exists**, not when the agent inside is ready — the
/// contract the desktop's own spawn route documents. The phone therefore treats this as
/// "it took", and waits for the next fleet snapshot to say what the cell is doing.
class SpawnedCell {
  const SpawnedCell({required this.paneId, this.workspaceId, this.provider});

  final String paneId;
  final String? workspaceId;
  final String? provider;

  /// **No required field.** A 200 says the machine took it, and that is the whole
  /// answer the phone acts on — it waits for the fleet snapshot to describe the cell.
  /// Insisting on `paneId` here would turn a host that answered `{}` into a crash on
  /// the only screen the operator has, for a value nothing reads.
  factory SpawnedCell.fromJson(Map<String, Object?> json) => SpawnedCell(
        paneId: json['paneId'] as String? ?? '',
        workspaceId: json['workspaceId'] as String?,
        provider: json['provider'] as String?,
      );
}

/// What the app may rely on, announced on `hello` and on `POST /m/pair`.
class HostCaps {
  const HostCaps({required this.protocol, required this.features});

  /// Bumped only when an existing shape changes incompatibly.
  final int protocol;
  final List<String> features;

  /// The whole point of the field: hide what the host does not advertise. A
  /// Standalone Host omits `transcript`, `permission` and `stt` (PLAN §7 no. 10).
  bool supports(String feature) => features.contains(feature);

  factory HostCaps.fromJson(Map<String, Object?> json) => HostCaps(
        protocol: json['protocol']! as int,
        features: (json['features']! as List<Object?>).cast<String>(),
      );
}

/// A plan window, in the runner's own words.
///
/// [status] and [window] are kept as the wire strings rather than narrowed to an enum: the
/// vocabularies differ per provider, so a newer status still renders instead of vanishing.
class PlanWindow {
  const PlanWindow({required this.status, required this.window, this.resetsAt});

  /// `allowed`, `allowed_warning`, `rejected`, or whatever a newer runner says.
  final String status;

  /// `five_hour`, `weekly`, …
  final String window;

  /// When it resets, if the runner said. Sent as epoch **seconds**.
  final DateTime? resetsAt;

  /// Whether this is worth telling the operator about at all.
  bool get isHealthy => status == 'allowed';

  static PlanWindow? fromJson(Object? raw) {
    if (raw is! Map<String, Object?>) return null;
    final status = raw['status'];
    final window = raw['window'];
    if (status is! String || window is! String) return null;
    return PlanWindow(
      status: status,
      window: window,
      resetsAt: switch (raw['resetsAt']) {
        final int seconds => DateTime.fromMillisecondsSinceEpoch(seconds * 1000),
        _ => null,
      },
    );
  }
}
