import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';
import 'package:lotus_pocket/features/agent/pending_dispatch.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_lines.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_marks.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_view.dart';

final DateTime at = DateTime.utc(2026, 8, 7, 12);

ChatItem prose(String text, {bool truncated = false}) => ChatItem(
      kind: ChatLine.prose,
      text: text,
      truncated: truncated,
      timestamp: at,
    );

ChatItem step(String target, {String? diff}) =>
    ChatItem(kind: ChatLine.step, text: target, label: 'Bash', diff: diff, timestamp: at);

/// Every font family named anywhere in a span tree.
Set<String> _families(InlineSpan root) {
  final found = <String>{};
  void walk(InlineSpan span) {
    found.addAll(span.style?.fontFamilyFallback ?? const []);
    final family = span.style?.fontFamily;
    if (family != null) found.add(family);
    span.visitChildren((child) {
      if (!identical(child, span)) walk(child);
      return true;
    });
  }

  walk(root);
  return found;
}

void main() {
  _turnGapTests();
  Future<void> show(
    WidgetTester tester,
    List<ChatItem> items, {
    Widget? footer,
    int? historyEdgeAt,
    List<PendingDispatch> pending = const [],
    String? live,
    String? emptyNote,
    void Function(PendingDispatch)? onRetry,
  }) =>
      tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: ChatView(
            transcript: ChatTranscript(items),
            agent: 'Atlas',
            onOpenTerminal: () {},
            onRefresh: () async {},
            footer: footer,
            historyEdgeAt: historyEdgeAt,
            pending: pending,
            live: live,
            emptyNote: emptyNote,
            onRetry: onRetry,
          ),
        ),
      ));

  /// The caret that appears once the operator has scrolled away from the end.
  ///
  /// Found by its glyph rather than by semantics label: `find.bySemanticsLabel` needs a
  /// semantics handle this test has no other reason to open.
  final jumpToLatest = find.text('⌄');

  /// Every string the widget tree actually renders.
  String rendered(WidgetTester tester) => tester
      .widgetList<Text>(find.byType(Text))
      .map((t) => t.data ?? t.textSpan?.toPlainText() ?? '')
      .join('\n');

  group('the agent writes markdown, so Chat renders markdown', () {
    testWidgets('a heading is text, not a row of hashes', (tester) async {
      await show(tester, [prose('## Rantai pewarisannya\n\nSaya telusuri prosesnya.')]);

      final text = rendered(tester);
      expect(text, contains('Rantai pewarisannya'));
      // The exact defect this replaced: the syntax reaching the screen as characters.
      expect(text, isNot(contains('## ')));
    });

    testWidgets('a heading stays in the agent\'s own typeface', (tester) async {
      await show(tester, [prose('## What I found\n\nNeither file is referenced.')]);

      // Caught by looking at the emulator, not by a test: left to itself the renderer
      // takes headings from Material's `textTheme`, which is sans — a third voice on a
      // screen where serif means "what it said" and mono means "what it did".
      // Walked rather than read off the widget: the renderer applies a heading style to
      // the *children* of a span, so both `Text.style` and the root span's style are
      // null and only a descendant carries the answer.
      // Walked to the `RichText` rather than taken off the `Text` element: since prose
      // became selectable, `gpt_markdown` wraps each run in its `SelectableAdapter`, so
      // the element's own render object is that wrapper's `RenderMouseRegion`.
      final heading = tester.renderObject<RenderParagraph>(
        find
            .descendant(
              of: find.textContaining('What I found').first,
              matching: find.byType(RichText),
            )
            .first,
      );
      expect(_families(heading.text), contains('Georgia'));
    });

    testWidgets('bold is weight, not asterisks', (tester) async {
      await show(tester, [prose('Jadi **app Lotus Dev** dijalankan dari sesi lain.')]);

      final text = rendered(tester);
      expect(text, contains('app Lotus Dev'));
      expect(text, isNot(contains('**')));
    });

    testWidgets('a fenced block keeps its code and drops its fence', (tester) async {
      await show(tester, [
        prose('Rantainya:\n\n```\nzsh (kiro-cli-term)\n└── ccs acme\n```\n'),
      ]);

      final text = rendered(tester);
      expect(text, contains('zsh (kiro-cli-term)'));
      expect(text, isNot(contains('```')));
    });

    testWidgets('a fenced block scrolls sideways rather than reflowing', (tester) async {
      // `issues/03` measured a real session at 93 columns against a 390px phone and
      // found that re-flowing to a narrower width turns code into overlapping nonsense.
      // Wrapping a shell command does the same thing more quietly.
      await show(tester, [prose('```bash\n${'x' * 200}\n```')]);

      final scrollables = tester.widgetList<SingleChildScrollView>(
        find.byType(SingleChildScrollView),
      );
      expect(
        scrollables.any((s) => s.scrollDirection == Axis.horizontal),
        isTrue,
        reason: 'the block moves under the finger; the page must not scroll sideways',
      );
    });

    testWidgets('inline code survives without its backticks', (tester) async {
      await show(tester, [prose('Set `CLAUDE_CODE_CHILD_SESSION=1` in the env.')]);

      final text = rendered(tester);
      expect(text, contains('CLAUDE_CODE_CHILD_SESSION=1'));
      expect(text, isNot(contains('`')));
    });
  });

  group('a reply the host cut', () {
    testWidgets('says so, rather than looking finished', (tester) async {
      await show(tester, [prose('I removed the shim and updated the three call', truncated: true)]);

      expect(find.textContaining('cut short by the host'), findsOne);
    });

    testWidgets('an ordinary reply claims nothing', (tester) async {
      await show(tester, [prose('Done.')]);

      expect(find.textContaining('cut short'), findsNothing);
    });
  });

  group('sticky scroll', () {
    /// A transcript tall enough to scroll. Prose, because Chat no longer draws steps.
    List<ChatItem> manySteps(int n) => [
          for (var i = 0; i < n; i++)
            prose('line number $i in a long transcript'),
        ];

    testWidgets('opens at the newest, not at the top', (tester) async {
      await show(tester, manySteps(80));
      await tester.pumpAndSettle();

      final position = tester.widget<Scrollable>(find.byType(Scrollable).first).controller!.position;
      expect(position.pixels, closeTo(position.maxScrollExtent, 1));
    });

    testWidgets('a waiting permission card is on screen without scrolling', (tester) async {
      // The defect the fixture change surfaced: the card sits after the transcript, so
      // a long enough transcript put the thing the operator was woken up for below the
      // fold. Opening at the bottom is what actually fixes it.
      await show(
        tester,
        manySteps(80),
        footer: const Text('Do you want to delete src/legacy/shim.ts?'),
      );
      await tester.pumpAndSettle();

      expect(find.text('Do you want to delete src/legacy/shim.ts?'), findsOne);
      final box = tester.getRect(find.text('Do you want to delete src/legacy/shim.ts?'));
      expect(box.bottom, lessThanOrEqualTo(tester.view.physicalSize.height));
    });

    testWidgets('scrolling up releases the stick and offers the way back', (tester) async {
      await show(tester, manySteps(80));
      await tester.pumpAndSettle();
      expect(jumpToLatest, findsNothing);

      await tester.drag(find.byType(ListView), const Offset(0, 600));
      await tester.pumpAndSettle();

      // Reading something from earlier in the turn must not be yanked away every time
      // the agent runs another tool — on this screen that happens several times a
      // minute.
      expect(jumpToLatest, findsOne);
    });

    /// The case an operator hit on a real phone, 2026-09-06: steps arrived live — proven on the
    /// wire — and the view stayed put, offering "N new" instead of following. Every sticky-scroll
    /// test here covered the operator having scrolled AWAY; none covered them not having moved.
    testWidgets('follows new output when the operator has not moved', (tester) async {
      await show(tester, manySteps(80));
      await tester.pumpAndSettle();

      await show(tester, manySteps(90));
      await tester.pumpAndSettle();

      final position = tester.widget<Scrollable>(find.byType(Scrollable).first).controller!.position;
      expect(position.pixels, closeTo(position.maxScrollExtent, 1),
          reason: 'an operator at the end is watching the agent work');
      expect(jumpToLatest, findsNothing,
          reason: 'nothing is unread when the view followed it down');
    });

    testWidgets('new output does not drag the view while the operator is reading up',
        (tester) async {
      await show(tester, manySteps(80));
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView), const Offset(0, 600));
      await tester.pumpAndSettle();

      final before =
          tester.widget<Scrollable>(find.byType(Scrollable).first).controller!.position.pixels;
      await show(tester, manySteps(90));
      await tester.pumpAndSettle();

      final after =
          tester.widget<Scrollable>(find.byType(Scrollable).first).controller!.position.pixels;
      expect(after, closeTo(before, 1));
    });

    testWidgets('coming back to the bottom sticks again', (tester) async {
      await show(tester, manySteps(80));
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView), const Offset(0, 600));
      await tester.pumpAndSettle();

      await tester.tap(jumpToLatest);
      await tester.pumpAndSettle();

      expect(jumpToLatest, findsNothing);
      final position = tester.widget<Scrollable>(find.byType(Scrollable).first).controller!.position;
      expect(position.pixels, closeTo(position.maxScrollExtent, 1));
    });

    testWidgets('what arrived while the operator was reading up is counted', (tester) async {
      await show(tester, manySteps(80));
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView), const Offset(0, 600));
      await tester.pumpAndSettle();
      // Nothing has arrived yet, so the control says only "there is more below".
      expect(find.textContaining('new'), findsNothing);

      await show(tester, manySteps(90));
      await tester.pumpAndSettle();

      // The count is the difference between "there is more" and "there is a lot more",
      // which is what decides whether to skim back or jump.
      expect(find.text('10 new'), findsOne);
    });
  });

  group('the bubble hugs what you said', () {
    ChatItem mine(String text) =>
        ChatItem(kind: ChatLine.prompt, text: text, timestamp: at);

    testWidgets('a two-character message does not draw a screen-wide panel',
        (tester) async {
      await show(tester, [mine('Hi')]);
      await tester.pumpAndSettle();

      // Seen on a real phone: `Hi` drew a bubble the width of the list with two
      // characters floating at its left edge. A bubble is a shape drawn *around* a
      // sentence; one that ignores the sentence is a panel.
      final bubble = tester.getSize(find.byType(MineBubble));
      expect(bubble.width, lessThan(tester.view.physicalSize.width / 3));
    });

    testWidgets('a long message stops short of the edge rather than filling it',
        (tester) async {
      await show(tester, [mine('run the whole suite and tell me which files it touched')]);
      await tester.pumpAndSettle();

      final list = tester.getSize(find.byType(ListView));
      final bubble = tester.getSize(find.byType(MineBubble));
      // Still one side of a conversation, not the page.
      expect(bubble.width, lessThan(list.width));
    });
  });

  testWidgets('tool steps are not drawn in Chat — they stay in Terminal', (tester) async {
    await show(tester, [step('first/target.ts'), step('second/target.ts'), prose('Done.')]);
    await tester.pumpAndSettle();

    expect(find.textContaining('target.ts'), findsNothing);
    expect(find.text('Done.'), findsOne);
  });

  group('what the operator said, before the host has echoed it', () {
    const sent = PendingDispatch(text: 'run the tests');

    testWidgets('appears immediately, marked as still in flight', (tester) async {
      await show(tester, [prose('Done.')], pending: const [sent]);
      await tester.pumpAndSettle();

      // The gap this closes: a dispatch crosses the biometric gate and an HTTP round
      // trip before the transcript carries it, and over a tailnet that is seconds of a
      // screen where what you just typed is nowhere.
      expect(find.text('run the tests'), findsOne);
      expect(find.text('sending…'), findsOne);
    });

    testWidgets('a refusal stays on the line, carrying its own retry', (tester) async {
      await show(tester, [prose('Done.')], pending: [sent.refused]);
      await tester.pumpAndSettle();

      // Not a snackbar: that reports the failure elsewhere, times out, and leaves
      // nothing behind for an operator who was walking.
      expect(find.text('not sent · tap to retry'), findsOne);
    });

    testWidgets('tapping a refused line asks for it to be sent again', (tester) async {
      final retried = <String>[];
      await show(
        tester,
        [prose('Done.')],
        pending: [sent.refused],
        onRetry: (p) => retried.add(p.text),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('run the tests'));
      await tester.pumpAndSettle();

      expect(retried, ['run the tests']);
    });

    testWidgets('a line still in flight is not a retry target', (tester) async {
      final retried = <String>[];
      await show(tester, [prose('Done.')], pending: const [sent], onRetry: (p) => retried.add(p.text));
      await tester.pumpAndSettle();

      await tester.tap(find.text('run the tests'));
      await tester.pumpAndSettle();

      expect(retried, isEmpty);
    });
  });

  group('the two edges of the list say what they are', () {
    testWidgets('the top names the limit of what the host keeps', (tester) async {
      await show(tester, [prose('Done.')], historyEdgeAt: 60);
      await tester.pumpAndSettle();

      // A transcript that simply stops reads as "this is everything", and it is not.
      expect(find.textContaining('last 60 entries'), findsOne);
    });

    testWidgets('below the cap it claims nothing, because nothing was dropped', (tester) async {
      await show(tester, [prose('Done.')]);
      await tester.pumpAndSettle();

      expect(find.textContaining('last 60 entries'), findsNothing);
    });

    testWidgets('the tail says the agent is working, where the eye already is',
        (tester) async {
      await show(tester, [prose('Done.')], live: 'atlas · 312 of 476 suites');
      await tester.pumpAndSettle();

      expect(find.text('atlas · 312 of 476 suites'), findsOne);
    });
  });

  group('an empty transcript says it is empty', () {
    testWidgets('nothing recorded yet reads as that, not as a broken screen',
        (tester) async {
      await show(tester, const [], emptyNote: 'Nothing recorded for this agent yet.');
      await tester.pumpAndSettle();

      // The host's ring lives in memory, so this is the normal state after a desktop
      // restart — and it used to draw a page holding only the RAW TERMINAL row.
      expect(find.text('Nothing recorded for this agent yet.'), findsOne);
    });

    testWidgets('one line is already an answer, so the note stays away', (tester) async {
      await show(tester, [prose('Done.')], emptyNote: 'Nothing recorded for this agent yet.');
      await tester.pumpAndSettle();

      // The app talking over the agent is worse than the app staying quiet.
      expect(find.text('Nothing recorded for this agent yet.'), findsNothing);
    });

    testWidgets('a sentence still in flight counts as a row', (tester) async {
      await show(
        tester,
        const [],
        pending: const [PendingDispatch(text: 'run the tests')],
        emptyNote: 'Nothing recorded for this agent yet.',
      );
      await tester.pumpAndSettle();

      // The operator can see their own words on screen; telling them nothing is there
      // would contradict the bubble directly above.
      expect(find.text('run the tests'), findsOne);
      expect(find.text('Nothing recorded for this agent yet.'), findsNothing);
    });
  });

  group('the top edge of the transcript', () {
    testWidgets('dissolves into the floor rather than slicing a line flat',
        (tester) async {
      await show(tester, [for (var i = 0; i < 20; i++) prose('baris $i')]);
      await tester.pumpAndSettle();

      final fade = find.byWidgetPredicate((w) =>
          w is Container &&
          w.decoration is BoxDecoration &&
          (w.decoration! as BoxDecoration).gradient != null);
      expect(fade, findsOneWidget);
      // Nothing under it may lose the thumb — the band sits exactly where a reader
      // reaches to scroll back.
      expect(
        find.ancestor(of: fade, matching: find.byType(IgnorePointer)),
        findsWidgets,
      );

      final gradient =
          (tester.widget<Container>(fade).decoration! as BoxDecoration).gradient!
              as LinearGradient;
      // Opaque floor at the top, nothing at the bottom: the same colour the page is
      // painted in, so the fade is invisible except where a row runs under it.
      expect(gradient.colors.first, AppTokens.dark.bg);
      expect(gradient.colors.last.a, 0);
    });

    testWidgets('does not take the thumb where the operator scrolls back',
        (tester) async {
      await show(tester, [for (var i = 0; i < 60; i++) prose('baris $i')]);
      await tester.pumpAndSettle();

      final position = tester.state<ScrollableState>(find.byType(Scrollable).first).position;
      final before = position.pixels;

      // A drag starting inside the fade band must still scroll the list — an overlay
      // that ate it would freeze the top 28px of the screen.
      await tester.dragFrom(
        tester.getTopLeft(find.byType(ChatView)) + const Offset(180, 14),
        const Offset(0, 260),
      );
      await tester.pumpAndSettle();

      expect(position.pixels, lessThan(before));
    });
  });

  /// **Scrolling up must not move what the operator is reading.**
  ///
  /// `TranscriptPager` puts a page of older history in front of what is held. A `ListView`
  /// keeps its `pixels` across that, so every pixel added above shifts the content under the
  /// thumb by exactly that much — measured 2026-09-08 as 3000px, throwing the reader from
  /// `recent line 25` to `OLDER line 25` mid-sentence.
  ///
  /// `bb` fixes the same thing in `bottom-anchored-scroll-body.tsx` by remembering the scroll
  /// height before the prepend and adding the growth back afterwards; this is that, in
  /// Flutter's vocabulary.
  group('older history arriving above the viewport', () {
    List<ChatItem> lines(String prefix, int n) =>
        [for (var i = 0; i < n; i++) prose('$prefix line $i')];

    testWidgets('leaves the line the operator was reading where it was', (tester) async {
      final recent = lines('recent', 60);
      await show(tester, recent);
      await tester.pumpAndSettle();

      final position = tester.state<ScrollableState>(find.byType(Scrollable).first).position;
      position.jumpTo(position.maxScrollExtent / 2);
      await tester.pumpAndSettle();

      // Whichever line is actually under the thumb, asked for rather than assumed: a row
      // is taller than it was — every reply now carries its clock and its action row —
      // so naming a line by number pins this test to a layout instead of to the
      // behaviour it is about.
      final topmost = tester.widget<Text>(find.textContaining('recent line').first);
      // Prose is a span tree now, not a string on a `Text`, so the line has to be read
      // back out of it.
      final anchor = topmost.data ?? topmost.textSpan!.toPlainText();
      Finder line() => find.text(anchor, findRichText: true).first;
      final reading = tester.getTopLeft(line()).dy;

      await show(tester, [...lines('OLDER', 40), ...recent]);
      await tester.pumpAndSettle();

      expect(line(), findsOne, reason: 'the line is still on screen, not 3000px away');
      expect(tester.getTopLeft(line()).dy, closeTo(reading, 1),
          reason: 'and in the same place on it');
    });
    /// The counter answers "how much did I miss while I was reading?". History that was
    /// always there and only just fetched is not something the operator missed — counting it
    /// puts a badge of forty on a screen where nothing happened.
    testWidgets('is not counted as unread — nothing new happened', (tester) async {
      final recent = lines('recent', 60);
      await show(tester, recent);
      await tester.pumpAndSettle();

      final position = tester.state<ScrollableState>(find.byType(Scrollable).first).position;
      position.jumpTo(position.maxScrollExtent / 2);
      await tester.pumpAndSettle();

      await show(tester, [...lines('OLDER', 40), ...recent]);
      await tester.pumpAndSettle();

      expect(tester.widget<JumpToLatest>(find.byType(JumpToLatest)).unread, 0);
    });
    /// The mechanism that stops a scroll-up chain-loading the whole conversation. Older
    /// history is asked for within 48px of the top; before the offset was compensated it
    /// **stayed** in that band after the page landed, so the next scroll notification asked
    /// again, and again — one visible jump per page.
    testWidgets('moves the offset out of the band that asks for more', (tester) async {
      final recent = lines('recent', 60);
      await show(tester, recent);
      await tester.pumpAndSettle();

      final position = tester.state<ScrollableState>(find.byType(Scrollable).first).position;
      position.jumpTo(10);
      await tester.pumpAndSettle();

      await show(tester, [...lines('OLDER', 40), ...recent]);
      await tester.pumpAndSettle();

      expect(position.pixels, greaterThan(48));
    });
  });
}

