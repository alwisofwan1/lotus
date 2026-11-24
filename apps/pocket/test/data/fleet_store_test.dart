import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/models/bootstrap.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/server_event.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

Cell cell(
  HostId host,
  String paneId, {
  String workspace = 'CNVS',
  String? turn,
  String title = 'Agent',
  String runner = 'claude',
}) =>
    Cell(
      host: host,
      paneId: paneId,
      workspaceId: workspace,
      agentType: runner,
      title: title,
      status: 'live',
      isAlive: true,
      turn: turn,
      gating: runner == 'claude' ? 'asks' : 'runner_cannot',
    );

void main() {
  late StreamController<HostEvent> events;
  late FleetStore store;

  setUp(() {
    events = StreamController<HostEvent>();
    store = FleetStore(events.stream);
  });

  tearDown(() {
    store.dispose();
    events.close();
  });

  Future<void> push(HostId host, List<Cell> cells) async {
    events.add((host, FleetChangedEvent(cells: cells)));
    await pumpEventQueue();
  }

  group('cellForPane', () {
    test('finds a pane across hosts, by full id or by the bare uuid the host answered with', () async {
      await push(mac, [cell(mac, 'canvas:cp_1:abc-1')]);
      await push(vps, [cell(vps, 'p-9')]);

      expect(store.cellForPane('p-9')?.host, vps);
      expect(store.cellForPane('abc-1')?.paneId, 'canvas:cp_1:abc-1');
      expect(store.cellForPane('nope'), isNull);
      expect(store.cellForPane(''), isNull);
    });
  });

  group('merging hosts', () {
    test('cells from two hosts live in one list', () async {
      await push(mac, [cell(mac, 'p-1')]);
      await push(vps, [cell(vps, 'p-1')]);

      expect(store.cells, hasLength(2));
      expect(store.cells.map((c) => c.ref.toString()), containsAll(['mac/p-1', 'vps/p-1']));
    });

    test('a host replaces only its own cells', () async {
      await push(mac, [cell(mac, 'p-1'), cell(mac, 'p-2')]);
      await push(vps, [cell(vps, 'p-9')]);

      await push(mac, [cell(mac, 'p-1')]);

      expect(store.cells.map((c) => c.ref.toString()), ['mac/p-1', 'vps/p-9']);
    });

    /// A host joins several surfaces into one list — boards on screen, panes still
    /// running behind boards that are not, swarm — and nothing in that join promises a
    /// pane lands in exactly one. Two rows for one agent miscount the pager and hand the
    /// operator two targets that are one process.
    test('one pane is one row, however many times the host mentions it', () async {
      await push(mac, [
        cell(mac, 'p-1', title: 'Nova', turn: 'running'),
        cell(mac, 'p-1', title: 'Nova', turn: 'idle'),
        cell(mac, 'p-2', title: 'Atlas'),
      ]);

      expect(store.cells.map((c) => c.ref.toString()), ['mac/p-1', 'mac/p-2']);
      // First wins: the host emits its live surfaces before its remembered ones, so the
      // earlier entry is the one carrying this second's status.
      expect(store.cells.first.turn, 'running');
    });

    test('the same pane id on two hosts is two agents, not a duplicate', () async {
      // Pane ids are unique per machine, never across them (R-10) — deduping on the id
      // alone would delete one of two genuinely different agents.
      await push(mac, [cell(mac, 'p-1')]);
      await push(vps, [cell(vps, 'p-1')]);

      expect(store.cells, hasLength(2));
    });

    test('notifies listeners when the fleet actually changed', () async {
      var notifications = 0;
      store.addListener(() => notifications += 1);

      await push(mac, [cell(mac, 'p-1')]);

      expect(notifications, 1);
    });
  });

  group('ordering — the invariant Home and the pager share', () {
    test('waiting rises above everything, then error, then the quiet ones', () async {
      await push(mac, [
        cell(mac, 'p-run', turn: 'running', title: 'Chess'),
        cell(mac, 'p-err', turn: 'error', title: 'Koda'),
        cell(mac, 'p-wait', turn: 'needs-input', title: 'Atlas'),
      ]);

      expect(store.cells.map((c) => c.title), ['Atlas', 'Koda', 'Chess']);
    });

    /// `§4.2` binds pager order to list order. Both read this one list, so the
    /// question is not whether they agree — it is whether the order holds still.
    /// A list that reorders itself between polls turns a swipe into a lottery and
    /// a tap into a mis-tap.
    test('order does not shift when an unrelated field changes', () async {
      await push(mac, [
        cell(mac, 'p-1', title: 'Atlas'),
        cell(mac, 'p-2', title: 'Chess'),
      ]);
      final before = store.cells.map((c) => c.ref.toString()).toList();

      // Same cells, new preview text — the sort must not notice.
      await push(mac, [
        cell(mac, 'p-2', title: 'Chess'),
        cell(mac, 'p-1', title: 'Atlas'),
      ]);

      expect(store.cells.map((c) => c.ref.toString()).toList(), before);
    });

    test('a cell that starts waiting moves up, and that is the only reason to move', () async {
      await push(mac, [cell(mac, 'p-1', title: 'Atlas'), cell(mac, 'p-2', title: 'Chess')]);

      await push(mac, [
        cell(mac, 'p-1', title: 'Atlas'),
        cell(mac, 'p-2', title: 'Chess', turn: 'needs-input'),
      ]);

      expect(store.cells.map((c) => c.title), ['Chess', 'Atlas']);
    });

    test('an unknown turn stays quiet rather than jumping the queue', () async {
      await push(mac, [
        cell(mac, 'p-codex', runner: 'codex', title: 'Koda'),
        cell(mac, 'p-wait', turn: 'needs-input', title: 'Atlas'),
      ]);

      expect(store.cells.first.title, 'Atlas');
      expect(store.cells.last.neverAsks, isTrue);
    });
  });

  group('one project on screen, and what is happening elsewhere', () {
    test('Home shows a single project', () async {
      await push(mac, [
        cell(mac, 'p-1', workspace: 'CNVS'),
        cell(mac, 'p-2', workspace: 'Lotus'),
      ]);

      expect(store.inProject(const ProjectRef(mac, 'CNVS')), hasLength(1));
      expect(store.inProject(const ProjectRef(mac, 'CNVS')).single.paneId, 'p-1');
    });

    /// ADR-3, second revision: what the `elsewhere` row exists to protect —
    /// a waiting agent must never be hidden behind the project switcher.
    test('waiting in another project is reported, not hidden', () async {
      await push(mac, [
        cell(mac, 'p-1', workspace: 'CNVS'),
        cell(mac, 'p-2', workspace: 'Lotus', turn: 'needs-input', title: 'Nora'),
      ]);

      final elsewhere = store.waitingOutside(const ProjectRef(mac, 'CNVS'));

      expect(elsewhere, hasLength(1));
      expect(elsewhere.single.title, 'Nora');
      expect(store.waitingOutside(const ProjectRef(mac, 'Lotus')), isEmpty);
    });

    /// The R-10 case, and the reason this compares `ProjectRef` rather than the name:
    /// on a name comparison, this cell is excluded from `elsewhere` (same name) *and*
    /// from the on-screen list (different host) — it disappears from the app entirely,
    /// which is precisely what the row exists to prevent.
    test('waiting in a same-named project on ANOTHER host is still reported', () async {
      await push(mac, [cell(mac, 'p-1', workspace: 'CNVS')]);
      await push(vps, [cell(vps, 'p-9', workspace: 'CNVS', turn: 'needs-input', title: 'Nora')]);

      final elsewhere = store.waitingOutside(const ProjectRef(mac, 'CNVS'));

      expect(elsewhere, hasLength(1));
      expect(elsewhere.single.host, vps);
    });

    test('the same project name on two hosts stays two projects', () async {
      await push(mac, [cell(mac, 'p-1', workspace: 'CNVS')]);
      await push(vps, [cell(vps, 'p-1', workspace: 'CNVS')]);

      // R-10: the label collides, the identity does not.
      expect(store.inProject(const ProjectRef(mac, 'CNVS')), hasLength(1));
      expect(store.inProject(const ProjectRef(vps, 'CNVS')).single.host, vps);
      expect(store.projects, hasLength(2));
    });

    test('projects are listed in list order, so the first has the most urgent cell',
        () async {
      await push(mac, [cell(mac, 'p-1', workspace: 'Quiet')]);
      await push(vps, [cell(vps, 'p-9', workspace: 'Urgent', turn: 'needs-input')]);

      expect(store.projects.first, const ProjectRef(vps, 'Urgent'));
    });
  });

  group('losing a host', () {
    test('cells from a host that went quiet stay visible, marked stale', () async {
      await push(mac, [cell(mac, 'p-1')]);

      store.markUnreachable(mac);

      expect(store.cells, hasLength(1), reason: 'a fleet that empties reads as "work lost"');
      expect(store.isStale(mac), isTrue);
    });

    test('coming back clears the mark', () async {
      await push(mac, [cell(mac, 'p-1')]);
      store.markUnreachable(mac);

      await push(mac, [cell(mac, 'p-1')]);

      expect(store.isStale(mac), isFalse);
    });
  });

  group('the projects a host holds', () {
    HostProject project(HostId host, String id, {required String name, int opened = 0}) =>
        HostProject(
          project: ProjectRef(host, id),
          name: name,
          path: '/code/$id',
          lastOpenedAt: opened,
        );

    test('a project with no cell is still a project', () async {
      // The bug this whole change exists for: `terax-ai` was on the machine and
      // unreachable from the phone, because the list was derived from cells (ADR-14).
      store.adoptProjects(mac, [project(mac, 'terax', name: 'terax-ai')]);

      expect(store.projects, [const ProjectRef(mac, 'terax')]);
      expect(store.isDormant(const ProjectRef(mac, 'terax')), isTrue);
    });

    test('running projects come first, dormant ones follow by recency', () async {
      store.adoptProjects(mac, [
        project(mac, 'old', name: 'orbit', opened: 10),
        project(mac, 'CNVS', name: 'codespace-demo', opened: 30),
        project(mac, 'recent', name: 'terax-ai', opened: 20),
      ]);
      await push(mac, [cell(mac, 'p-1', workspace: 'CNVS')]);

      // `CNVS` is running, so it leads regardless of when it was opened; the rest are
      // ordered by the only fact a closed project has.
      expect(store.projects.map((p) => p.workspaceId), ['CNVS', 'recent', 'old']);
    });

    test('the host names the project, and says where it lives', () async {
      store.adoptProjects(mac, [project(mac, 'CNVS', name: 'codespace-demo')]);

      expect(store.infoFor(const ProjectRef(mac, 'CNVS'))?.name, 'codespace-demo');
      expect(store.infoFor(const ProjectRef(mac, 'CNVS'))?.path, '/code/CNVS');
      // A project the phone only knows through its cells — an older host — has none.
      expect(store.infoFor(const ProjectRef(vps, 'CNVS')), isNull);
    });

    test('a host replaces only its own projects', () async {
      store.adoptProjects(mac, [project(mac, 'CNVS', name: 'demo')]);
      store.adoptProjects(vps, [project(vps, 'srv', name: 'api')]);

      store.adoptProjects(mac, [project(mac, 'other', name: 'lotus')]);

      // The mac's list is a replacement — a project it stopped listing was closed —
      // and the vps is untouched by that.
      expect(store.projects.map((p) => p.workspaceId), containsAll(['other', 'srv']));
      expect(store.projects.map((p) => p.workspaceId), isNot(contains('CNVS')));
    });

    test('a project that is running keeps one row, not two', () async {
      store.adoptProjects(mac, [project(mac, 'CNVS', name: 'demo')]);
      await push(mac, [cell(mac, 'p-1', workspace: 'CNVS')]);

      expect(store.projects, hasLength(1));
      expect(store.isDormant(const ProjectRef(mac, 'CNVS')), isFalse);
    });
  });

  group('a machine that was unpaired', () {
    HostProject project(HostId host, String id, {required String name}) => HostProject(
          project: ProjectRef(host, id),
          name: name,
          path: '/code/$id',
          lastOpenedAt: 0,
        );

    test('takes its cells and its projects with it', () async {
      store.adoptProjects(mac, [project(mac, 'CNVS', name: 'demo')]);
      await push(mac, [cell(mac, 'p-1', workspace: 'CNVS')]);

      store.forget(mac);

      // Not merely stale: the phone has no key for this machine any more, so every
      // row it left is a row that goes nowhere. Before this there was no removal
      // path at all and they sat there until the process was killed.
      expect(store.cells, isEmpty);
      expect(store.projects, isEmpty);
    });

    test('leaves the machine that is staying alone', () async {
      store.adoptProjects(mac, [project(mac, 'CNVS', name: 'demo')]);
      store.adoptProjects(vps, [project(vps, 'srv', name: 'api')]);
      await push(vps, [cell(vps, 'p-9', workspace: 'srv')]);

      store.forget(mac);

      expect(store.projects.single, const ProjectRef(vps, 'srv'));
      expect(store.cells.single.host, vps);
    });

    test('is not the same as going quiet', () async {
      await push(mac, [cell(mac, 'p-1', workspace: 'CNVS')]);
      store.markUnreachable(mac);

      // R-9: an asleep machine keeps its rows, because a fleet that empties itself
      // reads as "all my work is gone". Unpairing is the case where they must go.
      expect(store.cells, hasLength(1));
      expect(store.isStale(mac), isTrue);

      store.forget(mac);

      expect(store.cells, isEmpty);
      expect(store.isStale(mac), isFalse);
    });

    test('forgetting a machine that was never here changes nothing', () async {
      await push(mac, [cell(mac, 'p-1', workspace: 'CNVS')]);
      var notified = 0;
      store.addListener(() => notified += 1);

      store.forget(const HostId('ghost'));

      expect(notified, 0, reason: 'a no-op must not redraw every screen');
      expect(store.cells, hasLength(1));
    });
  });
}
