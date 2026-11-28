import 'package:flutter/material.dart';

import '../app_tokens.dart';
import '../theme_variant.dart';
import '../tokens/app_elevation.dart';
import '../tokens/app_shape.dart';
import '../tokens/app_type.dart';
import '../tokens/color_role.dart';
import '../tokens/terminal_palette.dart';

// Graphite & Paper: opaque warm neutrals, ink on paper, no blur.
// Values, the three AA re-solves and the roles the mockup left open: `docs/theme.md#graphite`.

final AppColors _darkColors = AppColors({
  ColorRole.ground: const Color(0xFF121211),
  ColorRole.raised: const Color(0xFF1A1A18), // s1
  ColorRole.track: const Color(0xFF232320), // s2
  ColorRole.termGround: const Color(0xFF0B0B0A),
  ColorRole.key: const Color(0xFF232320), // s2
  ColorRole.keyActive: const Color(0xFF2C2C29), // s3, pressed
  ColorRole.text: const Color(0xFFEDEAE4),
  ColorRole.text2: const Color(0xFFA9A59D),
  ColorRole.text3: const Color(0xFF868279), // 4.55:1 on s1; mockup #7C786F was 3.96
  ColorRole.ornament: const Color(0xFF65625B), // 3.08:1, non-text only
  ColorRole.hairline: const Color(0x12FFFFFF), // rgba(255,255,255,.07)
  ColorRole.hairlineStrong: const Color(0x24FFFFFF), // .14
  ColorRole.waiting: const Color(0xFFF5B451), // oklch(0.813 0.137 75), the earlier mockup's amber
  ColorRole.waitingRule: const Color(0xFFF59E0B),
  ColorRole.waitingTint: const Color(0x1AF59E0B), // 10%
  ColorRole.onWaiting: const Color(0xFF1A1300),
  ColorRole.live: const Color(0xFF5FBF95),
  ColorRole.error: const Color(0xFFE7768A), // hue 10°: 65° from amber
  ColorRole.onError: const Color(0xFF121211),
  ColorRole.scrim: const Color(0x99000000),
  ColorRole.shadow: const Color(0xFF000000),
  ColorRole.camera: const Color(0xFF000000),
  ColorRole.onCamera: const Color(0xFFEDEAE4),
  ColorRole.onCamera2: const Color(0xFFA9A59D),
  ColorRole.onCamera3: const Color(0xFF868279),
});

final AppColors _lightColors = AppColors({
  ColorRole.ground: const Color(0xFFF5F3EF),
  ColorRole.raised: const Color(0xFFFFFFFF), // s1
  ColorRole.track: const Color(0xFFEEEBE5), // s2
  ColorRole.termGround: const Color(0xFF0B0B0A), // the terminal stays dark: dark's ground
  ColorRole.key: const Color(0xFFEEEBE5), // s2
  ColorRole.keyActive: const Color(0xFFE4E0D8), // s3, pressed
  ColorRole.text: const Color(0xFF1A1917),
  ColorRole.text2: const Color(0xFF5C5851),
  ColorRole.text3: const Color(0xFF736E69), // 4.55:1 on ground; mockup #85807A was 3.53
  ColorRole.ornament: const Color(0xFF908B83), // 3.05:1, non-text only
  ColorRole.hairline: const Color(0x141A1917), // rgba(26,25,23,.08)
  ColorRole.hairlineStrong: const Color(0x291A1917), // .16
  ColorRole.waiting: const Color(0xFF9B4F04), // 4.52:1 worst; the earlier mockup's #B45309 was 3.81
  ColorRole.waitingRule: const Color(0xFFC26904), // 3.01:1 worst; mockup #D97706 was 2.42
  ColorRole.waitingTint: const Color(0x14D97706), // 8%
  ColorRole.onWaiting: const Color(0xFFFFFFFF),
  ColorRole.live: const Color(0xFF1E7A55),
  ColorRole.error: const Color(0xFFBD3379), // hue 354°: 61° from amber
  ColorRole.onError: const Color(0xFFFFFFFF),
  ColorRole.scrim: const Color(0x521A1917),
  ColorRole.shadow: const Color(0xFF1A1917),
  // The scanner stays dark in every theme.
  ColorRole.camera: const Color(0xFF000000),
  ColorRole.onCamera: const Color(0xFFEDEAE4),
  ColorRole.onCamera2: const Color(0xFFA9A59D),
  ColorRole.onCamera3: const Color(0xFF868279),
});

