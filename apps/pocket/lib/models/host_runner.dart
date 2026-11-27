import 'runner_tuning.dart';

/// The host registry supplies native and custom runners because only it knows what is available.
class HostRunner {
  const HostRunner({
    required this.id,
    required this.name,
    required this.gates,
    this.models = const [],
    this.efforts = const [],
    this.permissions = const [],
    this.headless = false,
    this.terminal = true,
    this.chatInTerminal = true,
    this.profiles = const [],
  });

  /// What a spawn names — `claude`, or `custom-acme`.
  final String id;

  /// What the operator calls it: `Pi`, `acme`. Never the command; a command is a
  /// thing to run, not a thing to show someone at arm's length.
  final String name;

  /// Whether this runner has a permission gate that can be asked for at spawn — which
  /// is to say, whether it runs the `claude` binary so Lotus' hooks fire for it. False
  /// means a cell born from it can never ask, so no posture is claimed on its behalf.
  final bool gates;

  /// Empty means no picker; CLI aliases and host tuning determine the choices (`spawn-tuning.ts`, `pinsTuning`).
  final List<RunnerModel> models;

  /// The values this runner's effort knob accepts, lowest first. Per runner because
  /// the scales genuinely differ — Codex has `xhigh`, Claude has `max` — and a slider
  /// with the wrong stops would send a value the CLI rejects. Empty: no slider.
  final List<String> efforts;

  /// Empty means no control; permission scales differ by runner (ADR-14).
  final List<RunnerPermission> permissions;

  /// Empty means no picker; each cell uses one account, not a pool.
  final List<RunnerProfile> profiles;

  /// Headless support is per runner; absent defaults to false.
  final bool headless;

  /// Absent defaults to true for compatibility with older hosts.
  final bool terminal;

  /// Chat support depends on the terminal path, not just the runner.
  final bool chatInTerminal;

  /// Whether the summon sheet has anything to tune on this runner at all.
  bool get tunable => models.isNotEmpty || efforts.isNotEmpty;

  /// The model the CLI would pick on its own, or null when the host marked none.
  RunnerModel? get defaultModel {
    for (final m in models) {
      if (m.isDefault) return m;
    }
    return null;
  }

  factory HostRunner.fromJson(Map<String, Object?> json) => HostRunner(
        id: json['id']! as String,
        name: json['name'] as String? ?? json['id']! as String,
        gates: json['claudeFamily'] as bool? ?? false,
        models: RunnerModel.listFromJson(json['models']),
        permissions: RunnerPermission.listFromJson(json['permissions']),
        efforts: switch (json['efforts']) {
          final List<Object?> raw => raw.whereType<String>().toList(growable: false),
          _ => const [],
        },
        headless: json['headless'] as bool? ?? false,
        terminal: json['terminal'] as bool? ?? true,
        chatInTerminal: json['chatInTerminal'] as bool? ?? true,
        profiles: RunnerProfile.listFromJson(json['profiles']),
      );

  /// Absent and empty are the same answer here — *this host named no runners* — and a
  /// client that told them apart would be inventing a distinction the wire does not
  /// carry.
  static List<HostRunner> listFromJson(Object? raw) => raw is! List<Object?>
      ? const []
      : raw
          .whereType<Map<String, Object?>>()
          .map(HostRunner.fromJson)
          .toList(growable: false);
}


/// One account a runner may be started as.
///
/// Same shape as [RunnerModel] and beside it for the same reason: the phone must not carry a
/// table of which accounts exist on which machine.
class RunnerProfile {
  const RunnerProfile({required this.id, required this.label});

  /// What a spawn sends. `default` is the runner's own directory.
  final String id;

  /// What the operator reads — the name they gave the account.
  final String label;

  static List<RunnerProfile> listFromJson(Object? raw) => raw is! List<Object?>
      ? const []
      : raw
          .whereType<Map<String, Object?>>()
          .where((e) => e['id'] is String)
          .map((e) => RunnerProfile(
                id: e['id']! as String,
                label: e['label'] as String? ?? e['id']! as String,
              ))
          .toList(growable: false);
}
