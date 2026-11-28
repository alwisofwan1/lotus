import '../core/secure_store.dart';

/// System follows the phone; light and dark pin one.
enum Appearance { system, light, dark }

/// Which theme and appearance the operator picked, kept across restarts.
/// Ids are stored as written; `app/` decides what an unknown one falls back to.
class ThemeChoice {
  ThemeChoice(this.store);

  final SecureStore store;

  // Namespaced, so `Credentials.load` (which reads `host:` keys) skips them.
  static const String themeKey = 'theme:id';
  static const String appearanceKey = 'theme:appearance';

  String? _themeId, _storedThemeId;
  Appearance? _appearance, _storedAppearance;
  Future<void> _writes = Future.value();

  String? get themeId => _themeId;
  Appearance? get appearance => _appearance;

  Future<void> load() async {
    final all = await store.readAll();
    _themeId = _storedThemeId = all[themeKey];
    _appearance = _storedAppearance = Appearance.values.asNameMap()[all[appearanceKey]];
  }

  /// Queued, so writes land in order and the last choice is the one stored.
  Future<void> save({required String themeId, required Appearance appearance}) {
    _themeId = themeId;
    _appearance = appearance;
    return _writes = _writes.then((_) => _flush());
  }

  Future<void> _flush() async {
    final id = _themeId, look = _appearance;
    if (id != null && id != _storedThemeId) {
      await store.write(themeKey, id);
      _storedThemeId = id;
    }
    if (look != null && look != _storedAppearance) {
      await store.write(appearanceKey, look.name);
      _storedAppearance = look;
    }
  }
}
