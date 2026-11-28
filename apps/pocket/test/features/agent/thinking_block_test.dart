import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/chat_layout.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';
import 'package:lotus_pocket/features/agent/widgets/thinking_block.dart';

final _at = DateTime.fromMillisecondsSinceEpoch(1788820000000);

ChatItem _item(ChatLine kind, String text, {int plus = 0}) =>
    ChatItem(kind: kind, text: text, timestamp: _at.add(Duration(seconds: plus)));

Widget _host(Widget child) => MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  /// Reasoning folds with the work it belongs to, not on its own.
  ///
  /// It used to have a fold of its own, [ThinkingRow], open while it was the newest thing
  /// and closed once prose arrived. Issue 03 of `plans/pocket-chat-turn-presentation`
  /// removed that: reasoning and tool steps answer one question — *what did it do to get
  /// there* — and two folds gave one idea two appearances.
  group('ChatLayout, reasoning', () {
    test('consecutive reasoning folds into one run of work', () {
      final rows = ChatLayout.of(ChatTranscript([
        _item(ChatLine.prompt, 'kenapa flaky?'),
        _item(ChatLine.thinking, 'Flaky di CI tapi tidak lokal soal waktu.', plus: 1),
        _item(ChatLine.thinking, 'Yang saya mau lihat: menunggu kondisi atau durasi.', plus: 2),
      ])).rows;

      final run = rows.whereType<StepRunRow>().single;
      expect(run.steps, hasLength(2));
      // No step among them, so the capsule says what it is rather than counting nothing.
      expect(run.countLabel, 'thinking');
      expect(run.summary, 'thinking ×2');
    });

    test('a step between two thoughts no longer breaks the block', () {
      // It did, while reasoning had a fold of its own: a step ended the thought. Now the
      // step is a member of the same run, so all three fold together and the order is
      // kept inside the fold rather than announced by three rows.
      final rows = ChatLayout.of(ChatTranscript([
        _item(ChatLine.thinking, 'satu'),
        _item(ChatLine.step, 'a.dart', plus: 1),
        _item(ChatLine.thinking, 'dua', plus: 2),
      ])).rows;

      final run = rows.whereType<StepRunRow>().single;
      expect(run.steps, hasLength(3));
      expect(run.stepCount, 1);
      // `_item` names no tool, and the summary skips a line with no label rather than
      // inventing one — so what it can say here is the reasoning.
      expect(run.summary, 'thinking ×2');
    });

    test('prose still ends a run, because it is not work', () {
      final rows = ChatLayout.of(ChatTranscript([
        _item(ChatLine.thinking, 'menimbang…'),
        _item(ChatLine.thinking, 'masih menimbang…', plus: 1),
        _item(ChatLine.prose, 'Bukan logikanya — test itu menunggu durasi.', plus: 2),
      ])).rows;

      expect(rows.whereType<StepRunRow>(), hasLength(1));
      // The answer is the one thing left at full size.
      expect(rows.whereType<LineRow>().single.item.kind, ChatLine.prose);
    });
  });

  group('ThinkingBlock', () {
    testWidgets('open shows every paragraph', (tester) async {
      await tester.pumpWidget(_host(ThinkingBlock(
        items: [_item(ChatLine.thinking, 'satu'), _item(ChatLine.thinking, 'dua')],
        open: true,
      )));
      expect(find.text('satu'), findsOneWidget);
      expect(find.text('dua'), findsOneWidget);
      expect(find.text('THINKING'), findsOneWidget);
    });

    testWidgets('closed keeps the last line and says how much is folded', (tester) async {
      // Nothing is hidden — only ranked. The last line is the one nearest the answer.
      await tester.pumpWidget(_host(ThinkingBlock(
        items: [_item(ChatLine.thinking, 'satu'), _item(ChatLine.thinking, 'dua')],
        open: false,
        onToggle: () {},
      )));
      expect(find.text('satu'), findsNothing);
      expect(find.text('dua'), findsOneWidget);
      expect(find.text('2 paragraphs'), findsOneWidget);
    });

    testWidgets('a settled block can be opened, and an open one has nothing to toggle',
        (tester) async {
      var toggled = 0;
      await tester.pumpWidget(_host(ThinkingBlock(
        items: [_item(ChatLine.thinking, 'satu')],
        open: false,
        onToggle: () => toggled++,
      )));
      await tester.tap(find.text('satu'));
      expect(toggled, 1);

      await tester.pumpWidget(_host(ThinkingBlock(
        items: [_item(ChatLine.thinking, 'satu')],
        open: true,
      )));
      expect(find.byType(InkWell), findsNothing);
    });
  });
}
