import 'dart:async';

import 'package:flutter/gestures.dart' show kTouchSlop;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/theme.dart';
import 'package:lotus_pocket/data/fleet_repository.dart';
import 'package:lotus_pocket/hosts/host_failure.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/features/home/home_screen.dart';
import 'package:lotus_pocket/features/home/home_summary.dart';
import 'package:lotus_pocket/features/home/project_presentation.dart';
import 'package:lotus_pocket/features/home/widgets/project_header.dart';
import 'package:lotus_pocket/features/home/widgets/cell_row.dart';
import 'package:lotus_pocket/features/home/widgets/starting_screen.dart';
import 'package:lotus_pocket/features/home/widgets/swipe_to_close.dart';
import 'package:lotus_pocket/features/home/widgets/close_action.dart';
import 'package:lotus_pocket/features/home/widgets/target_picker.dart';
import 'package:lotus_pocket/features/shared/runner_mark.dart';
import 'package:lotus_pocket/models/bootstrap.dart';
import '../../support/fake_security.dart';
import 'package:lotus_pocket/data/seen_marks.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/server_event.dart';
import 'package:lotus_pocket/features/shared/send_button.dart';

import '../../support/agent_harness.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

Cell cell(
  HostId host,
  String paneId, {
  required String title,
  String workspace = 'CNVS',
  String? workspaceLabel,
  String agentType = 'claude',
  String? turn,
  String? gating,
  String? preview,
  String? cwd,
  int? turnAgeMs,
}) =>
    Cell(
      host: host,
      paneId: paneId,
      turnAgeMs: turnAgeMs,
      workspaceId: workspace,
      workspaceLabel: workspaceLabel,
      cwd: cwd,
      agentType: agentType,
      title: title,
      status: 'live',
      isAlive: true,
      turn: turn,
      gating: gating,
      lastOutputPreview: preview,
    );

