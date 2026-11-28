import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/home/widgets/needs_you.dart';
import 'package:lotus_pocket/features/home/widgets/slide_to_answer.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/permission.dart';

const Cell kai = Cell(
  host: HostId('mac'),
  paneId: 'p1',
  workspaceId: 'w1',
  agentType: 'claude',
  title: 'Kai',
  status: 'live',
  isAlive: true,
  turn: Cell.turnNeedsInput,
  lastOutputPreview: 'Bash(bun test --watch)',
);

PermissionSnapshot ask(List<(String, String)> options, {String? kind}) => PermissionSnapshot(
  paneId: 'p1',
  awaiting: true,
  hostSupports: true,
  prompt: PermissionPrompt(
    question: 'Do you want to proceed?',
    ask: kind,
    options: [for (final (k, l) in options) PromptOption(key: k, label: l, selected: false)],
  ),
);

final threeWay = ask([
  ('1', 'Yes'),
  ('2', "Yes, and don't ask again for bun test commands"),
  ('3', 'No, and tell Claude what to do differently (esc)'),
]);

void main() {
  late List<String> sent;
  late List<Cell> opened;
  late bool land;

  setUp(() {
    sent = [];
    opened = [];
    land = true;
  });

  Widget app({PermissionSnapshot? snapshot, bool wired = true}) => MaterialApp(
    theme: buildAppTheme(),
    home: Scaffold(
      body: NeedsYou(
        waiting: const [kai],
        onOpen: opened.add,
        where: (_) => 'Orbit',
        loadAsk: wired ? (_) async => snapshot : null,
        onAnswer: wired
            ? (_, _, option) async {
                sent.add(option.key);
                return land;
              }
            : null,
      ),
    ),
  );

  Future<void> slide(WidgetTester tester, double fraction) async {
    final track = tester.getRect(find.byType(SlideToAnswer));
    final travel = (track.width - 40) / 2 - 4;
    await tester.dragFrom(track.center, Offset(travel * fraction, 0));
    await tester.pumpAndSettle();
  }

  testWidgets('a safe prompt gets a slider; its ends are the prompt\'s own first words', (tester) async {
    await tester.pumpWidget(app(snapshot: threeWay));
    await tester.pumpAndSettle();
    expect(find.byType(SlideToAnswer), findsOneWidget);
    expect(find.text('Yes'), findsOneWidget);
    expect(find.text('No'), findsOneWidget);
    expect(find.text('Wants your OK'), findsOneWidget);
    expect(find.text('Bash(bun test --watch)'), findsOneWidget);
  });

  testWidgets('sliding right past 70% sends the printed digit of plain Yes', (tester) async {
    await tester.pumpWidget(app(snapshot: threeWay));
    await tester.pumpAndSettle();
    await slide(tester, 0.9);
    expect(sent, ['1']);
  });

  testWidgets('sliding left past 70% sends the No digit', (tester) async {
    await tester.pumpWidget(app(snapshot: threeWay));
    await tester.pumpAndSettle();
    await slide(tester, -0.9);
    expect(sent, ['3']);
  });

  testWidgets('a short slide sends nothing and the thumb goes home', (tester) async {
    await tester.pumpWidget(app(snapshot: threeWay));
    await tester.pumpAndSettle();
    await slide(tester, 0.5);
    expect(sent, isEmpty);
  });

  testWidgets('tapping a label only nudges, it never answers', (tester) async {
    await tester.pumpWidget(app(snapshot: threeWay));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Yes'));
    await tester.pumpAndSettle();
    expect(sent, isEmpty);
  });

  testWidgets('a refused answer can be slid again', (tester) async {
    land = false;
    await tester.pumpWidget(app(snapshot: threeWay));
    await tester.pumpAndSettle();
    await slide(tester, 0.9);
    await slide(tester, 0.9);
    expect(sent, ['1', '1']);
  });

  testWidgets('a screen reader gets both answers as plain actions', (tester) async {
    final semantics = tester.ensureSemantics();
    await tester.pumpWidget(app(snapshot: threeWay));
    await tester.pumpAndSettle();
    final node = tester.getSemantics(find.bySemanticsLabel('Slide to answer'));
    final labels = node
        .getSemanticsData()
        .customSemanticsActionIds!
        .map((id) => CustomSemanticsAction.getAction(id)!.label)
        .toList();
    expect(labels, containsAll(['Yes', 'No, and tell Claude what to do differently (esc)']));
    semantics.dispose();
  });

  testWidgets('a question gets View and Answer, both open Chat', (tester) async {
    await tester.pumpWidget(app(snapshot: ask([('1', 'Postgres'), ('2', 'SQLite')], kind: 'question')));
    await tester.pumpAndSettle();
    expect(find.byType(SlideToAnswer), findsNothing);
    expect(find.text('Needs an answer'), findsOneWidget);
    await tester.tap(find.text('Answer'));
    expect(opened, [kai]);
  });

  testWidgets('a prompt without a plain Yes is answered in Chat, never guessed', (tester) async {
    await tester.pumpWidget(app(snapshot: ask([('1', 'Yes, allow all edits'), ('2', 'No')])));
    await tester.pumpAndSettle();
    expect(find.byType(SlideToAnswer), findsNothing);
    expect(find.text('Answer in Chat'), findsOneWidget);
  });

  testWidgets('unwired, the slip still opens the agent', (tester) async {
    await tester.pumpWidget(app(wired: false));
    await tester.pumpAndSettle();
    expect(find.byType(SlideToAnswer), findsNothing);
    await tester.tap(find.text('Kai'));
    expect(opened, [kai]);
  });
}
