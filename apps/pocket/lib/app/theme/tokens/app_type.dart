import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

import 'role_table.dart';

/// Base type styles. They carry family and fallbacks only; call sites add size and colour.
enum TypeRole { mono, ui, serif }

@immutable
class AppType {
  AppType(Map<TypeRole, TextStyle> roles) : _t = RoleTable(TypeRole.values, roles);
  const AppType._(this._t);

  final RoleTable<TypeRole, TextStyle> _t;

  TextStyle operator [](TypeRole role) => _t[role];

  AppType copyWith([Map<TypeRole, TextStyle> over = const {}]) => AppType._(_t.copyWith(over));

  AppType lerp(AppType other, double t) =>
      AppType._(_t.lerp(other._t, t, (a, b, t) => TextStyle.lerp(a, b, t)!));

  @override
  bool operator ==(Object other) => other is AppType && other._t == _t;

  @override
  int get hashCode => _t.hashCode;
}
