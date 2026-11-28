import 'package:flutter_test/flutter_test.dart';

import 'layering_test.dart' show blank, dartFiles;

/// A corner radius under `features/` comes from `ShapeRole`, so a theme's radii apply.
/// Marks of 3 px or less and radii computed from a size stay geometry.
void main() {
  test('no literal corner radius above 3 px under lib/features', () {
    final literal = RegExp(r'Radius\.circular\(\s*(\d+(?:\.\d+)?)\s*\)');
    final hits = <String>[];
    for (final f in dartFiles('lib/features')) {
      final lines = blank(f.readAsStringSync()).split('\n');
      for (var i = 0; i < lines.length; i++) {
        for (final m in literal.allMatches(lines[i])) {
          if (double.parse(m.group(1)!) > 3) hits.add('${f.path}:${i + 1}  ${m.group(0)}');
        }
      }
    }
    expect(hits, isEmpty, reason: 'use context.shape.radius(ShapeRole.…):\n${hits.join('\n')}');
  });
}
