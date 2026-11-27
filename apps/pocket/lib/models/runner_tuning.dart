/// Host-advertised tuning choices prevent offering unsupported controls (ADR-14).
library;

/// The default sends no model so the host CLI can choose its current default.
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

/// Host-advertised labels keep unknown permission choices renderable.
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

  /// Headless and terminal defaults can differ; headless approval must remain available.
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
