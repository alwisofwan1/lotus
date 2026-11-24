/// What a machine says it will honour when a spawn is tuned — the two value types
/// `bootstrap.runners[]` carries beside a runner's name.
///
/// **Their own file because `bootstrap.dart` reached the 300-line limit when the permission
/// scale arrived**, and this is the seam that was already there: everything here answers
/// *what may this runner be set to*, while what is left behind answers *what is on this
/// machine*. `bootstrap.dart` re-exports both, so no importer had to learn a second path.
///
/// Neither list is ever invented by this app. A host that sends none of a given kind is
/// saying **do not offer that control**, and an empty picker is a lie about the machine
/// (ADR-14).
library;

/// One choice on a runner's model picker.
///
/// [id] is what the spawn sends and [label] what the operator reads; they differ for
/// Codex (`gpt-5.4-codex` → `5.4-codex`), where the host strips the prefix every row
/// would share. The default is the one the CLI picks unasked — the phone shows it as
/// the resting choice and sends no `model` for it, so a host default that moves
/// later is still honoured.
class RunnerModel {
  const RunnerModel({required this.id, required this.label, this.isDefault = false});

  final String id;
  final String label;
  final bool isDefault;

  factory RunnerModel.fromJson(Map<String, Object?> json) => RunnerModel(
        id: json['id']! as String,
        label: json['label'] as String? ?? json['id']! as String,
        isDefault: json['default'] as bool? ?? false,
      );

  static List<RunnerModel> listFromJson(Object? raw) => raw is! List<Object?>
      ? const []
      : raw
          .whereType<Map<String, Object?>>()
          .map(RunnerModel.fromJson)
          .toList(growable: false);
}

/// One stop on a runner's permission scale, as the host advertised it.
///
/// The same shape as [RunnerModel] on purpose: both are *what this machine will honour*, and
/// neither is a list this app is allowed to invent. An unknown [id] is still renderable —
/// [label] is what the operator reads — so a host newer than this app widens the control
/// instead of breaking it.
class RunnerPermission {
  const RunnerPermission({
    required this.id,
    required this.label,
    this.isDefault = false,
    this.isDefaultHeadless = false,
  });

  /// What a spawn sends: `manual`, `acceptEdits`, `read-only`.
  final String id;

  /// What the operator reads: `manual`, `accept edits`, `read only`.
  final String label;

  /// Where the knob rests when the sheet opens.
  final bool isDefault;

  /// Where it rests instead when the same runner is spawned with no terminal.
  ///
  /// Only Codex sets this, and only because its two paths genuinely disagree: a Codex in a
  /// terminal is launched bypassing everything, while a headless one is started asking — and
  /// that one can put its approval in front of this phone, so resting it on *never asks*
  /// would throw away the only reason it can ask at all.
  final bool isDefaultHeadless;

  factory RunnerPermission.fromJson(Map<String, Object?> json) => RunnerPermission(
        id: json['id']! as String,
        label: json['label'] as String? ?? json['id']! as String,
        isDefault: json['default'] as bool? ?? false,
        isDefaultHeadless: json['defaultHeadless'] as bool? ?? false,
      );

  static List<RunnerPermission> listFromJson(Object? raw) => raw is! List<Object?>
      ? const []
      : raw
          .whereType<Map<String, Object?>>()
          .map(RunnerPermission.fromJson)
          .toList(growable: false);
}
