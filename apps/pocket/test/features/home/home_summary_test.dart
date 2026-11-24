import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/home/home_summary.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

const HostId mac = HostId('mac');

Cell cell(String title, {String? turn, String agentType = 'claude'}) => Cell(
      host: mac,
      paneId: 'p-$title',
      workspaceId: 'CNVS',
      agentType: agentType,
      title: title,
      status: 'live',
      isAlive: true,
      turn: turn,
    );

void main() {
  test('no cells is no sentence — the empty state says it elsewhere', () {
    expect(HomeSummary.of(const []).isEmpty, isTrue);
  });

  group('the amber half', () {
    test('one waiting agent is named', () {
      final s = HomeSummary.of([cell('Atlas', turn: 'needs-input')]);

      expect(s.waiting, 'Atlas is waiting.');
    });

    test('two waiting agents are both named', () {
      final s = HomeSummary.of([
        cell('Atlas', turn: 'needs-input'),
        cell('Chess', turn: 'needs-input'),
      ]);

      expect(s.waiting, 'Atlas and Chess are waiting.');
    });

    test('three or more become a count — the names are in the list right below', () {
      final s = HomeSummary.of([
        cell('Atlas', turn: 'needs-input'),
        cell('Chess', turn: 'needs-input'),
        cell('Koda', turn: 'needs-input'),
      ]);

      expect(s.waiting, '3 agents are waiting.');
    });

    test('is empty when nothing is waiting, so no amber appears at all', () {
      final s = HomeSummary.of([cell('Chess', turn: 'running')]);

      expect(s.waiting, isEmpty);
    });

    test('names follow the order given, which is the list order', () {
      // `FleetStore` already sorts waiting-first and stably; reading names in that
      // order means the first name in the sentence is the first row on screen.
      final s = HomeSummary.of([
        cell('Zed', turn: 'needs-input'),
        cell('Ada', turn: 'needs-input'),
      ]);

      expect(s.waiting, 'Zed and Ada are waiting.');
    });
  });

  group('the muted half', () {
    test('agents that report a turn are working', () {
      final s = HomeSummary.of([
        cell('Chess', turn: 'running'),
        cell('Nova', turn: 'running'),
      ]);

      expect(s.rest, 'Chess and Nova are working.');
    });

    /// Caught on a real phone on 2026-08-09, not in review.
    ///
    /// A live fleet rendered `Atlas … IDLE` and `Nova … IDLE` as two rows, under a
    /// summary reading "Atlas and Nova are working." — the same screen asserting both.
    /// The bucket split was on `turnKnown` alone, so `idle` fell in with `running`.
    /// The group above covers `running` and the one below covers no-turn; `idle` was
    /// the state between them that nothing exercised.
    test('an agent reporting idle is idle, never "working"', () {
      final s = HomeSummary.of([
        cell('Atlas', turn: 'idle'),
        cell('Nova', turn: 'idle'),
      ]);

      expect(s.rest, 'Atlas and Nova are idle.');
      // "working" reads as *busy on my behalf*, which is the claim `MVP.md` §2 spends
      // its longest paragraph refusing to make about an agent that is not.
      expect(s.rest, isNot(contains('working')));
    });

    test('running and idle are named separately, not merged into one verb', () {
      final s = HomeSummary.of([
        cell('Chess', turn: 'running'),
        cell('Atlas', turn: 'idle'),
      ]);

      expect(s.rest, 'Chess is working. Atlas is idle.');
    });

    test('all three kinds at once stay ordered — working, quiet, then idle', () {
      // `unknown` sits ahead of `idle` deliberately: §2 ranks a silence nobody can
      // interpret as worse than one the runner actually reported.
      final s = HomeSummary.of([
        cell('Chess', turn: 'running'),
        cell('Atlas', turn: 'idle'),
        cell('Koda', agentType: 'codex'),
      ]);

      expect(s.rest, 'Chess is working. Koda is quiet. Atlas is idle.');
    });

    test('an agent with no reported turn is quiet, never "working"', () {
      final s = HomeSummary.of([cell('Koda', agentType: 'codex')]);

      // The deliberate deviation from the mockup's literal copy: it reads "Chess and
      // Koda are working." about a cell the same screen labels `unknown`, and
      // `MVP.md` §2 calls that claim the most expensive lie in the product.
      expect(s.rest, 'Koda is quiet.');
      expect(s.rest, isNot(contains('working')));
    });

    test('both kinds together are described separately, not merged', () {
      final s = HomeSummary.of([
        cell('Chess', turn: 'running'),
        cell('Koda', agentType: 'codex'),
      ]);

      expect(s.rest, 'Chess is working. Koda is quiet.');
    });

    test('is empty when every cell here is waiting', () {
      final s = HomeSummary.of([cell('Atlas', turn: 'needs-input')]);

      expect(s.rest, isEmpty);
    });
  });

  test('the mockup sentence, reproduced from the data it describes', () {
    final s = HomeSummary.of([
      cell('Atlas', turn: 'needs-input'),
      cell('Chess', turn: 'running'),
      cell('Koda', agentType: 'codex'),
    ]);

    expect(s.waiting, 'Atlas is waiting.');
    // `design/pocket-flow.html` reads "Chess and Koda are working." here; see the
    // note on the previous test for why Koda is split out instead.
    expect(s.rest, 'Chess is working. Koda is quiet.');
  });
}
