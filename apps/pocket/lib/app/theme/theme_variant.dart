import 'package:flutter/material.dart';

import 'app_tokens.dart';
import 'tokens/app_elevation.dart';
import 'tokens/app_shape.dart';
import 'tokens/terminal_palette.dart';

/// One brightness of one theme: everything `buildAppTheme` needs.
@immutable
class ThemeVariant {
  const ThemeVariant({
    required this.brightness,
    required this.tokens,
    required this.terminal,
    required this.shape,
    required this.elevation,
  });

  final Brightness brightness;
  final AppTokens tokens;
  final TerminalPalette terminal;
  final AppShape shape;
  final AppElevation elevation;

  List<ThemeExtension<dynamic>> get extensions => [tokens, terminal, shape, elevation];
}

/// A registered theme. One that ships a single brightness passes it as both.
@immutable
class AppThemeDef {
  const AppThemeDef({required this.id, required this.label, required this.light, required this.dark});

  final String id;
  final String label;
  final ThemeVariant light;
  final ThemeVariant dark;

  List<ThemeVariant> get variants => [light, dark];
}
