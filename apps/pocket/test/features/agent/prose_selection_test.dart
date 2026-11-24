import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';
import 'package:lotus_pocket/features/agent/widgets/quote_strip.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_lines.dart';
import 'package:lotus_pocket/features/agent/widgets/prose_selection.dart';

ChatItem reply(String text) => ChatItem(
      kind: ChatLine.prose,
      text: text,
      timestamp: DateTime(2026, 9, 16, 14, 7),
    );

Future<void> show(
  WidgetTester tester,
  ChatItem item, {
  void Function(String)? onQuote,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: SingleChildScrollView(
          child: ProseLine(item: item, agent: 'nita', onQuote: onQuote),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  group('a reply can be selected', () {
    testWidgets('the prose sits inside its own selection region', (tester) async {
      await show(tester, reply('Dugaan terkuat: HP-mu meng-encode dengan software.'));

      // One per message, not one around the list: a region spanning the transcript
      // would let a drag run into the next turn and return words nobody said.
      expect(find.byType(SelectionArea), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(SelectionArea),
          matching: find.byType(SelectableProse),
        ),
        findsNothing,
        reason: 'the region is inside SelectableProse, not wrapped around it',
      );
    });

    testWidgets('holding the line no longer opens a sheet over it', (tester) async {
      await show(tester, reply('Dugaan terkuat: HP-mu meng-encode dengan software.'));

      await tester.longPress(find.textContaining('Dugaan terkuat', findRichText: true).first);
      await tester.pumpAndSettle();

      // The measurement this whole change came from: with the sheet still bound to a
      // long press, the sheet won the gesture and selection never started.
      expect(find.byType(BottomSheet), findsNothing);
      expect(find.byType(ListTile), findsNothing);
    });

    testWidgets('the time it was said is on the line, not behind a gesture',
        (tester) async {
      await show(tester, reply('sudah kubereskan'));

      expect(find.text('14:07'), findsOneWidget);
    });
  });

  group('what the row under a reply does', () {
    testWidgets('ADD TO CHAT hands the whole reply to the composer', (tester) async {
      String? quoted;
      await show(tester, reply('ganti Codec ke H.264'), onQuote: (text) => quoted = text);

      await tester.tap(find.text('ADD TO CHAT'));
      await tester.pump();

      expect(quoted, 'ganti Codec ke H.264');
    });

    testWidgets('COPY puts it on the clipboard', (tester) async {
      final copied = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied.add((call.arguments as Map)['text'] as String);
          }
          return null;
        },
      );
      addTearDown(() => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));

      await show(tester, reply('ganti Codec ke H.264'));
      await tester.tap(find.text('COPY'));
      await tester.pump();

      expect(copied, ['ganti Codec ke H.264']);
    });

    testWidgets('offers no quote where there is nothing to quote into', (tester) async {
      await show(tester, reply('ganti Codec ke H.264'));

      // Not drawn rather than drawn and inert — the rule the stop control already keeps.
      expect(find.text('ADD TO CHAT'), findsNothing);
      expect(find.text('COPY'), findsOneWidget);
    });

    testWidgets('both targets are 44 tall, like every other control here',
        (tester) async {
      await show(tester, reply('ganti Codec ke H.264'), onQuote: (_) {});

      for (final label in ['COPY', 'ADD TO CHAT']) {
        expect(tester.getSize(find.ancestor(
          of: find.text(label),
          matching: find.byType(InkWell),
        )).height, 44);
      }
    });
  });

  group('the toolbar this app draws for a selection', () {
    Future<void> pumpPill(
      WidgetTester tester, {
      void Function(String)? onQuote,
      VoidCallback? onDone,
    }) =>
        tester.pumpWidget(MaterialApp(
          theme: buildAppTheme(),
          home: Scaffold(
            body: SelectionPill(
              anchors: const TextSelectionToolbarAnchors(
                primaryAnchor: Offset(120, 300),
                secondaryAnchor: Offset(120, 420),
              ),
              selected: ValueNotifier<String>('software, bukan chip encoder'),
              onQuote: onQuote,
              onDone: onDone ?? () {},
            ),
          ),
        ));

    testWidgets('carries copy as well as quote, because the OEM menu carried neither',
        (tester) async {
      await pumpPill(tester, onQuote: (_) {});

      // `issues/08`: on a phone with seven PROCESS_TEXT apps installed, the item this app
      // contributed to the system toolbar appeared in neither the bar nor its overflow.
      expect(find.text('COPY'), findsOneWidget);
      expect(find.text('ADD TO CHAT'), findsOneWidget);
    });

    testWidgets('quotes the selected run, not the whole reply', (tester) async {
      String? quoted;
      await pumpPill(tester, onQuote: (text) => quoted = text);

      await tester.tap(find.text('ADD TO CHAT'));
      await tester.pump();

      expect(quoted, 'software, bukan chip encoder');
    });

    testWidgets('clears the selection after either action', (tester) async {
      var done = 0;
      await pumpPill(tester, onQuote: (_) {}, onDone: () => done++);

      await tester.tap(find.text('ADD TO CHAT'));
      await tester.pump();
      expect(done, 1);

      await tester.tap(find.text('COPY'));
      await tester.pumpAndSettle();
      expect(done, 2);
    });

    testWidgets('offers copy alone where there is no composer', (tester) async {
      await pumpPill(tester);

      expect(find.text('COPY'), findsOneWidget);
      expect(find.text('ADD TO CHAT'), findsNothing);
    });

    testWidgets('both actions clear 44', (tester) async {
      await pumpPill(tester, onQuote: (_) {});

      for (final label in ['COPY', 'ADD TO CHAT']) {
        expect(
          tester.getSize(find.ancestor(of: find.text(label), matching: find.byType(InkWell))).height,
          kMinHitTarget,
        );
      }
    });
  });

  group('what the agent finally receives', () {
    test('the quote is marked up only at dispatch', () {
      expect(
        withQuote('software, bukan chip encoder', 'di mana aku ganti codec-nya?'),
        '> software, bukan chip encoder\n\ndi mana aku ganti codec-nya?',
      );
    });

    test('every line of a multi-line quote carries its marker', () {
      expect(
        quoteBlock('Encoder: SOFTWARE\nPembatas: cpu'),
        '> Encoder: SOFTWARE\n> Pembatas: cpu',
      );
    });

    test('a reply with nothing held is sent exactly as typed', () {
      expect(withQuote(null, 'lanjutkan'), 'lanjutkan');
      expect(withQuote('   ', 'lanjutkan'), 'lanjutkan');
    });
  });
}
