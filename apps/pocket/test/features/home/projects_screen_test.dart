import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/features/home/add_project.dart';
import 'package:lotus_pocket/features/home/projects_screen.dart';
import 'package:lotus_pocket/features/home/widgets/project_row.dart';
import 'package:lotus_pocket/models/bootstrap.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

Cell cell(
  HostId host,
  String paneId, {
  required String title,
  String workspace = 'CNVS',
  String? turn,
  String? preview,
}) =>
    Cell(
      host: host,
      paneId: paneId,
      workspaceId: workspace,
      agentType: 'claude',
      title: title,
      status: 'live',
      isAlive: true,
      turn: turn,
      lastOutputPreview: preview,
    );

/// [id] terpisah dari [name] karena keduanya memang terpisah di produksi: satu mesin bisa
/// punya dua workspace berbeda yang sama-sama bernama `pocket`.
HostProject project(
  HostId host,
  String name, {
  String? id,
  String path = '/tmp/x',
}) =>
    HostProject(
      project: ProjectRef(host, id ?? name),
      name: name,
      path: path,
      lastOpenedAt: 0,
    );

/// Indeks project sebagai rumah — `plans/lotus-pocket/design/revamp-modern.html` M1/M2.
///
/// Ini memicu klausul falsifikasi yang ADR-3 revisi kedua tulis untuk dirinya sendiri: ketika
/// `awaiting` rutin ada di tiga project sekaligus, satu baris `elsewhere` tidak cukup. Yang
/// harus tetap benar adalah propertinya, bukan mekanismenya — **agen yang menunggu tidak
/// pernah bisa tersembunyi di balik pengalih** — dan di sini blok “needs you” yang memikulnya.
void main() {
  late StreamController<HostEvent> events;
  late FleetStore fleet;
  final openedProjects = <ProjectRef>[];
  final openedAgents = <Cell>[];

  setUp(() {
    events = StreamController<HostEvent>.broadcast();
    fleet = FleetStore(events.stream);
    openedProjects.clear();
    openedAgents.clear();
  });

  tearDown(() => events.close());

  Widget host({
    List<AddProjectTarget> addTargets = const [],
    void Function(AddProjectChoice)? onAddProject,
  }) =>
      MaterialApp(
        theme: buildAppTheme(),
        home: ProjectsScreen(
          fleet: fleet,
          hostLabel: (h) => h == mac ? '' : h.value,
          onOpenProject: openedProjects.add,
          onOpenAgent: openedAgents.add,
          onOpenDiagnostics: () {},
          onRefresh: () async {},
          addTargets: addTargets,
          onAddProject: onAddProject,
        ),
      );

  testWidgets('mendaftar setiap project, dan membuka yang ditekan', (tester) async {
    fleet.adoptProjects(mac, [project(mac, 'CNVS'), project(mac, 'orbit')]);
    fleet.adopt(mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);
    await tester.pumpWidget(host());

    expect(find.text('Projects'), findsOneWidget);
    expect(find.text('CNVS'), findsOneWidget);
    // Project yang tidak menjalankan apa pun tetap ada: sejak ADR-14 sebuah project ada
    // terlepas dari apakah ada yang berjalan di dalamnya.
    expect(find.text('orbit'), findsOneWidget);

    await tester.tap(find.text('CNVS'));
    await tester.pumpAndSettle();

    expect(openedProjects, [const ProjectRef(mac, 'CNVS')]);
  });

  testWidgets('tiga agen menunggu di tiga project: semuanya di puncak layar',
      (tester) async {
    // Skenario yang ADR-3 revisi kedua sebut sebagai batas kekuatannya. Sebelumnya dua di
    // antaranya berada di balik satu baris “2 agents are waiting elsewhere”.
    fleet.adoptProjects(mac, [project(mac, 'CNVS'), project(mac, 'Lotus')]);
    fleet.adoptProjects(vps, [project(vps, 'Lotus')]);
    fleet.adopt(mac, [
      cell(mac, 'p-1',
          title: 'Atlas',
          workspace: 'CNVS',
          turn: 'needs-input',
          preview: 'Delete src/legacy/shim.ts?'),
      cell(mac, 'p-2',
          title: 'Nora', workspace: 'Lotus', turn: 'needs-input', preview: 'Push to main?'),
    ]);
    fleet.adopt(vps, [
      cell(vps, 'p-9',
          title: 'Pi', workspace: 'Lotus', turn: 'needs-input', preview: 'Run migration?'),
    ]);
    await tester.pumpWidget(host());

    // Yang disebut adalah **agen dan pertanyaannya**, bukan project — jadi menjawabnya satu
    // ketukan dari layar pertama, dan tak satu pun bisa bersembunyi di balik indeks.
    for (final who in ['Atlas', 'Nora', 'Pi']) {
      expect(find.text(who), findsOneWidget, reason: '$who harus ada di puncak layar');
    }
    expect(find.text('Delete src/legacy/shim.ts?'), findsOneWidget);

    await tester.tap(find.text('Atlas'));
    await tester.pumpAndSettle();

    expect(openedAgents.map((c) => c.title), ['Atlas']);
  });

  testWidgets('project yang memegang cell paling mendesak ada di puncak indeks',
      (tester) async {
    // Dulu dibuktikan lewat Home, ketika layar itu membuka `projects.first` sendiri.
    // Home tidak memilih apa pun lagi, jadi jaminannya pindah ke tempat urutan itu
    // sekarang terlihat — bukan dihapus bersama tesnya.
    fleet.adoptProjects(mac, [project(mac, 'Sleepy'), project(mac, 'Busy')]);
    fleet.adopt(mac, [
      cell(mac, 'p-1', title: 'Quiet one', workspace: 'Sleepy'),
      cell(mac, 'p-9', title: 'Urgent one', workspace: 'Busy', turn: 'needs-input'),
    ]);
    await tester.pumpWidget(host());

    // Bukan pilihan layar ini: `FleetStore` mengurutkan menunggu-dulu (ADR-12 no. 1).
    final rows = tester
        .widgetList<ProjectRow>(find.byType(ProjectRow))
        .map((r) => r.project.label)
        .toList();
    expect(rows.first, 'Busy');
  });

  /// Temuan §9 no. 7, contoh keduanya. Indeks ini juga menyatakan bahwa sebuah mesin diam
  /// (`· unreachable` di barisnya) lalu menyerahkan satu-satunya cara bertindak atasnya
  /// kepada tarikan yang tidak terlihat — persis celah yang sama seperti di header Home.
  group('mesin yang diam bisa ditanyakan ulang tanpa menebak gesture', () {
    testWidgets('kontrolnya muncul ketika ada yang basi, dan menanyakan ulang',
        (tester) async {
      var asked = 0;
      fleet.adoptProjects(mac, [project(mac, 'CNVS')]);
      fleet.adopt(mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: ProjectsScreen(
          fleet: fleet,
          hostLabel: (h) => h.value,
          onOpenProject: openedProjects.add,
          onOpenAgent: openedAgents.add,
          onOpenDiagnostics: () {},
          onRefresh: () async => asked += 1,
        ),
      ));
      fleet.markUnreachable(mac);
      await tester.pumpAndSettle();

      expect(find.textContaining('unreachable', findRichText: true), findsOne);
      // One capsule under the header names the machine and when it last spoke.
      expect(find.textContaining('mac is not answering · seen '), findsOne);

      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();

      expect(asked, 1);
    });

    testWidgets('dan tidak ada selama setiap mesin masih menjawab', (tester) async {
      fleet.adoptProjects(mac, [project(mac, 'CNVS')]);
      fleet.adopt(mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);
      await tester.pumpWidget(host());

      expect(find.text('Try again'), findsNothing);
    });
  });

  /// Tiga jaminan yang dulu dipikul sheet switcher, dipindah sebelum sheet itu dihapus.
  ///
  /// Alasan aslinya tidak berubah — ADR-3 revisi kedua menaruh angka di baris project supaya
  /// keadaan sebuah project **terbaca sebelum operator pindah ke sana**, dan R-10 ada karena
  /// dua mesin bisa sama-sama menjalankan `CNVS`. Yang berubah hanya di mana barisnya berada.
  group('yang dulu dipikul sheet switcher', () {
    testWidgets('setiap baris membawa apa yang terjadi di sana', (tester) async {
      fleet.adoptProjects(mac, [project(mac, 'CNVS'), project(mac, 'Lotus')]);
      fleet.adopt(mac, [
        cell(mac, 'p-1', title: 'Atlas', workspace: 'CNVS', turn: 'needs-input'),
        cell(mac, 'p-2', title: 'Chess', workspace: 'CNVS', turn: 'running'),
        cell(mac, 'p-9', title: 'Nora', workspace: 'Lotus', turn: 'idle'),
      ]);
      await tester.pumpWidget(host());

      // `1 · 2` untuk CNVS: yang meminta dulu, lalu skalanya.
      expect(find.textContaining('1', findRichText: true), findsWidgets);
      expect(find.textContaining('idle', findRichText: true), findsOne);
    });

    testWidgets('dua project bernama sama di dua mesin adalah dua baris', (tester) async {
      fleet.adoptProjects(mac, [project(mac, 'CNVS')]);
      fleet.adoptProjects(vps, [project(vps, 'CNVS')]);
      await tester.pumpWidget(host());

      expect(find.text('CNVS'), findsNWidgets(2));
      // Mesinnya yang membedakan, dan hanya muncul ketika ia memang membedakan sesuatu:
      // `hostLabel` di harness ini mengembalikan kosong untuk `mac`.
      expect(find.text('vps'), findsOne);

      await tester.tap(find.text('vps'));
      await tester.pumpAndSettle();

      // Yang dibuka adalah (host, project), bukan namanya — kalau tidak, dua baris ini
      // akan membuka satu layar yang sama.
      expect(openedProjects, [const ProjectRef(vps, 'CNVS')]);
    });

    testWidgets('path muncul hanya di mana dua baris akan terbaca identik', (tester) async {
      fleet.adoptProjects(mac, [
        project(mac, 'pocket', id: 'a', path: '/Users/op/srv/pocket'),
        project(mac, 'pocket', id: 'b', path: '/Users/op/experiments/pocket'),
        project(mac, 'lotus', id: 'c', path: '/Users/op/code/lotus'),
      ]);
      await tester.pumpWidget(host());

      expect(find.text('~/srv/pocket'), findsOne);
      expect(find.text('~/experiments/pocket'), findsOne);
      // `lotus` tidak bertabrakan dengan apa pun, jadi path-nya hanya akan jadi derau.
      expect(find.text('~/code/lotus'), findsNothing);
    });
  });

  /// Dock di dasar layar — `design/revamp-modern.html` M1. Zona jempol, bukan pojok atas.
  ///
  /// Tombol `+` sengaja tidak ada: memulai agen butuh sebuah project, dan `+` lalu memilih
  /// project berbiaya ketukan yang sama dengan membuka project lalu menekan `New agent` —
  /// jadi ia menambah satu permukaan tanpa menghemat apa pun (keputusan operator,
  /// 2026-08-11).
  group('mencari project', () {
    Future<void> type(WidgetTester tester, String text) async {
      await tester.enterText(find.byType(TextField), text);
      await tester.pumpAndSettle();
    }

    testWidgets('mengetik menyaring daftarnya', (tester) async {
      fleet.adoptProjects(mac, [
        project(mac, 'CNVS'),
        project(mac, 'Lotus'),
        project(mac, 'muse'),
      ]);
      await tester.pumpWidget(host());

      await type(tester, 'lot');

      expect(find.text('Lotus'), findsOne);
      expect(find.text('CNVS'), findsNothing);
      expect(find.text('muse'), findsNothing);
    });

    testWidgets('menghapus query mengembalikan semuanya', (tester) async {
      fleet.adoptProjects(mac, [project(mac, 'CNVS'), project(mac, 'Lotus')]);
      await tester.pumpWidget(host());

      await type(tester, 'lot');
      await type(tester, '');

      expect(find.text('CNVS'), findsOne);
      expect(find.text('Lotus'), findsOne);
    });

    testWidgets('query yang tidak cocok mengatakannya, bukan diam kosong',
        (tester) async {
      fleet.adoptProjects(mac, [project(mac, 'CNVS')]);
      await tester.pumpWidget(host());

      await type(tester, 'zzz');

      // Layar kosong tanpa kalimat terbaca sebagai app yang kehilangan datanya — dan
      // `Nothing here yet.` akan menjadi kebohongan, karena project-nya ada.
      expect(find.textContaining('No project matches'), findsOne);
      expect(find.text('Nothing here yet'), findsNothing);
    });

    testWidgets('Clear search on the empty state brings the index back and empties the field',
        (tester) async {
      fleet.adoptProjects(mac, [project(mac, 'CNVS')]);
      await tester.pumpWidget(host());

      await type(tester, 'zzz');
      expect(find.text('“zzz”'), findsOne);
      await tester.tap(find.text('Clear search'));
      await tester.pumpAndSettle();

      expect(find.text('CNVS'), findsOne);
      expect(find.widgetWithText(TextField, 'zzz'), findsNothing);
    });

    testWidgets('agen yang menunggu tidak bisa disembunyikan oleh sebuah query',
        (tester) async {
      // Properti yang mengikat sejak ADR-3 revisi pertama, dan yang ADR-15 pindahkan ke
      // blok ini: **`awaiting` tidak pernah bisa tersembunyi di balik pengalih.** Sebuah
      // field pencarian adalah pengalih paling halus yang bisa dibangun — ia menyaring
      // dengan diam — jadi menyaring blok ini akan melanggar aturan itu dengan mekanisme
      // baru, beberapa jam sesudah mekanisme lama dipensiunkan karena alasan yang sama.
      fleet.adoptProjects(mac, [project(mac, 'CNVS'), project(mac, 'Lotus')]);
      fleet.adopt(mac, [
        cell(mac, 'p-1',
            title: 'Atlas',
            workspace: 'CNVS',
            turn: 'needs-input',
            preview: 'Delete src/legacy/shim.ts?'),
      ]);
      await tester.pumpWidget(host());

      await type(tester, 'zzz');

      expect(find.text('Atlas'), findsOne, reason: 'query tidak boleh menyembunyikannya');
      expect(find.text('Delete src/legacy/shim.ts?'), findsOne);

      await tester.tap(find.text('Atlas'));
      await tester.pumpAndSettle();

      // Dan ia masih bisa dijawab, bukan cuma terlihat.
      expect(openedAgents.map((c) => c.title), ['Atlas']);
    });

    testWidgets('indeks penuh + blok menunggu + dock muat di lebar HP sungguhan',
        (tester) async {
      // Permukaan default suite ini 800×600 — lebih lebar dan lebih pendek dari HP mana pun
      // yang app ini kirimi. Layar ini yang paling padat secara vertikal (judul, strap, blok
      // amber, daftar, baris Diagnostics, dock 50px + padding 32), jadi 360×800 adalah
      // tempat tumpukan itu bisa meluap tanpa ada yang memberi tahu.
      tester.view.physicalSize = const Size(360 * 3, 800 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      fleet.adoptProjects(mac, [
        for (var i = 0; i < 8; i++)
          project(mac, 'project-with-a-long-name-$i', id: 'p$i'),
      ]);
      fleet.adopt(mac, [
        cell(mac, 'c-1',
            title: 'Atlas',
            workspace: 'p0',
            turn: 'needs-input',
            preview: 'Delete src/legacy/shim.ts and rewrite the barrel export?'),
      ]);
      await tester.pumpWidget(host());

      expect(tester.takeException(), isNull);

      await type(tester, 'project-with');
      expect(tester.takeException(), isNull);
    });

    /// Separuh mekanis dari temuan §9 no. 10. Layar ini yang paling padat vertikal, dan
    /// strap-nya mono 10.5px — jadi ia dua kali terdorong: hurufnya membesar, dan tumpukannya
    /// meninggi.
    testWidgets('muat di 360×800 pada skala teks 1.3, lalu 2.0', (tester) async {
      for (final scale in [1.3, 2.0]) {
        tester.view.physicalSize = const Size(360 * 3, 800 * 3);
        tester.view.devicePixelRatio = 3;
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.view.reset);
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

        fleet.adoptProjects(mac, [
          for (var i = 0; i < 8; i++) project(mac, 'project-$i', id: 'p$i'),
        ]);
        fleet.adopt(mac, [
          cell(mac, 'c-1',
              title: 'Atlas',
              workspace: 'p0',
              turn: 'needs-input',
              preview: 'Delete src/legacy/shim.ts?'),
        ]);
        await tester.pumpWidget(host());

        expect(tester.takeException(), isNull, reason: 'skala $scale');
      }
    });

    testWidgets('Diagnostics juga tidak ikut tersaring', (tester) async {
      fleet.adoptProjects(mac, [project(mac, 'CNVS')]);
      await tester.pumpWidget(host());

      await type(tester, 'zzz');

      expect(find.text('Diagnostics'), findsOne);
    });
  });

  group('Diagnostics tidak boleh ikut mati bersama sheet switcher', () {
    // Sampai 2026-08-11 Diagnostics hanya bisa dicapai dari baris terakhir sheet switcher
    // dan dari keadaan kosong. Indeks ini menghapus alasan sheet itu ada, jadi kalau
    // jalannya tidak dipindah lebih dulu, layar yang menjelaskan *mengapa* sebuah fleet
    // kosong menjadi tak terjangkau — persisnya jalan buntu yang `nothing_yet.dart`
    // catat pernah ditemukan dengan telepon yang terpasang ke host yang tidak ada.
    testWidgets('fleet yang kosong tetap menawarkan layar yang menjelaskan sebabnya',
        (tester) async {
      var opens = 0;
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: ProjectsScreen(
          fleet: fleet,
          hostLabel: (h) => h.value,
          onOpenProject: openedProjects.add,
          onOpenAgent: openedAgents.add,
          onOpenDiagnostics: () => opens += 1,
          onRefresh: () async {},
        ),
      ));

      expect(find.text('Nothing here yet'), findsOne);

      await tester.tap(find.text('Diagnostics'));
      await tester.pumpAndSettle();

      expect(opens, 1);
    });

    testWidgets('dan tetap terjangkau ketika indeksnya penuh', (tester) async {
      var opens = 0;
      fleet.adoptProjects(mac, [
        for (var i = 0; i < 12; i++) project(mac, 'p$i'),
      ]);
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: ProjectsScreen(
          fleet: fleet,
          hostLabel: (h) => h.value,
          onOpenProject: openedProjects.add,
          onOpenAgent: openedAgents.add,
          onOpenDiagnostics: () => opens += 1,
          onRefresh: () async {},
        ),
      ));

      // Di luar daftar yang menggulir, alasan yang sama seperti di kaki sheet: fleet yang
      // panjang tidak boleh mendorong satu-satunya jalan ke Diagnostics keluar layar.
      await tester.tap(find.text('Diagnostics'));
      await tester.pumpAndSettle();

      expect(opens, 1);
    });
  });

  testWidgets('tidak ada yang menunggu: bloknya tidak ada, dan strapnya bilang begitu',
      (tester) async {
    fleet.adoptProjects(mac, [project(mac, 'CNVS')]);
    fleet.adopt(mac, [cell(mac, 'p-1', title: 'Atlas', turn: 'running')]);
    await tester.pumpWidget(host());

    // `Nobody needs you` adalah keterangan, bukan lelucon: ia dicetak tepat ketika blok di
    // atasnya tidak ada.
    // Strap-nya mono-kapital, seperti di mockup.
    expect(find.textContaining('NOBODY NEEDS YOU'), findsOneWidget);
    expect(find.text('Needs you'), findsNothing);
    expect(find.text('Atlas'), findsNothing,
        reason: 'agen tidak didaftar di indeks kecuali ia meminta sesuatu');
  });

  /// Pintu menambah project. Digambar hanya ketika sebuah mesin benar-benar menerimanya —
  /// `plans/pocket-vps-project-checkout/issues/03`, dan disiplin yang sama yang menggerbangi
  /// Chat, dikte dan spawn.
  group('Add project', () {
    const offersBoth = AddProjectTarget(host: vps, canClone: true, canBrowse: true);

    testWidgets('tidak ada baris ketika tidak ada mesin yang menerimanya', (tester) async {
      fleet.adoptProjects(mac, [project(mac, 'CNVS')]);
      await tester.pumpWidget(host());

      expect(find.text('Add project'), findsNothing);
      // Dan pita kakinya tetap ada — yang hilang hanya barisnya.
      expect(find.text('Diagnostics'), findsOneWidget);
    });

    testWidgets('ada di pita kaki ketika sebuah mesin menerimanya', (tester) async {
      fleet.adoptProjects(mac, [project(mac, 'CNVS')]);
      await tester.pumpWidget(host(addTargets: const [offersBoth], onAddProject: (_) {}));

      expect(find.text('Add project'), findsOneWidget);
      expect(find.text('Diagnostics'), findsOneWidget);
    });

    testWidgets('dua jalan: sheet-nya menawarkan keduanya', (tester) async {
      final chosen = <AddProjectChoice>[];
      fleet.adoptProjects(mac, [project(mac, 'CNVS')]);
      await tester.pumpWidget(host(addTargets: const [offersBoth], onAddProject: chosen.add));

      await tester.tap(find.text('Add project'));
      await tester.pumpAndSettle();

      expect(find.text('Clone a repository'), findsOneWidget);
      expect(find.text('Pick a folder'), findsOneWidget);

      await tester.tap(find.text('Clone a repository'));
      await tester.pumpAndSettle();

      expect(chosen.map((c) => c.door), [AddProjectDoor.clone]);
    });

    testWidgets('satu jalan: sheet-nya dilewati, bukan ditampilkan dengan satu baris',
        (tester) async {
      // Sebuah sheet yang menanyakan pertanyaan dengan satu jawaban bukan pertanyaan —
      // dan ketukan tambahannya adalah biaya yang membuat `+` di sebelah dock ditolak.
      final chosen = <AddProjectChoice>[];
      fleet.adoptProjects(mac, [project(mac, 'CNVS')]);
      await tester.pumpWidget(host(
        addTargets: const [AddProjectTarget(host: vps, canClone: true, canBrowse: false)],
        onAddProject: chosen.add,
      ));

      await tester.tap(find.text('Add project'));
      await tester.pumpAndSettle();

      expect(chosen.map((c) => c.door), [AddProjectDoor.clone]);
      expect(find.text('Clone a repository'), findsNothing);
    });

    testWidgets('indeks kosong: ia naik jadi aksi utama, dan Diagnostics tetap ada',
        (tester) async {
      await tester.pumpWidget(host(addTargets: const [offersBoth], onAddProject: (_) {}));

      expect(find.text('Add project'), findsOneWidget);
      expect(find.text('Diagnostics'), findsOneWidget);
    });

    testWidgets('indeks kosong tanpa mesin yang menerimanya: hanya Diagnostics',
        (tester) async {
      await tester.pumpWidget(host());

      expect(find.text('Add project'), findsNothing);
      expect(find.text('Diagnostics'), findsOneWidget);
    });

    testWidgets('fleet yang panjang tidak mendorongnya keluar layar', (tester) async {
      // Ia hidup di luar daftar yang menggulir, aturan yang sama yang menaruh
      // `DiagnosticsRow` di sana.
      fleet.adoptProjects(mac, [
        for (var i = 0; i < 40; i++) project(mac, 'proyek-$i'),
      ]);
      await tester.pumpWidget(host(addTargets: const [offersBoth], onAddProject: (_) {}));

      expect(find.text('Add project'), findsOneWidget);
    });
  });
}
