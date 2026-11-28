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
    this.waivers = const {},
    this.terminalChrome,
  });

  final Brightness brightness;
  final AppTokens tokens;
  final TerminalPalette terminal;
  final AppShape shape;
  final AppElevation elevation;

  /// Invariant subjects this variant knowingly fails, each with its reason; tested for staleness.
  final Map<String, String> waivers;

  /// The variant drawn over the terminal ground; null when this one already reads there.
  final ThemeVariant? terminalChrome;

  ThemeVariant get onTerminal => terminalChrome ?? this;

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
