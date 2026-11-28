import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/data/agent_outcome.dart';
import 'package:lotus_pocket/features/agent/widgets/turn_tail.dart';
import 'package:lotus_pocket/models/cell_result.dart';

final _at = DateTime.fromMillisecondsSinceEpoch(1788820000000);

AgentOutcome _outcome({Duration? ran, List<ChangedFile> files = const []}) => AgentOutcome(
      closing: 'done',
      closingTruncated: false,
      files: files,
      finishedAt: _at,
      ranFor: ran,
    );

CellResult _git(List<ChangedPath> files) => CellResult(
      paneId: 'p-1',
      cwd: '/w',
      closing: null,
      reason: null,
      changes: CellChanges(
        files: files,
        added: files.fold(0, (n, f) => n + (f.added ?? 0)),
        removed: files.fold(0, (n, f) => n + (f.removed ?? 0)),
      ),
    );

Widget _host(Widget child) => MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('has — the gate that removed three lines of nothing', () {
    /// Reported from a device on 2026-09-08: over a cell whose directory the host does
    /// not know, the old card drew "no file changes recorded / the machine does not know
    /// this agent's directory" between the answer and the composer. Nothing to say now
    /// means nothing drawn.
    test('nothing known means no line at all', () {
      expect(TurnTail.has(null, null), isFalse);
      expect(TurnTail.has(null, _git(const [])), isFalse);
      expect(TurnTail.has(_outcome(), null), isFalse);
    });

    test('git having files is the strong case', () {
      expect(TurnTail.has(null, _git([const ChangedPath(path: 'a.dart', status: 'M', added: 2, removed: 0)])), isTrue);
    });

    test('the ring counts when it has something concrete', () {
      expect(TurnTail.has(_outcome(ran: const Duration(seconds: 15)), null), isTrue);
      expect(
        TurnTail.has(_outcome(files: [const ChangedFile('a.dart', added: 1, removed: 1)]), null),
        isTrue,
      );
    });
  });

  group('the line itself', () {
    testWidgets('reads as a footnote: it finished, this long, this much', (tester) async {
      await tester.pumpWidget(_host(TurnTail(
        outcome: _outcome(ran: const Duration(seconds: 15)),
        result: _git([
          const ChangedPath(path: 'a.dart', status: 'M', added: 8, removed: 1),
          const ChangedPath(path: 'b.dart', status: 'M', added: 4, removed: 2),
        ]),
        onOpen: () {},
      )));
      expect(find.textContaining('finished'), findsOneWidget);
      expect(find.textContaining('15s'), findsOneWidget);
      expect(find.textContaining('+12 −3'), findsOneWidget);
      expect(find.textContaining('in 2 files'), findsOneWidget);
    });

    testWidgets('one file is not "1 files"', (tester) async {
      await tester.pumpWidget(_host(TurnTail(
        outcome: _outcome(ran: const Duration(seconds: 3)),
        result: _git([const ChangedPath(path: 'a.dart', status: 'M', added: 1, removed: 0)]),
      )));
      expect(find.textContaining('in 1 file'), findsOneWidget);
      expect(find.textContaining('in 1 files'), findsNothing);
    });

    testWidgets('the line is the handle; the account is behind it', (tester) async {
      var opened = 0;
      await tester.pumpWidget(_host(TurnTail(
        outcome: _outcome(ran: const Duration(seconds: 9)),
        result: null,
        onOpen: () => opened++,
      )));
      await tester.tap(find.textContaining('finished'));
      expect(opened, 1);
    });

    testWidgets('with nothing behind it, there is nothing to tap', (tester) async {
      await tester.pumpWidget(_host(TurnTail(
        outcome: _outcome(ran: const Duration(seconds: 9)),
        result: null,
      )));
      expect(find.byType(InkWell), findsNothing);
    });
  });
}
