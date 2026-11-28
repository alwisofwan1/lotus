import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';

/// What the picker shows and where a pick goes; `app/` builds it from its theme controller.
@immutable
class AppearanceSettings {
  const AppearanceSettings({
    required this.themes,
    required this.themeId,
    required this.mode,
    required this.onTheme,
    required this.onMode,
  });

  final List<({String id, String label})> themes;
  final String themeId;
  final ThemeMode mode;
  final ValueChanged<String> onTheme;
  final ValueChanged<ThemeMode> onMode;
}

/// Theme and appearance, two rows of segments. The one preference on this screen.
class AppearanceBlock extends StatelessWidget {
  const AppearanceBlock({required this.settings, super.key});

  final AppearanceSettings settings;

  static const _modes = [
    (ThemeMode.system, 'System'),
    (ThemeMode.light, 'Light'),
    (ThemeMode.dark, 'Dark'),
  ];

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final s = settings;

    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.only(top: 22, bottom: 14),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _caption(t, 'Theme'),
          _Segments(
            options: [for (final d in s.themes) (d.label, d.id == s.themeId, () => s.onTheme(d.id))],
          ),
          const SizedBox(height: 16),
          _caption(t, 'Appearance'),
          _Segments(
            options: [for (final (m, label) in _modes) (label, m == s.mode, () => s.onMode(m))],
          ),
        ],
      ),
    );
  }

  Widget _caption(AppTokens t, String text) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text, style: t.ui.copyWith(fontSize: 13, fontWeight: FontWeight.w500, color: t.muted)),
      );
}

class _Segments extends StatelessWidget {
  const _Segments({required this.options});

  final List<(String label, bool selected, VoidCallback pick)> options;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final shape = context.shape;

    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(color: t.raise2, borderRadius: shape.radius(ShapeRole.button)),
      child: Row(
        children: [
          for (final (label, selected, pick) in options)
            Expanded(
              child: Semantics(
                button: true,
                selected: selected,
                label: label,
                excludeSemantics: true,
                child: Material(
                  color: selected ? t.keyHi : Colors.transparent,
                  borderRadius: shape.radius(ShapeRole.block),
                  child: InkWell(
                    borderRadius: shape.radius(ShapeRole.block),
                    onTap: selected ? null : pick,
                    child: Container(
                      height: kMinHitTarget,
                      alignment: Alignment.center,
                      child: Text(
                        label,
                        style: t.ui.copyWith(
                          fontSize: 14,
                          fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                          color: selected ? t.text : t.dim,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
