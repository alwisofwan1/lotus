import 'package:flutter/material.dart';

import 'app_theme.dart';
import 'invariants/rules.dart';
import 'registry.dart';
import 'theme_variant.dart';

/// Which registered theme is shown, and in which mode. In memory only for now.
class ThemeController extends ChangeNotifier {
  ThemeController({String themeId = 'classic', this._mode = ThemeMode.dark})
      : _theme = _registered(themeId);

  AppThemeDef _theme;
  ThemeMode _mode;

  AppThemeDef get theme => _theme;
  ThemeMode get mode => _mode;

  set mode(ThemeMode value) {
    if (value == _mode) return;
    _mode = value;
    notifyListeners();
  }

  void select(String id) {
    final next = _registered(id);
    if (identical(next, _theme)) return;
    _theme = next;
    notifyListeners();
  }

  static AppThemeDef _registered(String id) {
    for (final def in themeRegistry) {
      if (def.id != id) continue;
      // The invariant test already guards the registry; this catches a hot-reloaded edit.
      assert(def.variants.every((v) => checkTheme(v).isEmpty), 'theme $id breaks an invariant');
      return def;
    }
    throw ArgumentError.value(id, 'id', 'not a registered theme');
  }
}

/// Rebuilds [builder] with the controller's light theme, dark theme and mode.
class ThemedApp extends StatelessWidget {
  const ThemedApp({required this.controller, required this.builder, super.key});

  final ThemeController controller;
  final Widget Function(ThemeData theme, ThemeData darkTheme, ThemeMode mode) builder;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          final def = controller.theme;
          return builder(_built(def.light), _built(def.dark), controller.mode);
        },
      );

  // Built once per variant, so MaterialApp sees the same ThemeData across rebuilds.
  static final Map<ThemeVariant, ThemeData> _cache = {};
  static ThemeData _built(ThemeVariant v) => _cache.putIfAbsent(v, () => buildAppTheme(v));
}
