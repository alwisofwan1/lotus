import 'dart:ui' show lerpDouble;

import 'package:flutter/material.dart';

import 'role_table.dart';

/// Material elevations; the shadow colour itself is [ColorRole.shadow].
enum ElevationRole { floating, menu }

@immutable
class AppElevation extends ThemeExtension<AppElevation> {
  AppElevation(Map<ElevationRole, double> roles) : _t = RoleTable(ElevationRole.values, roles);
  const AppElevation._(this._t);

  final RoleTable<ElevationRole, double> _t;

  double operator [](ElevationRole role) => _t[role];

  @override
  AppElevation copyWith([Map<ElevationRole, double> over = const {}]) =>
      AppElevation._(_t.copyWith(over));

  @override
  AppElevation lerp(ThemeExtension<AppElevation>? other, double t) => other is! AppElevation
      ? this
      : AppElevation._(_t.lerp(other._t, t, (a, b, t) => lerpDouble(a, b, t)!));

  @override
  bool operator ==(Object other) => other is AppElevation && other._t == _t;

  @override
  int get hashCode => _t.hashCode;
}

extension AppElevationContext on BuildContext {
  AppElevation get elevation => Theme.of(this).extension<AppElevation>()!;
}