const _sans = TextStyle(fontFamily: 'Geist');

final AppType _type = AppType({
  TypeRole.mono: const TextStyle(
    fontFamily: 'GeistMono',
    fontFamilyFallback: ['Menlo', 'SF Mono', 'Consolas', 'monospace'],
  ),
  TypeRole.ui: _sans,
  TypeRole.serif: _sans, // prose is Geist too; Graphite has no serif voice
});

Color _d(ColorRole r) => _darkColors[r];

// One palette for both: the terminal ground is dark in light mode too.
// Black is a readable grey (no waivers): 3.3:1 on the ground, white 4.99:1 on it.
final TerminalPalette _terminal = TerminalPalette({
  TermRole.foreground: _d(ColorRole.text2),
  TermRole.background: _d(ColorRole.termGround),
  TermRole.cursor: _d(ColorRole.text2),
  TermRole.selection: const Color(0xFF7DD3FC).withValues(alpha: 0.42),
  TermRole.black: const Color(0xFF66635C),
  TermRole.red: _d(ColorRole.error),
  TermRole.green: const Color(0xFF7BD88F),
  TermRole.yellow: _d(ColorRole.waiting),
  TermRole.blue: const Color(0xFF7DD3FC),
  TermRole.magenta: const Color(0xFFC4A0F5),
  TermRole.cyan: const Color(0xFF67E8F9),
  TermRole.white: _d(ColorRole.text),
  TermRole.brightBlack: _d(ColorRole.text3),
  TermRole.brightRed: const Color(0xFFFCA5A5),
  TermRole.brightGreen: const Color(0xFFA7F3D0),
  TermRole.brightYellow: const Color(0xFFFDE68A),
  TermRole.brightBlue: const Color(0xFFBAE6FD),
  TermRole.brightMagenta: const Color(0xFFE9D5FF),
  TermRole.brightCyan: const Color(0xFFA5F3FC),
  TermRole.brightWhite: _d(ColorRole.text),
  TermRole.searchHitBackground: _d(ColorRole.waiting),
  TermRole.searchHitBackgroundCurrent: _d(ColorRole.waiting),
  TermRole.searchHitForeground: _d(ColorRole.ground),
  TermRole.findHit: const Color(0x24EDEAE4),
  TermRole.findHitCurrent: const Color(0x59EDEAE4),
});

// 10 small, 16 cards and controls, 24 composer and sheet tops, pill.
final AppShape _shape = AppShape({
  ShapeRole.tail: 6,
  ShapeRole.tag: 6,
  ShapeRole.key: 10,
  ShapeRole.thumb: 10,
  ShapeRole.chip: 10,
  ShapeRole.option: 16,
  ShapeRole.block: 16,
  ShapeRole.row: 16,
  ShapeRole.field: 16,
  ShapeRole.card: 16,
  ShapeRole.button: 16,
  ShapeRole.bubble: 16,
  ShapeRole.banner: 16,
  ShapeRole.composer: 24,
  ShapeRole.sheetSmall: 24,
  ShapeRole.sheetMedium: 24,
  ShapeRole.sheetLarge: 24,
  ShapeRole.sheet: 24,
  ShapeRole.pill: 999,
});

final AppElevation _elevation = AppElevation({ElevationRole.floating: 4, ElevationRole.menu: 8});

ThemeVariant _variant(Brightness b, AppColors colors, {ThemeVariant? chrome}) => ThemeVariant(
      brightness: b,
      tokens: AppTokens(colors: colors, fonts: _type),
      terminal: _terminal,
      shape: _shape,
      elevation: _elevation,
      terminalChrome: chrome,
    );

final ThemeVariant _dark = _variant(Brightness.dark, _darkColors);

final AppThemeDef graphite = AppThemeDef(
  id: 'graphite',
  label: 'Graphite',
  // Light mode's terminal page is a dark ground, so its chrome is the dark variant.
  light: _variant(Brightness.light, _lightColors, chrome: _dark),
  dark: _dark,
);
