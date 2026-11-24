import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

/// R-10 as a test: two hosts may run the same project, so `paneId` alone cannot
/// identify a cell. A dispatch addressed by `paneId` would reach whichever host
/// answered first — and the agent would touch the wrong repository.
void main() {
  const mac = HostId('mac');
  const vps = HostId('vps');

  Map<String, Object?> pane(String id) => {
        'paneId': id,
        'workspaceId': 'ws-lotus',
        'agentType': 'claude',
        'title': 'Chase',
        'status': 'live',
        'isAlive': true,
      };

  test('the same paneId on two hosts is two different cells', () {
    final onMac = Cell.fromJson(pane('p-1'), host: mac);
    final onVps = Cell.fromJson(pane('p-1'), host: vps);

    expect(onMac.paneId, onVps.paneId);
    expect(onMac.ref, isNot(onVps.ref));
    expect({onMac.ref, onVps.ref}, hasLength(2), reason: 'must not collapse in a Set');
  });

  test('a ref equals another built from the same pair, so it works as a map key', () {
    const a = CellRef(mac, 'p-1');
    const b = CellRef(mac, 'p-1');

    expect(a, b);
    expect(a.hashCode, b.hashCode);
    expect({a: 1}[b], 1);
  });

  test('a ref reads as host and pane, which is what a log needs', () {
    expect(const CellRef(vps, 'p-2').toString(), 'vps/p-2');
  });

  test('host identity survives the trip through a fixture-shaped payload', () {
    final cell = Cell.fromJson(pane('p-9'), host: vps);

    expect(cell.host, vps);
    expect(cell.ref, const CellRef(vps, 'p-9'));
  });

  test('a cell has a terminal unless the host says it has none', () {
    expect(Cell.fromJson(pane('p-1'), host: mac).terminal, isTrue);
    expect(Cell.fromJson({...pane('ss-1'), 'terminal': false}, host: mac).terminal, isFalse);
  });
}