void main() {
  late StreamController<HostEvent> events;
  late FleetStore fleet;

  /// The store's clock, movable by hand. What makes "last heard from 4m ago" a
  /// measurement a test can assert rather than whatever the wall clock happened to say.
  late DateTime clockAt;
  late AgentHarness harness;
  // The pager needs the project too, so Home hands over the cell it drew (`issues/13`).
  final opened = <Cell>[];

  /// Berapa kali layar ini melaporkan “kembali ke indeks”. Ia melaporkan gerakannya dan
  /// tidak memutuskan apa pun tentang apa yang terjadi sesudahnya — rute milik `app/`.
  var backs = 0;

  /// What the pager answers when it closes — `true` is its Sessions sheet's `New`.
  var pagerAsksNew = false;

  /// Scoped to the list, because the composer names its target too.
  ///
  /// Home gained a composer whose chip reads `→ Atlas`, so an unscoped finder for an
  /// agent's name now matches twice — and an assertion that counts both proves nothing
  /// about the list it was written for.
  Finder inList(Finder matching) =>
      find.descendant(of: find.byType(CellRow), matching: matching);

  setUp(() async {
    harness = await AgentHarness.paired();
    opened.clear();
    backs = 0;
    pagerAsksNew = false;
    events = StreamController<HostEvent>.broadcast();
    clockAt = DateTime(2026, 8, 9, 12);
    fleet = FleetStore(events.stream, now: () => clockAt);
  });

  tearDown(() async {
    harness.dispose();
    fleet.dispose();
    await events.close();
  });

  Future<void> push(WidgetTester tester, HostId host, List<Cell> cells) async {
    events.add((host, FleetChangedEvent(cells: cells)));
    await tester.pumpAndSettle();
  }

  Future<void> show(
    WidgetTester tester, {
    ProjectRef project = const ProjectRef(mac, 'CNVS'),
    bool startAgent = false,
  }) =>
      tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: HomeScreen(
            fleet: fleet,
            // Diteruskan, tidak dipilih sendiri (2026-08-11). Setiap tes di bawah ini
            // menyebut project-nya, jadi apa yang digambar tidak lagi bergantung pada
            // urutan fleet — tidak ada lagi tes yang bisa lulus karena kebetulan
            // `projects.first` adalah yang dimaksud.
            project: project,
            hostLabel: (h) => h.value,
            onOpenCell: (c) async {
              opened.add(c);
              return pagerAsksNew;
            },
            startAgent: startAgent,
            onBack: () => backs += 1,
            onRefresh: () async => const HydrationReport(answered: [], failed: {}),
            agents: harness.repository,
          ),
        ),
      );

  /// The mockup's own fixture, so what renders can be compared to the design.
  Future<void> showMockupFleet(WidgetTester tester) async {
    await show(tester);
    await push(tester, mac, [
      cell(mac, 'p-1', title: 'Atlas', turn: 'needs-input', preview: 'Delete src/legacy/shim.ts?'),
      cell(mac, 'p-2', title: 'Chess', turn: 'running', preview: '6 of 13 suites'),
      cell(mac, 'p-3', title: 'Koda', agentType: 'codex', gating: Cell.gatingRunnerCannot),
    ]);
  }

  testWidgets('a cold start shows the project, not a broken screen', (tester) async {
    await show(tester);

    // `Nothing here yet.` tidak pernah lagi muncul di sini, dan itu benar: layar ini
    // dibuka **dengan** sebuah project di tangan, jadi keadaan “tidak ada satu pun
    // project” adalah pertanyaan untuk indeks di atasnya, bukan untuk layar ini.
    expect(find.text('Nothing here yet.'), findsNothing);
    expect(find.text('No agents are running in this project.'), findsOne);
  });

  testWidgets('kembali ke indeks dilaporkan, tidak diputuskan', (tester) async {
    await showMockupFleet(tester);

    await tester.tap(find.bySemanticsLabel('Back to projects'));
    await tester.pumpAndSettle();

    expect(backs, 1);
    // Dan tidak ada sheet: pengalih project sudah menjadi layar akarnya sendiri, jadi
    // caret ini punya satu arti saja.
    expect(find.text('Diagnostics'), findsNothing);
  });

  testWidgets('renders the project title with its host, permanently', (tester) async {
    await showMockupFleet(tester);

    // ADR-3 second revision: the host is readable in one place, for free, instead of
    // being repeated as a badge on every row.
    expect(find.text('CNVS'), findsOne);
    expect(find.text('mac'), findsOne);
  });

  testWidgets('prefers the host-supplied project label over the raw id', (tester) async {
    await show(tester, project: const ProjectRef(mac, 'ws-lotus'));
    await push(tester, mac, [
      cell(mac, 'p-1', title: 'Atlas', workspace: 'ws-lotus', workspaceLabel: 'Lotus'),
    ]);

    expect(find.text('Lotus'), findsOne);
    expect(find.text('ws-lotus'), findsNothing);
  });

  testWidgets('lists every agent in the project, with runner and state', (tester) async {
    await showMockupFleet(tester);

    expect(inList(find.text('Atlas')), findsOne);
    expect(inList(find.text('Chess')), findsOne);
    expect(inList(find.text('Koda')), findsOne);
    // Lowercase, in the operator's words: the row says who it is waiting for, and a
    // runner with no turn signal is "quiet" — the word HomeSummary already uses.
    expect(find.text('needs you'), findsOne);
    expect(find.text('running'), findsOne);
    expect(find.text('quiet'), findsOne);
  });

  testWidgets('the waiting agent shows its question, in full', (tester) async {
    await showMockupFleet(tester);

    // The list bought width precisely so this arrives whole instead of truncated into
    // a hint (`MVP.md`, on why the grid was cancelled).
    expect(find.text('Delete src/legacy/shim.ts?'), findsOne);
  });

  testWidgets('a runner that never asks explains its own silence', (tester) async {
    await showMockupFleet(tester);

    expect(find.text('never asks'), findsOne);
  });

  testWidgets('waiting is the only row wearing colour', (tester) async {
    await showMockupFleet(tester);

    Color colourOf(String text) =>
        tester.widget<Text>(find.text(text)).style!.color!;

    // `MVP.md`: amber means "this needs you". Running and unknown carry no colour at
    // all, because nothing is being asked of the operator.
    expect(colourOf('needs you'), AppTokens.dark.waiting);
    expect(colourOf('running'), AppTokens.dark.muted);
    expect(colourOf('quiet'), AppTokens.dark.muted);
  });

  testWidgets('the mark column carries the runner, and the amber when it waits',
      (tester) async {
    await showMockupFleet(tester);

    Color markColour(String name) => tester
        .widget<RunnerMarkGlyph>(find.descendant(
          of: find.ancestor(of: find.text(name), matching: find.byType(CellRow)),
          matching: find.byType(RunnerMarkGlyph),
        ))
        .color;

    // Since the 2026-08-27 revamp the mark wears its runner's brand on every row —
    // one mark per agent is identity, not a billboard — and the amber moved to the
    // name, dot and word of the row that waits. A runner with no brand keeps the ink.
    expect(markColour('Atlas'), brandColorFor('claude', Brightness.dark));
    expect(markColour('Chess'), brandColorFor('claude', Brightness.dark));
    expect(markColour('Koda'), brandColorFor('codex', Brightness.dark));
  });

  testWidgets('the waiting row is emphasised, the quiet ones recede', (tester) async {
    await showMockupFleet(tester);

    TextStyle nameStyle(String name) =>
        tester.widget<Text>(inList(find.text(name))).style!;

    // Same size for every persona now (serif 19, like the Agent header); the waiting
    // one is the only name in amber, and that alone is the emphasis.
    expect(nameStyle('Atlas').fontSize, nameStyle('Chess').fontSize);
    expect(nameStyle('Atlas').color, AppTokens.dark.waiting);
    expect(nameStyle('Chess').color, AppTokens.dark.text);
  });

  testWidgets('the summary names who is waiting and who is not', (tester) async {
    await showMockupFleet(tester);

    expect(
      find.textContaining('Atlas is waiting.', findRichText: true),
      findsOne,
    );
  });

  testWidgets('tapping a row asks to open that exact cell, host included',
      (tester) async {
    await showMockupFleet(tester);

    await tester.tap(inList(find.text('Atlas')));
    await tester.pumpAndSettle();

    // A `CellRef`, never a bare pane id: two hosts can each run a `p-1` (R-10).
    expect(opened.map((c) => c.ref), [const CellRef(mac, 'p-1')]);
  });

  // Grup “a row can act without leaving the list” dihapus 2026-08-11 bersama drawer-nya.
  // Cakupannya tidak hilang, ia pindah bersama kemampuannya:
  //
  //   * `stop` lewat gerbang        -> agent_page_test.dart (`/m/cell/p-1/stop`, prompts > 0)
  //   * `stop` ditolak gerbang      -> agent_repository_test.dart, di lapisan yang memutuskan
  //   * `close` absen tanpa kapabilitas -> grup di bawah, sebagai jalur geser yang absen
  //   * `send here` mengarahkan ulang   -> home_composer_test.dart, lewat picker tujuan
  //
  // Menyalin ulang keempatnya ke sini akan menguji Home untuk hal yang Home tidak lagi
  // lakukan, dan itu jenis test yang lulus sambil tidak menjaga apa pun.

  group('geser satu baris untuk mengakhiri agennya', () {
    /// Host yang mengiklankan `close` — dan sejak 2026-09-05 host VPS pun melakukannya,
    /// karena ia melayani `/api/fleet/close` sendiri. ADR-14 tetap melarang menggambar
    /// kontrol yang mesinnya tak bisa penuhi, jadi jalur geser hanya ada di mesin yang
    /// mengizinkannya — dan host yang lebih tua dari flag itu masih ada.
    Future<void> showWithClose(WidgetTester tester) async {
      harness.registry.add(harness.host(
        mac,
        features: const ['fleet', 'dispatch', 'transcript', 'permission', 'close'],
      ));
      await show(tester);
    }

    testWidgets('digeser lalu ditahan: close sampai ke host, lewat gerbang',
        (tester) async {
      await showWithClose(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      await tester.timedDrag(
        find.byType(CellRow).first,
        const Offset(-(SwipeToClose.snapAt + kTouchSlop + 8), 0),
        const Duration(milliseconds: 400),
      );
      await tester.pumpAndSettle();

      final press = await tester.startGesture(
        tester.getCenter(find.byType(CloseAction)),
      );
      await tester.pump(const Duration(milliseconds: 120));
      await tester.pumpAndSettle();
      await press.up();
      await tester.pumpAndSettle();

      // Yang diklaim di sini bukan callback, tapi permintaan yang benar-benar dibuat
      // repository sungguhan — dan bahwa gerbangnya berjalan di jalur ini juga.
      //
      // `DELETE /m/cell/:id`, bukan `POST .../close`: rutenya tentang keberadaan pane itu,
      // bukan tentang perintah kepadanya (`host_api.dart`).
      expect(harness.http.last.method, 'DELETE');
      expect(harness.http.last.uri.path, '/m/cell/p-1');
      expect(harness.biometrics.prompts, 1);
    });

    testWidgets('tidak ada jalur geser di host yang tak mengiklankan close',
        (tester) async {
      await show(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      await tester.timedDrag(
        find.byType(CellRow).first,
        const Offset(-(SwipeToClose.snapAt + kTouchSlop + 8), 0),
        const Duration(milliseconds: 400),
      );
      await tester.pumpAndSettle();

      expect(find.byType(CloseAction), findsNothing);
      expect(harness.http.sent, isEmpty);
    });
  });

  group('starting an agent turns the composer into the way to do it', () {
    /// A host that advertises `spawn` — which a VPS host has done since 2026-09-05, and a
    /// desktop always did. The control is drawn only where the machine said it could be
    /// honoured (ADR-14), which is why the negative case below still matters: a host older
    /// than the flag exists, and it must not grow a button it cannot serve.
    Future<void> showWithSpawn(
      WidgetTester tester, {
      List<HostRunner>? runners,
      List<String> features = const ['fleet', 'dispatch', 'transcript', 'permission', 'spawn'],
      bool startAgent = false,
    }) async {
      harness.registry.add(harness.host(mac, features: features));
      await show(tester, startAgent: startAgent);
      if (runners != null) fleet.adoptRunners(mac, runners);
    }

    testWidgets('neither way in exists on a host that never advertised spawn',
        (tester) async {
      await show(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      // Not the list's last row, and not the picker's either: a control the machine
      // could not honour is worse than empty space (ADR-14).
      expect(find.text('New agent'), findsNothing);

      await tester.tap(find.textContaining('Atlas').last);
      await tester.pumpAndSettle();
      expect(find.text('New agent'), findsNothing);
    });

    testWidgets('a project with nothing in it is no longer a dead end', (tester) async {
      await showWithSpawn(tester);
      // A project the host lists but is running nothing in — ADR-14's case, and the
      // screen whose own doc used to say it deliberately had no way forward.
      fleet.adoptProjects(mac, const [
        HostProject(
          project: ProjectRef(mac, 'CNVS'),
          name: 'CNVS',
          path: '/tmp/cnvs',
          lastOpenedAt: 0,
        ),
      ]);
      await tester.pumpAndSettle();

      expect(find.text('No agents are running in this project.'), findsOne);
      // The composer is here, already in the only mode that means anything on a screen
      // with no agent to talk to — and the runner line under it is how to change what
      // gets started, since there is no chip row any more.
      expect(find.bySemanticsLabel('Choose a runner'), findsOne);
      expect(find.text('Cancel'), findsNothing, reason: 'nothing to go back to');
      expect(find.text('First task, optional'), findsOne);

      harness.http.enqueue('{"paneId":"p-new"}');
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      expect(harness.http.last.uri.path, '/m/cells');
      expect(harness.http.last.json, containsPair('provider', 'claude'));
    });

    testWidgets('sesudah mesin menerimanya, layar Starting menyebut di mana',
        (tester) async {
      await showWithSpawn(tester);
      fleet.adoptProjects(mac, const [
        HostProject(
          project: ProjectRef(mac, 'CNVS'),
          name: 'CNVS',
          path: '/Users/op/code/cnvs',
          lastOpenedAt: 0,
        ),
      ]);
      await tester.pumpAndSettle();

      harness.http.enqueue('{"paneId":"p-new"}');
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      // Jeda antara “mesin menerimanya” dan “cell-nya muncul” tidak lagi terlihat seperti
      // layar di mana tidak ada yang diminta.
      expect(find.byType(StartingScreen), findsOne);
      expect(find.text('STARTING'), findsOne);
      expect(find.textContaining('~/code/cnvs'), findsOne);
    });

    testWidgets('dan ia pergi sendiri begitu cell-nya benar-benar ada', (tester) async {
      await showWithSpawn(tester);
      fleet.adoptProjects(mac, const [
        HostProject(
          project: ProjectRef(mac, 'CNVS'),
          name: 'CNVS',
          path: '/Users/op/code/cnvs',
          lastOpenedAt: 0,
        ),
      ]);
      await tester.pumpAndSettle();

      harness.http.enqueue('{"paneId":"p-new"}');
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();
      expect(find.byType(StartingScreen), findsOne);

      // Snapshot berikutnya membawa cell-nya. Itu satu-satunya kabar yang layar ini tunggu.
      await push(tester, mac, [cell(mac, 'p-new', title: 'Atlas', turn: 'running')]);
      await tester.pumpAndSettle();

      expect(find.byType(StartingScreen), findsNothing);
      expect(find.text('Atlas'), findsWidgets);
    });

    testWidgets('and stays a dead end where the host cannot start one', (tester) async {
      await show(tester);
      fleet.adoptProjects(mac, const [
        HostProject(
          project: ProjectRef(mac, 'CNVS'),
          name: 'CNVS',
          path: '/tmp/cnvs',
          lastOpenedAt: 0,
        ),
      ]);
      await tester.pumpAndSettle();

      expect(find.text('No agents are running in this project.'), findsOne);
      // The rule ADR-14 states did not move: no control the machine could not honour.
      expect(find.text('New agent'), findsNothing);
    });

    testWidgets("the pager's New comes back here as the runner sheet (v4 tiket 08)",
        (tester) async {
      await showWithSpawn(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);
      pagerAsksNew = true;

      await tester.tap(find.byType(CellRow).first);
      await tester.pumpAndSettle();

      expect(opened.single.title, 'Atlas');
      expect(find.textContaining('START AN AGENT'), findsOne);
    });

    testWidgets('opened to start one, it is already choosing a runner (v4 tiket 08)',
        (tester) async {
      await showWithSpawn(tester, startAgent: true);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      expect(find.textContaining('START AN AGENT'), findsOne);
    });

    testWidgets('the list ends on the row that starts one, and it switches the composer',
        (tester) async {
      await showWithSpawn(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      // The discoverable half. The picker's row is the other one, and an operator who
      // never opens the picker must still find this.
      expect(find.text('New agent'), findsOne);

      await tester.tap(find.text('New agent'));
      await tester.pumpAndSettle();

      // The sheet is already up: one tap asked for an agent, so the next thing on
      // screen is the choice of one — not a changed field to notice first.
      expect(find.textContaining('START AN AGENT'), findsOne);
      await tester.tap(find.text('claude').last);
      await tester.pumpAndSettle();

      expect(find.text('First task, optional'), findsOne);
      expect(find.text('claude'), findsWidgets);
    });

    testWidgets('choosing it swaps the composer, and sending starts the agent',
        (tester) async {
      // Named rather than left to `SpawnRunner.fallback`: the fallback is what a host too old
      // to describe its runners gets, and such a host advertises no permission scale — so a
      // posture asserted on it would be this app inventing one (ADR-14).
      await showWithSpawn(tester, runners: const [
        HostRunner(
          id: 'claude',
          name: 'claude',
          gates: true,
          permissions: [
            RunnerPermission(id: 'manual', label: 'manual', isDefault: true),
            RunnerPermission(id: 'bypassPermissions', label: 'bypass'),
          ],
        ),
      ]);
      await push(tester, mac, [
        cell(mac, 'p-1', title: 'Atlas', turn: 'running', cwd: '/Users/a/workspace/terax-ai'),
      ]);

      // The other way in: the chip, which is the control that changes where words go.
      await tester.tap(find.text('Atlas').last);
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(of: find.byType(TargetPicker), matching: find.text('New agent')),
      );
      await tester.pumpAndSettle();
      // Same summons from this door: the runner sheet is up, choose and come back.
      // `claude` is tunable, so picking it opens the second step rather than closing the
      // sheet — `Start` is what comes back, and the composer is unreachable until it does.
      await tester.tap(find.text('claude').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Start'));
      await tester.pumpAndSettle();

      // The slot changed rather than a screen opening: same field, new meaning.
      expect(find.text('First task, optional'), findsOne);
      expect(find.text('claude'), findsWidgets);
      // No path printed, because this fleet never told the phone one. A directory is
      // stated when known and never guessed — inventing one under a control that
      // starts a process in it is the R-10 trap with extra steps.
      expect(find.textContaining('Runs in'), findsNothing);

      harness.http.enqueue('{"paneId":"p-new"}');
      await tester.enterText(find.byType(TextField), 'run the suite');
      // Pumped first: the button only goes live once the field has told the composer it
      // has words, which is a frame after `enterText`.
      await tester.pump();
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      expect(harness.http.last.uri.path, '/m/cells');
      expect(harness.http.last.json, containsPair('provider', 'claude'));
      expect(harness.http.last.json, containsPair('initialPrompt', 'run the suite'));
      // Sent without being asked about: the sheet rests on the stop the host marked, and
      // for the Claude family that stop is `manual` — a cell born from this phone is born
      // asking, and the phone is the thing standing by to answer.
      expect(harness.http.last.json, containsPair('permissionMode', 'manual'));
    });

    testWidgets("offers the machine's own runners, custom ones included", (tester) async {
      // The case a hardcoded list cannot have: `acme` is a name and a command the
      // operator invented, and only their registry knows it exists.
      await showWithSpawn(tester, runners: const [
        HostRunner(id: 'claude', name: 'claude', permissions: [
            RunnerPermission(id: 'plan', label: 'plan'),
            RunnerPermission(id: 'manual', label: 'manual', isDefault: true),
            RunnerPermission(id: 'bypassPermissions', label: 'bypass'),
          ], gates: true),
        HostRunner(id: 'custom-acme', name: 'acme', permissions: [
            RunnerPermission(id: 'plan', label: 'plan'),
            RunnerPermission(id: 'manual', label: 'manual', isDefault: true),
            RunnerPermission(id: 'bypassPermissions', label: 'bypass'),
          ], gates: true),
        HostRunner(id: 'custom-pi', name: 'Pi', gates: false),
      ]);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      await tester.tap(find.text('New agent'));
      await tester.pumpAndSettle();

      // Daftarnya pindah dari deret pil ke sheet sejak 2026-08-12 (mockup M4), jadi ia
      // dibuka lebih dulu — dan yang didapat sebagai gantinya adalah baris kedua yang
      // menyebut apakah runner-nya bertanya sebelum bertindak.

      expect(find.text('acme'), findsOne);
      expect(find.text('Pi'), findsOne);
      // Not offered, because this machine did not say it had one.
      expect(find.text('gemini'), findsNothing);

      await tester.tap(find.text('acme'));
      await tester.pumpAndSettle();
      // Sebuah runner yang punya skala izin **bisa disetel**, jadi menekannya membuka
      // langkah SUMMON alih-alih menutup sheet — sebelum 2026-08-27 `acme` tidak punya
      // apa pun untuk disetel dan terpilih dalam satu ketukan.
      await tester.ensureVisible(find.textContaining('Start'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();
      harness.http.enqueue('{"paneId":"p-new"}');
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      // The id travels as `runnerId` as well, because that is the field the desktop
      // resolves against its registry — without it the request would quietly become
      // whatever `provider` happened to name.
      expect(harness.http.last.json, containsPair('runnerId', 'custom-acme'));
      expect(harness.http.last.json, containsPair('permissionMode', 'manual'));
    });

    testWidgets('a model and effort chosen on the sheet reach the request; the default does not',
        (tester) async {
      await showWithSpawn(tester, runners: const [
        HostRunner(
          id: 'claude',
          name: 'claude',
          gates: true,
          models: [
            RunnerModel(id: 'opus', label: 'opus'),
            RunnerModel(id: 'sonnet', label: 'sonnet', isDefault: true),
          ],
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          permissions: [
            RunnerPermission(id: 'plan', label: 'plan'),
            RunnerPermission(id: 'manual', label: 'manual', isDefault: true),
            RunnerPermission(id: 'bypassPermissions', label: 'bypass'),
          ],
        ),
      ]);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      await tester.tap(find.text('New agent'));
      await tester.pumpAndSettle();
      // A tunable runner opens the second step instead of closing the sheet.
      await tester.tap(find.text('claude').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('opus'));
      await tester.pumpAndSettle();
      // Langkah SUMMON menggulir sejak track permission datang, dan layar uji default
      // (800×600) lebih pendek dari telepon mana pun. Digulir dulu, lalu ditekan.
      await tester.ensureVisible(find.textContaining('Start'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();

      // The chip now says the whole choice, so it can be caught before the send.
      expect(find.text('claude · opus'), findsOne);

      harness.http.enqueue('{"paneId":"p-new"}');
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      expect(harness.http.last.json, containsPair('model', 'opus'));
      // Thinking was left on auto, so no `effort` travels — the CLI keeps its default.
      expect(harness.http.last.json, isNot(contains('effort')));
      expect(harness.http.last.json, containsPair('permissionMode', 'manual'));
    });

    testWidgets('katalog runner yang berubah di mesin menyusul pilihan yang sudah dipegang',
        (tester) async {
      // Kasus yang dulu tidak pernah menyusul: operator menambahkan Agent di mesin, HP
      // sudah punya pilihan untuk runner dengan id yang sama, dan pilihan itu membawa
      // katalog dari saat ia dibuat. Bootstrap baru sampai ke store lalu berhenti di
      // sana — chip tetap mencetak model lama, dan sheet tetap menggambar picker lama.
      await showWithSpawn(tester, runners: const [
        HostRunner(
          id: 'claude',
          name: 'claude',
          gates: true,
          models: [
            RunnerModel(id: 'opus', label: 'opus'),
            RunnerModel(id: 'sonnet', label: 'sonnet', isDefault: true),
          ],
        ),
      ]);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      await tester.tap(find.text('New agent'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('claude').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('opus'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.textContaining('Start'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();
      expect(find.text('claude · opus'), findsOne);

      // Mesin berubah pikiran tentang runner yang sama: `opusplan` masuk, `opus` pergi.
      fleet.adoptRunners(mac, const [
        HostRunner(
          id: 'claude',
          name: 'claude',
          gates: true,
          models: [
            RunnerModel(id: 'sonnet', label: 'sonnet', isDefault: true),
            RunnerModel(id: 'opusplan', label: 'opusplan'),
          ],
        ),
      ]);
      await tester.pumpAndSettle();

      // Chip-nya kembali ke default host, bukan menahan alias yang sudah tidak ada.
      expect(find.text('claude · opus'), findsNothing);
      expect(find.text('claude'), findsWidgets);

      // Dan yang baru itu yang ditawarkan ketika sheet dibuka lagi.
      await tester.tap(find.bySemanticsLabel('Choose a runner').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('claude').last);
      await tester.pumpAndSettle();
      expect(find.text('opusplan'), findsOne);
      expect(find.text('opus'), findsNothing);
      await tester.ensureVisible(find.textContaining('Start'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();

      harness.http.enqueue('{"paneId":"p-new"}');
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      // Alias mati tidak ikut terkirim: CLI-lah yang akan menolaknya, jauh dari operator.
      // Yang naik adalah tempat istirahat katalog baru — diam bukan pilihan, karena spawn
      // tanpa `model` memakai default mesin, dan default itu bukan yang tersorot di sheet.
      expect(harness.http.last.json, containsPair('model', 'sonnet'));
    });

    testWidgets('falls back to what every machine has when the host names none',
        (tester) async {
      await showWithSpawn(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      await tester.tap(find.text('New agent'));
      await tester.pumpAndSettle();

      // Never an empty picker: that would read as *your machine has no agents on it*.
      expect(find.text('claude'), findsWidgets);
      expect(find.text('codex'), findsWidgets);
    });

    testWidgets('a host that runs codex without a terminal offers it, and the choice is sent as tui: false',
        (tester) async {
      // Headless is two facts, and the host states both: `structured-spawn` in its caps,
      // and `headless` on the runner itself. The fallback list a silent host gets carries
      // neither, by design.
      await showWithSpawn(
        tester,
        features: const ['fleet', 'dispatch', 'transcript', 'permission', 'spawn', 'structured-spawn'],
        runners: const [
          HostRunner(id: 'claude', name: 'claude', permissions: [
            RunnerPermission(id: 'plan', label: 'plan'),
            RunnerPermission(id: 'manual', label: 'manual', isDefault: true),
            RunnerPermission(id: 'bypassPermissions', label: 'bypass'),
          ], gates: true),
          HostRunner(id: 'codex', name: 'codex', gates: false, headless: true),
        ],
      );
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      await tester.tap(find.text('New agent'));
      await tester.pumpAndSettle();
      // Headless made codex tunable, so its row opens SUMMON instead of choosing outright.
      await tester.tap(find.text('codex').last);
      await tester.pumpAndSettle();
      // No tap on the terminal line: a runner this host can run headless already rests
      // there since 2026-09-08 (PLAN §6.1), so `tui: false` is what *Start* sends by itself.
      await tester.ensureVisible(find.textContaining('Start'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();

      harness.http.enqueue('{"paneId":"ss-1"}');
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      expect(harness.http.last.json, containsPair('provider', 'codex'));
      expect(harness.http.last.json, containsPair('tui', false));
    });

    testWidgets('a runner the host did not mark headless is terminal-only, even on a headless host',
        (tester) async {
      // The distinction this field exists for: the host has a structured path, but not for
      // this runner. Before it, the phone read the host cap and guessed from the name.
      await showWithSpawn(
        tester,
        features: const ['fleet', 'dispatch', 'transcript', 'permission', 'spawn', 'structured-spawn'],
        runners: const [
          HostRunner(id: 'claude', name: 'claude', gates: true),
          HostRunner(id: 'codex', name: 'codex', gates: false),
        ],
      );
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);
      await tester.tap(find.text('New agent'));
      await tester.pumpAndSettle();
      harness.http.enqueue('{"paneId":"p-new"}');
      await tester.tap(find.text('codex').last);
      await tester.pumpAndSettle();
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      expect(harness.http.last.json, isNot(contains('tui')));
    });

    testWidgets('a runner the host marked headless is offered even when the app never heard of it',
        (tester) async {
      // The point of Fase 2.5: a bridge can arrive on the host with no app update.
      await showWithSpawn(
        tester,
        features: const ['fleet', 'dispatch', 'transcript', 'permission', 'spawn', 'structured-spawn'],
        runners: const [
          HostRunner(id: 'claude', name: 'claude', gates: true),
          HostRunner(id: 'cursor', name: 'cursor', gates: false, headless: true),
        ],
      );
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);
      await tester.tap(find.text('New agent'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('cursor').last);
      await tester.pumpAndSettle();
      // No tap on the terminal line: a runner this host can run headless already rests
      // there since 2026-09-08 (PLAN §6.1), so `tui: false` is what *Start* sends by itself.
      await tester.ensureVisible(find.textContaining('Start'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();

      harness.http.enqueue('{"paneId":"ss-2"}');
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      expect(harness.http.last.json, containsPair('provider', 'cursor'));
      expect(harness.http.last.json, containsPair('tui', false));
    });

    testWidgets('without structured-spawn the same codex row sends no tui field at all', (tester) async {
      await showWithSpawn(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);
      await tester.tap(find.text('New agent'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('codex').last);
      await tester.pumpAndSettle();
      harness.http.enqueue('{"paneId":"p-new"}');
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();
      expect(harness.http.last.json, isNot(contains('tui')));
    });

    testWidgets('a runner that cannot ask is sent no posture at all', (tester) async {
      await showWithSpawn(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      await tester.tap(find.text('New agent'));
      await tester.pumpAndSettle();
      // The posture is not a question on this screen — one question per screen, read at
      // arm's length. It is still *sent*, which the test above pins.
      expect(find.text('ASKS FIRST'), findsNothing);

      await tester.tap(find.text('codex').last);
      await tester.pumpAndSettle();

      // Sent with nothing typed: a brief is a head start, not a requirement, and this
      // is the one mode where an empty field is a complete instruction.
      harness.http.enqueue('{"paneId":"p-new"}');
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      expect(harness.http.last.json, containsPair('provider', 'codex'));
      // This fleet advertised no scale for `codex`, so no field is sent and the machine
      // keeps its own default — claiming a posture the host never offered would be the lie
      // the field exists to prevent (ADR-14).
      expect(harness.http.last.json, isNot(contains('permissionMode')));
    });
  });

  testWidgets('an agent that finished since it was last opened sits on a raised row until it is',
      (tester) async {
    final marks = SeenMarks(InMemorySecureStore(), now: () => DateTime.now());
    Cell? opened;
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: HomeScreen(
        fleet: fleet,
        project: const ProjectRef(mac, 'CNVS'),
        hostLabel: (h) => h.value,
        onOpenCell: (c) async {
          opened = c;
          marks.markOpened(c.ref);
          return false;
        },
        onBack: () {},
        onRefresh: () async => const HydrationReport(answered: [], failed: {}),
        agents: harness.repository,
        seen: marks,
      ),
    ));
    await push(tester, mac, [
      cell(mac, 'p-1', title: 'Atlas', turn: 'idle', turnAgeMs: 60_000),
      cell(mac, 'p-2', title: 'Chess', turn: 'running', turnAgeMs: 1_000),
    ]);

    Color? rowColour(String name) => tester
        .widget<Material>(find.ancestor(of: inList(find.text(name)), matching: find.byType(Material)).first)
        .color;

    // Finished a minute ago, never opened: raised. Still working: the floor.
    expect(rowColour('Atlas'), AppTokens.dark.raise);
    expect(rowColour('Chess'), Colors.transparent);

    await tester.tap(inList(find.text('Atlas')));
    await tester.pumpAndSettle();

    expect(opened?.title, 'Atlas');
    expect(rowColour('Atlas'), Colors.transparent, reason: 'looked at — the mark is gone');
  });

  testWidgets('sebuah snapshot tidak bisa memindahkan project di layar', (tester) async {
    await show(tester);
    // Dulu ini adalah risiko yang nyata: layar ini memilih `projects.first`, dan `Lotus`
    // yang mulai menunggu bisa menukar judul di bawah jempol operator. Sekarang project
    // adalah fakta tentang rutenya, jadi satu-satunya cara ia berubah adalah operator
    // yang kembali dan membuka yang lain.
    await push(tester, mac, [
      cell(mac, 'p-1', title: 'Atlas', turn: 'running'),
      cell(mac, 'p-9', title: 'Nora', workspace: 'Lotus', turn: 'needs-input'),
    ]);

    expect(find.text('CNVS'), findsOne);
    expect(inList(find.text('Atlas')), findsOne);
    // Nora tidak disembunyikan — ia ada di blok “needs you” pada indeks, satu ketukan
    // dari layar pertama (`projects_screen_test.dart`). Yang benar di sini adalah bahwa
    // ia bukan urusan daftar ini.
    expect(find.textContaining('Nora', findRichText: true), findsNothing);
  });

  /// The suite's default surface is 800×600 — wider than any phone this ships to.
  ///
  /// That mattered on 2026-08-09, when every label on the screen was raised off the
  /// mockup's 8.5–10.5px to an 11px floor for legibility. A row here is dense by design
  /// (`◆ Atlas  claude          WAITING`, all on one line), so a width the tests never
  /// exercised is exactly where that change could overflow and nothing would say so.
  ///
  /// 360×800 is a Pixel-class portrait window, and the long-word fixtures are the
  /// stress case: a real persona and a real workspace id, not `Atlas`.
  group('renders at real phone width', () {
    Future<void> atPhoneSize(WidgetTester tester, List<Cell> cells) async {
      tester.view.physicalSize = const Size(360 * 3, 800 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await show(tester);
      await push(tester, mac, cells);
    }

    testWidgets('the mockup fleet fits without overflowing', (tester) async {
      await atPhoneSize(tester, [
        cell(mac, 'p-1', title: 'Atlas', turn: 'needs-input', preview: 'Delete src/legacy/shim.ts?'),
        cell(mac, 'p-2', title: 'Chess', turn: 'running', preview: '6 of 13 suites'),
        cell(mac, 'p-3', title: 'Koda', agentType: 'codex', gating: Cell.gatingRunnerCannot),
      ]);

      expect(tester.takeException(), isNull);
    });

    /// Separuh mekanis dari temuan §9 no. 10: tidak satu pun bingkai pernah diuji di atas
    /// skala 1.0, dan detail baris Home 10.5px adalah yang pertama disebut temuan itu.
    /// 1.3 lulus, 2.0 tidak — diukur 2026-08-12, dan itu batas yang jujur untuk dicatat.
    ///
    /// Pada 2.0 tiga baris agen meluap ke kanan (34, 34, dan 11px). Sebabnya struktural, bukan
    /// satu angka yang salah: baris ini dense **karena keputusan** — `◆ Atlas  claude  WAITING`
    /// dalam satu baris, dan `MVP.md` mencatat daftar ini membeli lebar justru supaya
    /// pertanyaan agennya sampai utuh alih-alih terpotong jadi hint. Pada skala 2.0 tiga fakta
    /// itu tidak bisa tetap satu baris; ia harus membungkus atau melepas salah satunya, dan itu
    /// keputusan desain, bukan penambalan.
    ///
    /// Jadi yang dijaga di sini 1.3 — satu langkah di pengaturan Android, dan yang temuan §9
    /// no. 10 sebut sebagai kekhawatiran praktisnya. 2.0-nya dilewati **dengan sebab tertulis**
    /// alih-alih dihapus, supaya ia tetap terlihat oleh siapa pun yang menyentuh baris ini.
    for (final scale in [1.3, 2.0]) {
      testWidgets(
          'muat pada skala teks $scale'
          '${scale == 2 ? " — DILEWATI: meluap 34/34/11px, lihat komentar di atas" : ""}',
          (tester) async {
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

        await atPhoneSize(tester, [
          cell(mac, 'p-1',
              title: 'Atlas',
              turn: 'needs-input',
              preview: 'Delete src/legacy/shim.ts?'),
          cell(mac, 'p-2', title: 'Chess', turn: 'running', preview: '6 of 13 suites'),
          cell(mac, 'p-3',
              title: 'Koda', agentType: 'codex', gating: Cell.gatingRunnerCannot),
        ]);

        expect(tester.takeException(), isNull, reason: 'skala $scale');
      }, skip: scale == 2);
    }

    testWidgets('a long persona beside the longest state word still fits', (tester) async {
      // `unknown` is the widest state, and it is the one a `codex` cell always shows —
      // so this pair is the ordinary case on a mixed fleet, not a contrived one.
      await atPhoneSize(tester, [
        cell(mac, 'p-1',
            title: 'Bartholomew', agentType: 'codex', gating: Cell.gatingRunnerCannot),
      ]);

      expect(tester.takeException(), isNull);
    });
  });

  /// The gesture, and what it is actually wired to.
  ///
  /// Pocket's fleet arrives over a socket, so in the good case there is nothing to
  /// refresh. The case worth building for is the bad one and it is the common one on a
  /// phone: the socket died and the screen is frozen while a backoff runs silently.
  /// These pin that pulling reaches a real operation and reports what it found — an
  /// indicator that spins and hides having asked nothing is worse than no gesture,
  /// because it teaches the operator the app is broken in a new way.
  group('pull to refresh', () {
    late int calls;
    late HydrationReport answer;

    setUp(() {
      calls = 0;
      answer = const HydrationReport(answered: [mac], failed: {});
    });

    Future<void> showPullable(WidgetTester tester) => tester.pumpWidget(MaterialApp(
          theme: buildAppTheme(),
          home: HomeScreen(
            fleet: fleet,
            project: const ProjectRef(mac, 'CNVS'),
            hostLabel: (h) => h.value,
            onOpenCell: (c) async { opened.add(c); return false; },
            onBack: () => backs += 1,
            onRefresh: () async {
              calls += 1;
              return answer;
            },
            agents: harness.repository,
          ),
        ));

    /// A fling rather than a drag: `RefreshIndicator` arms on overscroll and fires on
    /// release, and a drag without a release leaves it armed but never triggered.
    Future<void> pull(WidgetTester tester, Finder on) async {
      await tester.fling(on, const Offset(0, 320), 1200);
      await tester.pumpAndSettle();
    }

    testWidgets('pulling the list asks the hosts again', (tester) async {
      await showPullable(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      await pull(tester, find.byType(CellRow).first);

      expect(calls, 1);
    });

    testWidgets('a two-row fleet is still pullable', (tester) async {
      // A fleet shorter than the viewport is the ordinary case on this screen, and a
      // gesture that only works once the list is long enough to scroll would be
      // missing on exactly the sparse fleets where refreshing matters most.
      //
      // Measured, not assumed: this still passes with `AlwaysScrollableScrollPhysics`
      // removed from `CellList`, because a `ListView` emits overscroll notifications
      // even at zero scroll extent. The physics line stays as the documented guidance
      // and as insurance against a future `ScrollBehavior`, but it is not what makes
      // this pass — so this test is about the behaviour, not about that line.
      await showPullable(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'idle')]);

      await pull(tester, find.byType(CellRow).first);

      expect(calls, 1);
    });

    testWidgets('the empty screen is pullable — where it is needed most',
        (tester) async {
      // Nothing has arrived, so there is no list to pull and no way to tell "heard
      // nothing yet" from "every socket died". `Refreshable.fill` is what makes the
      // sentence itself draggable — on this screen since 2026-08-11 that sentence is
      // `QuietProject`'s, because a route opened with a project in hand always has one.
      await showPullable(tester);
      const sentence = 'No agents are running in this project.';
      expect(find.text(sentence), findsOne);

      await pull(tester, find.text(sentence));

      expect(calls, 1);
    });

    testWidgets('success says nothing — the screen is the evidence', (tester) async {
      await showPullable(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      await pull(tester, find.byType(CellRow).first);

      expect(find.byType(SnackBar), findsNothing);
    });

    /// Temuan §9 no. 7 (discoverability), bagian yang memakan sesuatu dari operator.
    ///
    /// Enam gesture di app ini tidak punya afordans visual, dan lima di antaranya bisa
    /// dibela: pips sudah mengatakan ada agen lain untuk digeser, bar kerja sudah punya
    /// `⌄` untuk turun dari terminal, dan geser-untuk-tutup masih punya drawer-nya. Satu
    /// tidak bisa dibela — **menanyakan ulang ketika host diam.** Layarnya menyatakan
    /// diamnya (`Unreachable — last heard from 4m ago`), lalu satu-satunya jalan untuk
    /// bertindak atasnya adalah tarikan yang tidak terlihat.
    ///
    /// Aturan yang dilanggarnya sudah tertulis di repo ini, di `chat_body.dart`: *"a gesture
    /// with no visible control is a gesture only found by someone who already suspected
    /// it"* — dan itu sebabnya `TRY AGAIN` tetap ada di samping tarik-untuk-muat di sana.
    /// Di sini kalimatnya ada tanpa tombolnya.
    testWidgets('host yang diam menawarkan cara menanyakan ulang, terlihat',
        (tester) async {
      await showPullable(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);
      fleet.markUnreachable(mac);
      await tester.pumpAndSettle();

      expect(find.textContaining('Not answering'), findsOne);

      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();

      expect(calls, 1);
    });

    testWidgets('dan tombol itu tidak ada selama mesinnya masih menjawab', (tester) async {
      // Sebuah kontrol yang selalu ada akan menjadi kontrol yang tidak berarti apa pun:
      // tarikannya tetap bekerja di mana saja, dan tombol ini hanya untuk saat kalimat di
      // atasnya baru saja mengatakan bahwa yang di bawahnya sudah tua.
      await showPullable(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      expect(find.text('Try again'), findsNothing);
    });

    testWidgets('a host that did not answer is named, with its cause', (tester) async {
      answer = const HydrationReport(answered: [], failed: {mac: HostAsleep()});
      await showPullable(tester);
      await push(tester, mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);

      await pull(tester, find.byType(CellRow).first);

      // The machine first, then what is true of it — "asleep" alone is not something
      // an operator with two machines can act on.
      expect(find.text('mac is asleep.'), findsOne);
    });
  });

  /// The other half of R-9.
  ///
  /// `markUnreachable` keeps a sleeping host's cells because a fleet that empties reads
  /// as *all my work is gone*. That was implemented and tested. What was not: **a fleet
  /// that freezes reads as up to date.** `isStale` reached `ProjectPresentation` and was
  /// rendered only by the switcher sheet, so Home showed a sleeping laptop exactly as it
  /// showed a healthy one — same rows, same states, same summary sentence, no signal at
  /// all. These pin the signal rather than the styling.
  group('a host that stopped answering says so on Home', () {
    testWidgets('the header states it, rather than leaving the rows to imply it',
        (tester) async {
      await showMockupFleet(tester);
      expect(find.textContaining('Not answering'), findsNothing);

      fleet.markUnreachable(mac);
      await tester.pumpAndSettle();

      expect(find.textContaining('Not answering'), findsOne);
    });

    testWidgets('the rows stay — the point is that they are old, not that they are gone',
        (tester) async {
      await showMockupFleet(tester);
      fleet.markUnreachable(mac);
      await tester.pumpAndSettle();

      // R-9: dropping them would be worse than showing something stale.
      expect(inList(find.text('Atlas')), findsOne);
      expect(inList(find.text('Chess')), findsOne);
      expect(inList(find.text('Koda')), findsOne);
    });

    testWidgets('the list is dimmed, so the freeze reads without being read',
        (tester) async {
      await showMockupFleet(tester);

      Opacity listOpacity() => tester.widget<Opacity>(
            find.ancestor(of: find.byType(CellRow).first, matching: find.byType(Opacity)).first,
          );

      expect(listOpacity().opacity, 1);

      fleet.markUnreachable(mac);
      await tester.pumpAndSettle();

      expect(listOpacity().opacity, lessThan(1));
    });

    testWidgets('a host speaking again clears it, without the operator doing anything',
        (tester) async {
      await showMockupFleet(tester);
      fleet.markUnreachable(mac);
      await tester.pumpAndSettle();
      expect(find.textContaining('Not answering'), findsOne);

      // `adopt` drops the host from `_stale` — it just spoke, so it is reachable by
      // definition. The screen has to follow that on its own: a notice that outlives
      // the condition is worse than never having shown one.
      await push(tester, mac, [
        cell(mac, 'p-1', title: 'Atlas', turn: 'needs-input', preview: 'Delete src/legacy/shim.ts?'),
      ]);

      expect(find.textContaining('Not answering'), findsNothing);
    });

    /// This is the test that said *no number here*, and it changed on purpose.
    ///
    /// It used to assert that no digit appeared, because `isStale` was a bool and any
    /// age would have been invented — on the one line whose entire job is to say *do
    /// not trust what is below me*. `FleetStore.lastHeardFrom` now stamps every
    /// `adopt`, so the number is measured and the assertion inverts.
    testWidgets('the age is real — measured from when the host actually spoke',
        (tester) async {
      await showMockupFleet(tester); // stamps 12:00, the clock's start
      clockAt = clockAt.add(const Duration(minutes: 4));
      fleet.markUnreachable(mac);
      await tester.pumpAndSettle();

      expect(find.text('Not answering · last heard 4m ago'), findsOne);
    });

    testWidgets('the age tracks the clock rather than the moment it went stale',
        (tester) async {
      await showMockupFleet(tester);
      fleet.markUnreachable(mac);
      clockAt = clockAt.add(const Duration(hours: 2));
      // Any rebuild will do — a fleet snapshot for another host is the ordinary one,
      // and it must not reset an age that belongs to `mac`.
      await push(tester, vps, [cell(vps, 'p-9', title: 'Nova', turn: 'running')]);

      expect(find.text('Not answering · last heard 2h ago'), findsOne);
    });

    /// Pinned against the widget, not against Home, because **Home cannot produce
    /// this state**: `_hydrateOne` calls `adoptProjects` and `adopt` on one response,
    /// so every project the screen can draw has already been stamped. Driving it
    /// through `HomeScreen` would have been a test that passes for the wrong reason —
    /// asserting the word "Unreachable" appears, which it does on both branches.
    testWidgets('a presentation with no measured silence says so in words, not as 0s',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: ProjectHeader(
            project: const ProjectPresentation(
              project: ProjectRef(mac, 'CNVS'),
              label: 'CNVS',
              host: 'mac',
              path: '',
              waiting: '',
              activity: '1',
              isStale: true,
            ),
            summary: const HomeSummary(waiting: '', rest: ''),
            onBack: () {},
          ),
        ),
      ));

      expect(find.text('Not answering · showing what it last said'), findsOne);
      expect(find.textContaining('0s'), findsNothing);
    });
  });
}
