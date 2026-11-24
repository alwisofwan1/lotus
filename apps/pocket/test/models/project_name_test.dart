import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/shared/host_label.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

Cell cell({String? label, String? cwd, String workspace = 'canvas:cp_2c7308855b8de2c9'}) => Cell(
      host: const HostId('Alwis-MacBook-Air.local'),
      paneId: 'p-1',
      workspaceId: workspace,
      workspaceLabel: label,
      cwd: cwd,
      agentType: 'claude',
      title: 'Atlas',
      status: 'stalled',
      isAlive: true,
    );

void main() {
  group('naming a project the way a human would', () {
    test('uses the host-supplied label when there is one', () {
      expect(cell(label: 'CNVS').projectName, 'CNVS');
    });

    /// The case that matters, because it is the only one production produces.
    ///
    /// Measured against a live desktop on 2026-08-06: every canvas cell came back with
    /// `workspaceLabel: null` and `workspaceId: "canvas:cp_2c7308855b8de2c9"`. The
    /// readable name was in `cwd` the whole time.
    test('falls back to the last path segment of cwd', () {
      final live = cell(cwd: '/Users/alwisofwan/workspace/experiments/codespace-demo');

      expect(live.projectName, 'codespace-demo');
    });

    test('a trailing slash does not produce an empty name', () {
      expect(cell(cwd: '/Users/a/work/lotus/').projectName, 'lotus');
    });

    test('the opaque id remains the last resort rather than nothing', () {
      // Ugly, but a project with no title at all cannot be told from another one.
      expect(cell().projectName, 'canvas:cp_2c7308855b8de2c9');
      expect(cell(cwd: '   ').projectName, 'canvas:cp_2c7308855b8de2c9');
      expect(cell(cwd: '/').projectName, 'canvas:cp_2c7308855b8de2c9');
    });

    test('a label wins over cwd, because the host said it on purpose', () {
      expect(cell(label: 'CNVS', cwd: '/Users/a/codespace-demo').projectName, 'CNVS');
    });
  });

  group('naming a host', () {
    test('drops the mDNS suffix, which distinguishes nothing', () {
      expect(shortHostLabel('Alwis-MacBook-Air.local'), 'Alwis-MacBook-Air');
    });

    test('leaves anything else exactly as the host said it', () {
      expect(shortHostLabel('mac'), 'mac');
      expect(shortHostLabel('vps-frankfurt'), 'vps-frankfurt');
      // Not a suffix to strip — it is the whole name.
      expect(shortHostLabel('.local'), '.local');
    });

    test('is not printed at all when one machine is paired', () {
      // With one host, every row would carry the same word — and that word is
      // `Alwis-MacBook-Air`, wider than the project name it sits beside. A label
      // shared by every row distinguishes nothing, which is this label's only job
      // (R-10, `issues/11`).
      expect(hostQualifier('Alwis-MacBook-Air.local', pairedHosts: 1), isEmpty);
      expect(hostQualifier('mac', pairedHosts: 0), isEmpty);
    });

    test('comes back the moment a second machine can be confused with the first', () {
      expect(hostQualifier('Alwis-MacBook-Air.local', pairedHosts: 2),
          'Alwis-MacBook-Air');
      expect(hostQualifier('vps', pairedHosts: 3), 'vps');
    });

    test('the name offered at pairing is short, and only a suggestion', () {
      // `.local` goes, then the first segment: the guess exists to save typing, not to
      // be right about every machine — it is editable at the moment it is offered.
      expect(suggestedNickname('Alwis-MacBook-Air.local'), 'Alwis');
      expect(suggestedNickname('vps-frankfurt'), 'vps');
      expect(suggestedNickname('studio'), 'studio');
      // Nothing to shorten is not the same as nothing to suggest.
      expect(suggestedNickname('-leading-dash'), '-leading-dash');
    });
  });
}
