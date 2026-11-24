import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/home/project_presentation.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

Cell cell(
  HostId host,
  String paneId, {
  String workspace = 'CNVS',
  String? workspaceLabel,
  String? cwd,
  String agentType = 'claude',
  String? turn,
}) =>
    Cell(
      host: host,
      paneId: paneId,
      workspaceId: workspace,
      workspaceLabel: workspaceLabel,
      cwd: cwd,
      agentType: agentType,
      title: 'Atlas',
      status: 'live',
      isAlive: true,
      turn: turn,
    );

ProjectPresentation present(List<Cell> cells, {String host = 'mac'}) =>
    ProjectPresentation.of(cells, hostLabel: host);

void main() {
  test('names the project and the machine it lives on', () {
    final p = present([cell(mac, 'p-1', workspace: 'ws-lotus', workspaceLabel: 'Lotus')]);

    expect(p.label, 'Lotus');
    expect(p.host, 'mac');
    expect(p.project, const ProjectRef(mac, 'ws-lotus'));
  });

  test('falls back to the workspace id when the host sends no label', () {
    expect(present([cell(mac, 'p-1', workspace: 'ws-lotus')]).label, 'ws-lotus');
  });

  test('names the project from cwd, which is where production keeps it', () {
    // Live desktop, 2026-08-06: `workspaceLabel` null, `workspaceId` an opaque canvas
    // id, and the readable name only in `cwd`.
    final p = present([
      cell(mac, 'p-1',
          workspace: 'canvas:cp_2c7308855b8de2c9',
          cwd: '/Users/alwisofwan/workspace/experiments/codespace-demo'),
    ]);

    expect(p.label, 'codespace-demo');
  });

  test('prints the host exactly as the caller resolved it, and nothing more', () {
    // Shortening moved to `CompositionRoot.hostLabel`, which is the only place that
    // knows *how many* machines are paired — and with one, the right label is no
    // label at all (`issues/11`). Doing it here as well would be a second rule able
    // to disagree with the first.
    expect(present([cell(mac, 'p-1')], host: 'mac').host, 'mac');
    expect(present([cell(mac, 'p-1')], host: '').host, isEmpty);
  });

  test('takes the label from whichever cell carries it', () {
    // A host may set `workspaceLabel` on some cells and not others; the project is
    // called the same thing either way, so the first cell must not be the only one
    // that gets to name it.
    final p = present([
      cell(mac, 'p-1', workspace: 'ws-lotus'),
      cell(mac, 'p-2', workspace: 'ws-lotus', workspaceLabel: 'Lotus'),
    ]);

    expect(p.label, 'Lotus');
  });

  test('two hosts running a same-named project stay two rows', () {
    // R-10, at the level where it decides what a tap selects: the labels collide,
    // the identities do not.
    final onMac = present([cell(mac, 'p-1')], host: 'mac');
    final onVps = present([cell(vps, 'p-1')], host: 'vps');

    expect(onMac.label, onVps.label);
    expect(onMac.project == onVps.project, isFalse);
  });

  group('what the counts say', () {
    test('a waiting agent is counted, and the total comes with it', () {
      final p = present([
        cell(mac, 'p-1', turn: 'needs-input'),
        cell(mac, 'p-2', turn: 'running'),
        cell(mac, 'p-3', turn: 'running'),
      ]);

      // The mockup's own row: `1 waiting · 3`.
      expect(p.waiting, '1 waiting');
      expect(p.activity, '3');
      expect(p.hasBothHalves, isTrue);
    });

    test('a project with nothing waiting shows only its size', () {
      final p = present([cell(mac, 'p-1', turn: 'running'), cell(mac, 'p-2')]);

      expect(p.waiting, isEmpty);
      expect(p.activity, '2');
      expect(p.hasBothHalves, isFalse);
    });

    test('every agent reporting idle is the one silence worth naming', () {
      final p = present([cell(mac, 'p-1', turn: 'idle'), cell(mac, 'p-2', turn: 'idle')]);

      expect(p.activity, 'idle');
    });

    test('a runner that reports no turn at all is never called idle', () {
      // `MVP.md` §2 calls this the most expensive lie in the product: a `codex` cell
      // files no stop hook, so its silence means nothing — and `idle` would read as
      // "done" about an agent that may be mid-edit. It shows the count instead.
      final p = present([cell(mac, 'p-1', agentType: 'codex')]);

      expect(p.activity, '1');
    });

    test('one idle agent among quiet ones does not make the project idle', () {
      final p = present([cell(mac, 'p-1', turn: 'idle'), cell(mac, 'p-2')]);

      expect(p.activity, '2');
    });

    test('waiting is counted even when the rest are idle', () {
      final p = present([
        cell(mac, 'p-1', turn: 'needs-input'),
        cell(mac, 'p-2', turn: 'idle'),
      ]);

      expect(p.waiting, '1 waiting');
      // Not `idle`: something there is anything but.
      expect(p.activity, '2');
    });
  });
}
