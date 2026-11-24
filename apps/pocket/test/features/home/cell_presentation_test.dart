import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/home/cell_presentation.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

const HostId mac = HostId('mac');

Cell cell({
  String paneId = 'p-1',
  String title = 'Atlas',
  String agentType = 'claude',
  String? runnerLabel,
  String? turn,
  int? turnAgeMs,
  String? gating,
  String? preview,
}) =>
    Cell(
      host: mac,
      paneId: paneId,
      workspaceId: 'CNVS',
      agentType: agentType,
      runnerLabel: runnerLabel,
      title: title,
      status: 'live',
      isAlive: true,
      turn: turn,
      turnAgeMs: turnAgeMs,
      gating: gating,
      lastOutputPreview: preview,
    );

void main() {
  group('the waiting row — the only one allowed to shout', () {
    test('is emphasised, labelled waiting, and shows the question in prose', () {
      final p = CellPresentation.of(
        cell(turn: 'needs-input', preview: 'Delete src/legacy/shim.ts?'),
      );

      expect(p.emphasised, isTrue);
      expect(p.state, 'needs you');
      expect(p.detail, 'Delete src/legacy/shim.ts?');
      // Sans, not mono: this is the agent asking, not machine output.
      expect(p.detailIsMono, isFalse);
    });
  });

  group('every other row stays quiet', () {
    test('a running cell reports its turn verbatim, in mono', () {
      final p = CellPresentation.of(cell(turn: 'running', preview: '6 of 13 suites'));

      expect(p.emphasised, isFalse);
      expect(p.state, 'running');
      expect(p.detail, '6 of 13 suites');
      expect(p.detailIsMono, isTrue);
    });

    test('an error cell is not emphasised — colour carries it, not size', () {
      // `MVP.md`: amber and red are the two colours; emphasis (the bigger name, the
      // mark) belongs to waiting alone, because only waiting is a request.
      final p = CellPresentation.of(cell(turn: 'error'));

      expect(p.state, 'error');
      expect(p.emphasised, isFalse);
    });

    test('an unknown turn is never rendered as idle', () {
      final p = CellPresentation.of(cell(turn: null));

      // The lie `MVP.md` §2 calls the most expensive one: `idle` reads as "done"
      // about an agent that may be deleting files.
      expect(p.state, 'quiet');
      expect(p.state, isNot('idle'));
    });

    test('an idle cell that actually said so is idle', () {
      expect(CellPresentation.of(cell(turn: 'idle')).state, 'idle');
    });

    test('a turn value this app has never heard of passes through unchanged', () {
      // `Cell.turn` is deliberately an open string so a newer desktop can add values;
      // inventing a fallback label here would hide the new state instead of showing it.
      expect(CellPresentation.of(cell(turn: 'compacting')).state, 'compacting');
    });
  });

  group('a runner that can never ask explains its own silence', () {
    test('names both the reason and how long, when the host sent an age', () {
      final p = CellPresentation.of(cell(
        agentType: 'codex',
        gating: Cell.gatingRunnerCannot,
        turnAgeMs: 240000,
      ));

      expect(p.state, 'quiet');
      expect(p.detail, 'never asks · quiet 4m');
      expect(p.detailIsMono, isTrue);
    });

    test('omits the duration when the host sent none, rather than inventing one', () {
      // The normal case: a cell with no `turn` is sent no `turnAgeMs` either — the
      // `codex` cell in `contract/fixtures/rest-bootstrap.json` carries neither. The
      // mockup's `quiet 4m` is only reachable when an age really arrives.
      final p = CellPresentation.of(cell(
        agentType: 'codex',
        gating: Cell.gatingRunnerCannot,
      ));

      expect(p.detail, 'never asks');
    });

    test('prefers its own explanation over a stale preview', () {
      final p = CellPresentation.of(cell(
        agentType: 'codex',
        gating: Cell.gatingRunnerCannot,
        preview: 'some old output',
      ));

      expect(p.detail, 'never asks');
    });

    test('a cell with an unknown turn that CAN ask is not described as never asking', () {
      // Unknown because nothing has been reported yet, not because the runner is
      // incapable — two different silences, and only one of them has an explanation.
      final p = CellPresentation.of(cell(gating: 'asks', preview: 'starting up'));

      expect(p.state, 'quiet');
      expect(p.detail, 'starting up');
    });
  });

  group('quiet durations', () {
    Cell quiet(int ms) =>
        cell(gating: Cell.gatingRunnerCannot, turnAgeMs: ms);

    test('seconds below a minute', () {
      expect(CellPresentation.of(quiet(45000)).detail, 'never asks · quiet 45s');
    });

    test('minutes below an hour', () {
      expect(CellPresentation.of(quiet(59 * 60 * 1000)).detail,
          'never asks · quiet 59m');
    });

    test('hours beyond that', () {
      expect(CellPresentation.of(quiet(3 * 60 * 60 * 1000)).detail,
          'never asks · quiet 3h');
    });
  });

  test('a cell with no preview and no age yields an empty detail, not a placeholder', () {
    // The row then draws no second line at all — an empty one would still take height
    // and make an idle cell look like it had something to say.
    expect(CellPresentation.of(cell(turn: 'idle')).detail, isEmpty);
  });

  test('the ask outranks the terminal tail, except on a waiting cell where the tail is the question', () {
    final asked = Cell(
      host: const HostId('mac'), paneId: 'p', workspaceId: 'w', agentType: 'claude',
      title: 'Atlas', status: 'live', isAlive: true, turn: 'running',
      headline: 'explain the uncommitted changes', lastOutputPreview: '❯ ',
    );
    expect(CellPresentation.of(asked).detail, 'explain the uncommitted changes');

    final waiting = Cell(
      host: const HostId('mac'), paneId: 'p', workspaceId: 'w', agentType: 'claude',
      title: 'Atlas', status: 'live', isAlive: true, turn: 'needs-input',
      headline: 'clean up', lastOutputPreview: 'Delete src/legacy/shim.ts?',
    );
    expect(CellPresentation.of(waiting).detail, 'Delete src/legacy/shim.ts?');
  });

  test('with no preview but an age, the headline is how long it has been so', () {
    // What an operator glancing down the list wants: "idle 12m" is safe to ignore,
    // "quiet 4m" is nothing heard, not for long. From the host's own clock, never ours.
    expect(CellPresentation.of(cell(turn: 'idle', turnAgeMs: 12 * 60_000)).detail, 'idle 12m');
    expect(CellPresentation.of(cell(turnAgeMs: 240_000)).detail, 'quiet 4m');
    expect(CellPresentation.of(cell(turn: 'running', turnAgeMs: 30_000)).detail, 'running 30s');
  });

  test('name and runner come straight from the cell', () {
    final p = CellPresentation.of(cell(title: 'Koda', agentType: 'codex'));

    expect(p.name, 'Koda');
    expect(p.runner, 'codex');
  });

  group('the runner is named the way the desktop names it', () {
    // The desktop's node header read `Atlas · acme` while this row read `Atlas claude`
    // — one cell, two words, and nothing on screen to tell the operator they were the
    // same thing. `agentType` cannot fix it: every custom Claude-family runner reports
    // `claude` there on purpose, because that is the field a client routes on.
    test('the host\'s own label wins over the family', () {
      final p = CellPresentation.of(cell(agentType: 'claude', runnerLabel: 'acme'));

      expect(p.runner, 'acme');
    });

    test('a host that cannot name it falls back to the family, as this app always did', () {
      final p = CellPresentation.of(cell(agentType: 'claude'));

      expect(p.runner, 'claude');
    });
  });
}
