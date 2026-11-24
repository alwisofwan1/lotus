import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/data/agent_outcome.dart';
import 'package:lotus_pocket/features/agent/widgets/finished_card.dart';
import 'package:lotus_pocket/models/cell_result.dart';

/// The foot of Chat once the agent has stopped: what it did, in the order it can be wrong.
void main() {
  final finishedAt = DateTime.fromMillisecondsSinceEpoch(1785664800000);
  final now = finishedAt.add(const Duration(minutes: 2));

  Future<void> show(WidgetTester tester, AgentOutcome outcome) => tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: Scaffold(body: FinishedCard(outcome: outcome, now: now)),
        ),
      );

  testWidgets('names when it finished, how long it ran, and the sum of its edits', (tester) async {
    await show(
      tester,
      AgentOutcome(
        closing: 'Done.',
        closingTruncated: false,
        files: const [
          ChangedFile('src-tauri/src/pty.rs', added: 148, removed: 12),
          ChangedFile('src/legacy/shim.ts', added: 0, removed: 18),
        ],
        finishedAt: finishedAt,
        ranFor: const Duration(minutes: 6),
      ),
    );

    expect(find.text('FINISHED'), findsOne);
    expect(find.text('finished 2m ago · 6 min run'), findsOne);
    expect(find.text('src-tauri/src/pty.rs'), findsOne);
    expect(find.text('src/legacy/shim.ts'), findsOne);
    // The sum, with the file count — what the Home row will carry once it can.
    expect(find.textContaining('−30 · 2 files'), findsOne);
    // Once on the file's own row, once in the total — pty.rs is the only addition.
    expect(find.textContaining('+148'), findsNWidgets(2));
  });

  testWidgets('says in words when nothing was recorded, never +0 −0', (tester) async {
    await show(
      tester,
      AgentOutcome(closing: 'Nothing to do.', closingTruncated: false, files: const [], finishedAt: finishedAt),
    );

    expect(find.text('no file changes recorded'), findsOne);
    expect(find.textContaining('+0'), findsNothing);
    expect(find.textContaining('run'), findsNothing, reason: 'no duration was measured');
  });

  testWidgets('a cut closing message points at the terminal', (tester) async {
    await show(
      tester,
      AgentOutcome(closing: 'I removed the', closingTruncated: true, files: const [], finishedAt: finishedAt),
    );

    expect(find.textContaining('cut short by the host'), findsOne);
  });

  group("with git's answer", () {
    final result = CellResult(
      paneId: 'p-1',
      cwd: '/repo',
      closing: null,
      reason: null,
      changes: const CellChanges(
        files: [
          ChangedPath(path: 'src/a.ts', status: 'modified', added: 31, removed: 4),
          ChangedPath(path: 'new.md', status: 'untracked', added: 12, removed: 0),
          ChangedPath(path: 'logo.png', status: 'modified'),
        ],
        added: 43,
        removed: 4,
      ),
    );

    testWidgets('the list is the disk\'s, labelled so, and every row opens a diff', (tester) async {
      final opened = <String>[];
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(body: FinishedCard(result: result, onShowDiff: opened.add, now: now)),
      ));

      expect(find.text('CHANGED ON DISK'), findsOne);
      expect(find.text('FINISHED'), findsNothing);
      expect(find.textContaining('vs HEAD'), findsOne);
      // The binary is present and honest — not +0 −0.
      expect(find.text('binary'), findsOne);
      expect(find.textContaining('−4 · 3 files'), findsOne);

      await tester.tap(find.bySemanticsLabel('Show diff of src/a.ts'));
      expect(opened, ['src/a.ts']);
    });

    testWidgets('without a way to open a diff, rows are plain text', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(body: FinishedCard(result: result, now: now)),
      ));

      expect(find.bySemanticsLabel('Show diff of src/a.ts'), findsNothing);
      expect(find.text('src/a.ts'), findsOne);
    });

    testWidgets('a directory git cannot compare is said so under the ring\'s account', (tester) async {
      await show(
        tester,
        AgentOutcome(closing: 'Done.', closingTruncated: false, files: const [], finishedAt: finishedAt),
      );
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: FinishedCard(
            outcome: AgentOutcome(closing: 'Done.', closingTruncated: false, files: const [], finishedAt: finishedAt),
            result: const CellResult(paneId: 'p-1', cwd: '/tmp/x', closing: null, changes: null, reason: 'not_a_repo'),
            now: now,
          ),
        ),
      ));

      expect(find.text('FINISHED'), findsOne);
      expect(find.textContaining('not a git repository'), findsOne);
    });
  });
}
