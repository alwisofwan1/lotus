import 'package:flutter/material.dart';

import 'role_table.dart';

/// The terminal's colours: xterm's slots plus the find bar's own two highlights.
enum TermRole {
  foreground,
  background,
  cursor,
  selection,
  black,
  red,
  green,
  yellow,
  blue,
  magenta,
  cyan,
  white,
  brightBlack,
  brightRed,
  brightGreen,
  brightYellow,
  brightBlue,
  brightMagenta,
  brightCyan,
  brightWhite,
  searchHitBackground,
  searchHitBackgroundCurrent,
  searchHitForeground,
  findHit,
  findHitCurrent,
}

/// The 16 ANSI slots, the ones a program picks as text colours.
const List<TermRole> ansiRoles = [
  TermRole.black, TermRole.red, TermRole.green, TermRole.yellow, //
  TermRole.blue, TermRole.magenta, TermRole.cyan, TermRole.white,
  TermRole.brightBlack, TermRole.brightRed, TermRole.brightGreen, TermRole.brightYellow,
  TermRole.brightBlue, TermRole.brightMagenta, TermRole.brightCyan, TermRole.brightWhite,
];

@immutable
class TerminalPalette extends ThemeExtension<TerminalPalette> {
  TerminalPalette(Map<TermRole, Color> roles) : _t = RoleTable(TermRole.values, roles);
  const TerminalPalette._(this._t);

  final RoleTable<TermRole, Color> _t;

  Color operator [](TermRole role) => _t[role];

  @override
  TerminalPalette copyWith([Map<TermRole, Color> over = const {}]) =>
      TerminalPalette._(_t.copyWith(over));

  @override
  TerminalPalette lerp(ThemeExtension<TerminalPalette>? other, double t) => other is! TerminalPalette
      ? this
      : TerminalPalette._(_t.lerp(other._t, t, (a, b, t) => Color.lerp(a, b, t)!));

  @override
  bool operator ==(Object other) => other is TerminalPalette && other._t == _t;

  @override
  int get hashCode => _t.hashCode;
}

extension TerminalPaletteContext on BuildContext {
  TerminalPalette get terminalPalette => Theme.of(this).extension<TerminalPalette>()!;
}