/// The gap that makes a turn read as one block.
///
/// Asserted as a *comparison*, never as a pixel count: the number is a design choice that
/// may move, while "two turns sit further apart than two lines of one turn" is the
/// behaviour, and it is the whole of issue 02 of `plans/pocket-chat-turn-presentation`.
void _turnGapTests() {
  ChatItem said(String text, String turnId) =>
      ChatItem(kind: ChatLine.prose, text: text, timestamp: at).inTurn(turnId, null);

  Future<double> gapBetween(WidgetTester tester, List<ChatItem> items) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: ChatView(
            transcript: ChatTranscript(items),
            agent: 'Atlas',
            onOpenTerminal: () {},
            onRefresh: () async {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final first = tester.getBottomLeft(find.text('satu')).dy;
    final second = tester.getTopLeft(find.text('dua')).dy;
    return second - first;
  }

  testWidgets('two turns sit further apart than two lines of one turn', (tester) async {
    final withinOneTurn = await gapBetween(tester, [said('satu', 't-1'), said('dua', 't-1')]);
    final acrossTwoTurns = await gapBetween(tester, [said('satu', 't-1'), said('dua', 't-2')]);

    expect(acrossTwoTurns, greaterThan(withinOneTurn));
  });

  testWidgets('the boundary is space — it draws no rule and no words', (tester) async {
    await gapBetween(tester, [said('satu', 't-1'), said('dua', 't-2')]);

    expect(find.byType(TurnGap), findsOneWidget);
    // `DayMark` is the app's one hairline separator. A second rule in the same column
    // would make the smaller claim compete with the larger one.
    expect(find.descendant(of: find.byType(TurnGap), matching: find.byType(Text)),
        findsNothing);
  });
}
