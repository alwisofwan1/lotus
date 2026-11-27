import 'dart:ui' show lerpDouble;

import 'package:flutter/material.dart';

import 'role_table.dart';

/// Corner radii, in logical pixels. Values are today's most used ones.
enum ShapeRole { small, medium, large, sheet, pill }

@immutable
class AppShape extends ThemeExtension<AppShape> {
  AppShape(Map<ShapeRole, double> roles) : _t = RoleTable(ShapeRole.values, roles);
  const AppShape._(this._t);

  final RoleTable<ShapeRole, double> _t;

  double operator [](ShapeRole role) => _t[role];

  @override
  AppShape copyWith([Map<ShapeRole, double> over = const {}]) => AppShape._(_t.copyWith(over));

  @override
  AppShape lerp(ThemeExtension<AppShape>? other, double t) => other is! AppShape
      ? this
      : AppShape._(_t.lerp(other._t, t, (a, b, t) => lerpDouble(a, b, t)!));

  @override
  bool operator ==(Object other) => other is AppShape && other._t == _t;

  @override
  int get hashCode => _t.hashCode;
}

extension AppShapeContext on BuildContext {
  AppShape get shape => Theme.of(this).extension<AppShape>()!;
}
