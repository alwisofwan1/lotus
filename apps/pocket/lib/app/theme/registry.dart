import 'palettes/classic.dart';
import 'palettes/graphite.dart';
import 'theme_variant.dart';

/// Every theme the app can show. Adding one: a palette file plus one line here.
final List<AppThemeDef> themeRegistry = [graphite, classic];

/// What a fresh install shows, and what an unknown stored id falls back to.
const String defaultThemeId = 'graphite';

AppThemeDef themeById(String id) => themeRegistry.firstWhere(
      (d) => d.id == id,
      orElse: () => themeRegistry.firstWhere((d) => d.id == defaultThemeId),
    );
