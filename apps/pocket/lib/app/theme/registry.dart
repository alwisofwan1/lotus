import 'palettes/classic.dart';
import 'theme_variant.dart';

/// Every theme the app can show. Adding one: a palette file plus one line here.
final List<AppThemeDef> themeRegistry = [classic];

AppThemeDef themeById(String id) =>
    themeRegistry.firstWhere((d) => d.id == id, orElse: () => themeRegistry.first);
