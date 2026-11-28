import 'package:flutter/material.dart';

import '../app_tokens.dart';
import '../theme_variant.dart';
import '../tokens/app_elevation.dart';
import '../tokens/app_shape.dart';
import '../tokens/app_type.dart';
import '../tokens/color_role.dart';
import '../tokens/terminal_palette.dart';

// Classic: the dark look Pocket has shipped since the 2026-08 floor revamp.
// Why these values (floor, solved alphas, AA table): `docs/theme.md#classic`.

final AppColors _colors = AppColors({
  ColorRole.ground: const Color(0xFF121214), // oklch(0.183 0.004 286°)
  ColorRole.raised: const Color(0x0BF5F2EF), // rgba(245,242,239,0.045)
  ColorRole.track: const Color(0xFF232325),
  ColorRole.termGround: const Color(0xFF0A0A0B),
  ColorRole.key: const Color(0xFF2A2A2D),
  ColorRole.keyActive: const Color(0xFF3A3A3E),
  ColorRole.text: const Color(0xFFF7F2EA), // 16.78:1
  ColorRole.text2: const Color(0xA0F7F2EA), // 7.06:1, solved against ground
  ColorRole.text3: const Color(0x79F7F2EA), // 4.52:1
  ColorRole.ornament: const Color(0x5AF7F2EA), // 3.04:1, non-text only
  ColorRole.hairline: const Color(0x16F5F2EF), // rgba(245,242,239,0.085)
  ColorRole.hairlineStrong: const Color(0x29F5F2EF), // rgba(245,242,239,0.16)
  ColorRole.waiting: const Color(0xFFFBBF24), // desktop --canvas-status-connecting
  ColorRole.onWaiting: const Color(0xFF17130A), // dark ink on amber; ground is too dark at w600
  ColorRole.live: const Color(0xFF3FBF8F),
  ColorRole.error: const Color(0xFFF87171), // desktop --canvas-status-error
  ColorRole.onError: const Color(0xFF121214),
  ColorRole.scrim: const Color(0x99000000),
  ColorRole.shadow: const Color(0xFF000000),
  // The scanner stays dark in every theme, so its text has roles of its own.
  ColorRole.camera: const Color(0xFF000000),
  ColorRole.onCamera: const Color(0xFFF7F2EA),
  ColorRole.onCamera2: const Color(0xA0F7F2EA),
  ColorRole.onCamera3: const Color(0x79F7F2EA),
});

final AppType _type = AppType({
  TypeRole.mono: const TextStyle(fontFamilyFallback: ['Menlo', 'SF Mono', 'Consolas', 'monospace']),
  TypeRole.ui: const TextStyle(), // platform system sans
  TypeRole.serif: const TextStyle(fontFamilyFallback: ['Georgia', 'Palatino', 'serif']),
});

Color _c(ColorRole r) => _colors[r];

// ANSI reuses waiting/error for yellow/red so an agent's warning is not a third amber.
final TerminalPalette _terminal = TerminalPalette({
  TermRole.foreground: _c(ColorRole.text2),
  TermRole.background: _c(ColorRole.ground),
  TermRole.cursor: _c(ColorRole.text2),
  TermRole.selection: const Color(0xFF7DD3FC).withValues(alpha: 0.42), // sky: findable in daylight
  TermRole.black: const Color(0xFF0B0B10),
  TermRole.red: _c(ColorRole.error),
  TermRole.green: const Color(0xFF7BD88F),
  TermRole.yellow: _c(ColorRole.waiting),
  TermRole.blue: const Color(0xFF7DD3FC),
  TermRole.magenta: const Color(0xFFC4A0F5),
  TermRole.cyan: const Color(0xFF67E8F9),
  TermRole.white: _c(ColorRole.text),
  TermRole.brightBlack: _c(ColorRole.ornament),
  TermRole.brightRed: const Color(0xFFFCA5A5),
  TermRole.brightGreen: const Color(0xFFA7F3D0),
  TermRole.brightYellow: const Color(0xFFFDE68A),
  TermRole.brightBlue: const Color(0xFFBAE6FD),
  TermRole.brightMagenta: const Color(0xFFE9D5FF),
  TermRole.brightCyan: const Color(0xFFA5F3FC),
  TermRole.brightWhite: _c(ColorRole.text),
  TermRole.searchHitBackground: _c(ColorRole.waiting),
  TermRole.searchHitBackgroundCurrent: _c(ColorRole.waiting),
  TermRole.searchHitForeground: _c(ColorRole.ground),
  // Two weights of the app's own ink: a find hit is neither "needs you" nor "failed".
  TermRole.findHit: const Color(0x24F7F2EA),
  TermRole.findHitCurrent: const Color(0x59F7F2EA),
});

final ThemeVariant _dark = ThemeVariant(
  brightness: Brightness.dark,
  tokens: AppTokens(colors: _colors, fonts: _type),
  terminal: _terminal,
  // Each job's radius as it shipped before shape tokens, so Classic looks unchanged.
  shape: AppShape({
    ShapeRole.tail: 5,
    ShapeRole.tag: 6,
    ShapeRole.key: 8,
    ShapeRole.thumb: 9,
    ShapeRole.chip: 10,
    ShapeRole.option: 11,
    ShapeRole.block: 12,
    ShapeRole.row: 13,
    ShapeRole.field: 14,
    ShapeRole.card: 15,
    ShapeRole.button: 16,
    ShapeRole.bubble: 17,
    ShapeRole.banner: 20,
    ShapeRole.composer: 22,
    ShapeRole.sheetSmall: 18,
    ShapeRole.sheetMedium: 20,
    ShapeRole.sheetLarge: 22,
    ShapeRole.sheet: 28,
    ShapeRole.pill: 999,
  }),
  elevation: AppElevation({ElevationRole.floating: 4, ElevationRole.menu: 8}),
  waivers: {
    'ansi black on termGround': 'black is a ground in dark terminals; SGR 30 text is near-invisible by convention',
    'ansi brightBlack on termGround': '2.96:1; it is ornament ink, used for dim terminal chrome',
    'chrome ornament on termGround': '2.96:1, the same ink as brightBlack; marks only',
    'text3 on raised': '4.42:1 on sheets; lifting text3 changes every quiet label',
    'onCamera3 on camera': '4.43:1 for the scan hint; kept to match the quiet text it was',
  },
);

/// Dark-only: the light slot carries the dark variant until a light palette exists.
final AppThemeDef classic = AppThemeDef(id: 'classic', label: 'Classic', light: _dark, dark: _dark);
