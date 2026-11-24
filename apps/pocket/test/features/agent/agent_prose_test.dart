import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/agent/widgets/agent_prose.dart';
import 'package:lotus_pocket/features/agent/widgets/prose_table.dart';

Future<void> pumpProse(WidgetTester tester, String markdown) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: SingleChildScrollView(child: AgentProse(text: markdown)),
      ),
    ),
  );
  await tester.pump();
}

/// Every string this render put on screen, whether it came from a [Text] or from a
/// rich span — a chip built as a `WidgetSpan` shows up as its own entry, which is
/// exactly the difference these tests are about.
List<String> renderedText(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((w) => w.data ?? w.textSpan?.toPlainText() ?? '')
    .toList();

void main() {
  group('brackets are the agent\'s words, not markup', () {
    testWidgets('[2] stays a bracketed digit inside a sentence', (tester) async {
      await pumpProse(tester, 'Pilih opsi [2] pada baris [42] file itu.');

      // The whole sentence in one run: before `SourceTag` was dropped this came out as
      // `Pilih opsi ￼ pada baris ￼` with `2` and `42` hoisted into separate chips.
      expect(
        renderedText(tester).join('\n'),
        contains('Pilih opsi [2] pada baris [42] file itu.'),
      );
    });

    testWidgets('no chip is drawn for it', (tester) async {
      await pumpProse(tester, 'baris [42]');

      final chips = tester
          .widgetList<Material>(find.byType(Material))
          .where((m) => m.shape is OvalBorder);
      expect(chips, isEmpty);
    });

    testWidgets('the inline set is the package default minus SourceTag', (tester) async {
      // Pinned rather than trusted: `inlineComponents` replaces the default list, so a
      // package upgrade that adds a component would silently lose it here. If this
      // fails after an upgrade, re-read the package's list and add what is new.
      const plain = AgentProse(text: '');
      final ours = plain.debugInlineComponents.map((c) => c.runtimeType).toSet();
      final theirs =
          MarkdownComponent.inlineComponents.map((c) => c.runtimeType).toSet();

      expect(theirs.difference(ours), {SourceTag});
      expect(ours.difference(theirs), isEmpty,
          reason: 'this one carries no link handler, so it adds nothing of its own');
    });
  });

  group('tables', () {
    const table = '| kolom | nilai | catatan |\n'
        '|---|---|---|\n'
        '| encoder | software | penyebabnya |\n'
        '| pembatas | cpu | — |';

    testWidgets('render through ProseTable, not a Material Table', (tester) async {
      await pumpProse(tester, table);

      expect(find.byType(ProseTable), findsOneWidget);
      expect(find.byType(Table), findsNothing);
    });

    testWidgets('are ruled with hairlines, never boxed in text colour', (tester) async {
      await pumpProse(tester, table);

      final tokens = AppTokens.dark;
      final rules = tester
          .widgetList<Container>(find.descendant(
            of: find.byType(ProseTable),
            matching: find.byType(Container),
          ))
          .map((c) => c.color)
          .whereType<Color>()
          .toList();

      expect(rules, isNotEmpty);
      expect(rules.every((c) => c == tokens.line), isTrue,
          reason: 'a rule in any other colour is the fence this design forbids');
      expect(rules.contains(tokens.text), isFalse);
    });

    testWidgets('scroll sideways rather than compressing their columns', (tester) async {
      await pumpProse(tester, table);

      final scroller = find.descendant(
        of: find.byType(ProseTable),
        matching: find.byType(SingleChildScrollView),
      );
      expect(scroller, findsOneWidget);
      expect(
        tester.widget<SingleChildScrollView>(scroller).scrollDirection,
        Axis.horizontal,
      );

      // Three columns at their own width, whatever the phone is: the test surface is
      // 800 logical pixels wide, so this only holds because the width is measured
      // rather than divided.
      final row = tester
          .widgetList<SizedBox>(find.descendant(
            of: find.byType(ProseTable),
            matching: find.byType(SizedBox),
          ))
          .where((b) => b.width == kProseTableColumnWidth);
      expect(row.length, greaterThanOrEqualTo(3));
    });
  });

  testWidgets('a fenced block still renders as a block with its own copy button',
      (tester) async {
    await pumpProse(tester, 'jalankan\n\n```bash\nadb devices\n```\n');

    expect(renderedText(tester), contains('adb devices'));
    expect(renderedText(tester), contains('COPY'));
  });
}
