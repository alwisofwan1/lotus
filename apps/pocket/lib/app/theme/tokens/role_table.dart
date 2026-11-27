import 'package:flutter/foundation.dart';

/// Values stored by enum index, so ==, hashCode and lerp cannot skip a role.
@immutable
class RoleTable<R extends Enum, V> {
  /// Throws on a missing role: a theme cannot ship with a hole in it.
  RoleTable(List<R> roles, Map<R, V> values)
      : _v = List.unmodifiable([
          for (final r in roles)
            if (values.containsKey(r)) values[r] as V else throw ArgumentError('missing role ${r.name}'),
        ]);

  RoleTable._(List<V> values) : _v = List.unmodifiable(values);

  final List<V> _v;

  V operator [](R role) => _v[role.index];

  RoleTable<R, V> copyWith(Map<R, V> over) {
    final next = [..._v];
    for (final e in over.entries) {
      next[e.key.index] = e.value;
    }
    return RoleTable._(next);
  }

  RoleTable<R, V> lerp(RoleTable<R, V> other, double t, V Function(V a, V b, double t) mix) =>
      RoleTable._([for (var i = 0; i < _v.length; i++) mix(_v[i], other._v[i], t)]);

  @override
  bool operator ==(Object other) => other is RoleTable<R, V> && listEquals(other._v, _v);

  @override
  int get hashCode => Object.hashAll(_v);
}
