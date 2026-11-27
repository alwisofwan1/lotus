import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/registry.dart';
import 'package:lotus_pocket/app/theme/theme.dart';
import 'package:lotus_pocket/app/theme/theme_variant.dart';
import 'package:lotus_pocket/features/agent/link_target.dart';
import 'package:lotus_pocket/features/agent/widgets/changes_sheet.dart';
import 'package:lotus_pocket/features/agent/widgets/line_details.dart';
import 'package:lotus_pocket/features/agent/widgets/prose_links.dart';
import 'package:lotus_pocket/features/shared/name_machine.dart';
import 'package:lotus_pocket/models/cell_result.dart';

/// A sheet open while the theme changes must repaint in the new theme, not keep the
/// colours it was opened with.
void main() {
  final dark = themeRegistry.first.dark;
  final light = ThemeVariant(
    brightness: Brightness.light,
    tokens: dark.tokens.copyWith(
      colors: dark.tokens.colors.copyWith({
        ColorRole.ground: const Color(0xFFFFFFFF),
        ColorRole.raised: const Color(0x14000000),
        ColorRole.text: const Color(0xFF111111),
      }),
    ),
    terminal: dark.terminal,
    shape: dark.shape,
    elevation: dark.elevation,
  );
  Color fill(ThemeVariant v) => Color.alphaBlend(v.tokens.raise, v.tokens.bg);

  final sheets = <String, void Function(BuildContext)>{
    'name machine': (c) => showNameMachine(c, hostLabel: 'acme-web', suggestion: 'acme'),
    'line details': (c) => showLineDetails(c, text: 'x', at: DateTime(2026)),
    'link actions': (c) =>
        showLinkActions(c, target: const LinkTarget(raw: 'https://example.com', kind: LinkKind.web)),
    'changes': (c) => showChangesSheet(c,
        result: const CellResult(
            paneId: 'p-1', cwd: '/repo', closing: null, reason: null,
            changes: CellChanges(files: [ChangedPath(path: 'a.ts', status: 'modified')], added: 0, removed: 0))),
  };

  for (final MapEntry(key: name, value: open) in sheets.entries) {
    testWidgets('$name follows a theme change while open', (tester) async {
      var variant = dark;
      late StateSetter swap;
      await tester.pumpWidget(StatefulBuilder(builder: (context, set) {
        swap = set;
        return MaterialApp(
          theme: buildAppTheme(variant),
          home: Builder(builder: (c) => TextButton(onPressed: () => open(c), child: const Text('open'))),
        );
      }));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      swap(() => variant = light);
      await tester.pumpAndSettle();

      final painted = <Color?>[
        ...tester.widgetList<Material>(find.descendant(of: find.byType(BottomSheet), matching: find.byType(Material))).map((m) => m.color),
        ...tester
            .widgetList<Container>(find.descendant(of: find.byType(BottomSheet), matching: find.byType(Container)))
            .map((c) => (c.decoration as BoxDecoration?)?.color),
      ];
      expect(painted, contains(fill(light)));
      expect(painted, isNot(contains(fill(dark))));
    });
  }
}
