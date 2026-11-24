import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/diff_screen.dart';
import 'package:lotus_pocket/models/cell_result.dart';

/// One file, read-only, in two shades of one ink.
void main() {
  Future<void> show(WidgetTester tester, Future<CellDiff?> Function() load) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: DiffScreen(agent: 'Chase', path: 'src/legacy/shim.ts', load: load),
    ));
    await tester.pumpAndSettle();
  }

  testWidgets('names the file and the agent, and shows every line of the diff', (tester) async {
    await show(
      tester,
      () async => const CellDiff(
        paneId: 'p-1',
        file: 'src/legacy/shim.ts',
        diff: 'diff --git a/x b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n',
        truncated: false,
      ),
    );

    expect(find.text('src/legacy/shim.ts'), findsOne);
    expect(find.text('Chase · vs HEAD'), findsOne);
    expect(find.text('-old'), findsOne);
    expect(find.text('+new'), findsOne);
    expect(find.text('read-only here — edit on the machine'), findsOne);
    expect(find.textContaining('cut at 64 KiB'), findsNothing);
  });

  testWidgets('a capped diff says where the rest is', (tester) async {
    await show(
      tester,
      () async => const CellDiff(paneId: 'p-1', file: 'src/legacy/shim.ts', diff: '+a\n', truncated: true),
    );

    expect(find.textContaining('cut at 64 KiB'), findsOne);
  });

  testWidgets('a host that could not answer is a sentence, not a spinner forever', (tester) async {
    await show(tester, () async => null);

    expect(find.text('the machine could not produce this diff'), findsOne);
  });
}
