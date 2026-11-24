import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/widgets/answer_chips.dart';
import 'package:lotus_pocket/models/permission.dart';

const PermissionPrompt three = PermissionPrompt(
  question: 'Do you want to delete src/legacy/shim.ts?',
  options: [
    PromptOption(key: '1', label: 'Yes', selected: true),
    PromptOption(key: '2', label: 'Yes, allow all edits during this session (shift+tab)', selected: false),
    PromptOption(key: '3', label: 'No', selected: false),
  ],
);

Future<List<PromptOption>> show(WidgetTester tester, {double width = 360}) async {
  final answered = <PromptOption>[];
  tester.view
    ..physicalSize = Size(width, 640)
    ..devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: buildAppTheme(),
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: AnswerChips(agent: 'Atlas', prompt: three, onAnswer: answered.add),
      ),
    ),
  ));
  return answered;
}

Finder chip(String key) => find.bySemanticsLabel(RegExp('^$key\\b'));

void main() {
  testWidgets('one 44px chip per option, all the same width', (tester) async {
    await show(tester);

    final sizes = [for (final key in ['1', '2', '3']) tester.getSize(chip(key))];
    for (final size in sizes) {
      expect(size.height, AnswerChips.height);
      expect(size.width, sizes.first.width);
    }
  });

  testWidgets('says who is waiting, in one line above the chips', (tester) async {
    await show(tester);

    final title = find.text('Atlas is waiting for your choice');
    expect(title, findsOne);
    expect(tester.getBottomLeft(title).dy, lessThanOrEqualTo(tester.getTopLeft(chip('1')).dy));
  });

  testWidgets('labels are the prompt’s own words, cut to one line', (tester) async {
    await show(tester);

    final long = tester.widget<Text>(
      find.text('Yes, allow all edits during this session (shift+tab)'),
    );
    expect(long.maxLines, 1);
    expect(long.overflow, TextOverflow.ellipsis);
    expect(tester.takeException(), isNull);
  });

  testWidgets('tapping the second chip answers with its printed digit', (tester) async {
    final answered = await show(tester);

    await tester.tap(chip('2'));
    await tester.pump();

    expect(answered.single.key, '2');
  });

  /// ADR-8's equal weight, kept against the B1 mockup's filled first chip: option 1 is
  /// usually `Yes`, and a filled Yes beside outlined Nos is the path of least resistance.
  testWidgets('no answer is drawn heavier than another', (tester) async {
    await show(tester);

    final fills = tester
        .widgetList<Material>(find.descendant(of: find.byType(AnswerChips), matching: find.byType(Material)))
        .map((m) => m.color)
        .toSet();
    expect(fills, hasLength(1));
  });
}
