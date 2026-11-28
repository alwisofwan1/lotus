import 'package:flutter/foundation.dart';
import 'package:flutter/painting.dart';

import 'role_table.dart';

/// Colour roles, named by job and never by hue. `docs/theme.md` has the rules per role.
enum ColorRole {
  ground,
  raised,
  track,
  termGround,
  key,
  keyActive,
  text,
  text2,
  text3,
  ornament,
  hairline,
  hairlineStrong,
  waiting,
  waitingRule,
  waitingTint,
  onWaiting,
  live,
  error,
  onError,
  scrim,
  shadow,
  camera,
  onCamera,
  onCamera2,
  onCamera3,
}

/// Roles a palette may not tune by eye: they carry the app's only meanings.
const Set<ColorRole> statusRoles = {
  ColorRole.waiting,
  ColorRole.waitingRule,
  ColorRole.waitingTint,
  ColorRole.onWaiting,
  ColorRole.live,
  ColorRole.error,
  ColorRole.onError,
};

/// One colour per [ColorRole]; see [RoleTable] for why it is list-backed.
@immutable
class AppColors {
  AppColors(Map<ColorRole, Color> roles) : _t = RoleTable(ColorRole.values, roles);
  const AppColors._(this._t);

  final RoleTable<ColorRole, Color> _t;

  Color operator [](ColorRole role) => _t[role];

  AppColors copyWith([Map<ColorRole, Color> over = const {}]) => AppColors._(_t.copyWith(over));

  AppColors lerp(AppColors other, double t) =>
      AppColors._(_t.lerp(other._t, t, (a, b, t) => Color.lerp(a, b, t)!));

  @override
  bool operator ==(Object other) => other is AppColors && other._t == _t;

  @override
  int get hashCode => _t.hashCode;
}
