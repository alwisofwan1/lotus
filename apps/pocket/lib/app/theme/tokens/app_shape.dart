import 'dart:ui' show lerpDouble;

import 'package:flutter/material.dart';

import 'role_table.dart';

/// Corner radii by job, in logical pixels. Classic keeps each job's historic value;
/// a theme may fold them onto a shorter scale. Marks of 3 px or less stay geometry.
enum ShapeRole {
  tail, // the bubble's pointed corner
  tag, // inline badges and small marks
  key, // key caps, bar buttons, find field
  thumb, // quoted and pasted snippets
  chip, // code blocks, chips, small fields
  option, // answer option rows
  block, // blocks inside a screen
  row, // filled list rows and their letter tiles
  field, // dialog and form fields
  card, // permission, question and finished cards
  button, // large buttons and search field
  bubble, // the user's chat bubble
  banner, // the needs-you card, swipe actions
  composer, // the composer box
  sheetSmall, // detail sheet tops
  sheetMedium, // changes sheet top
  sheetLarge, // picker sheet tops
  sheet, // the modal bottom sheet theme
  pill,
}

@immutable
class AppShape extends ThemeExtension<AppShape> {
  AppShape(Map<ShapeRole, double> roles) : _t = RoleTable(ShapeRole.values, roles);
  const AppShape._(this._t);

  final RoleTable<ShapeRole, double> _t;

  double operator [](ShapeRole role) => _t[role];

  BorderRadius radius(ShapeRole role) => BorderRadius.circular(_t[role]);

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
