import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/home/widgets/start_button.dart';
import 'package:lotus_pocket/features/projects/browse_screen.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../../support/agent_harness.dart';

const HostId mac = HostId('mac');

const String rootsOnly = '''
{"roots":[{"name":"lotus-workspaces","path":"/op/ws"},{"name":"kerja","path":"/op/kerja"}],
 "page":null}
''';

String pageAt(String path, {String? parent, String entries = '', bool takeable = true, String whyNot = 'null'}) => '''
{"roots":[{"name":"lotus-workspaces","path":"/op/ws"},{"name":"kerja","path":"/op/kerja"}],
 "page":{"path":"$path","parent":${parent == null ? 'null' : '"$parent"'},
         "entries":[$entries],"takeable":$takeable,"whyNot":$whyNot}}
''';

const String repoRow =
    '{"name":"tkt","path":"/op/kerja/tkt","isRepo":true,"branch":"main","children":9,"isProject":false}';
const String takenRow =
    '{"name":"sudah","path":"/op/kerja/sudah","isRepo":true,"branch":"main","children":3,"isProject":true}';

/// Layar 05 dan 06 di `plans/pocket-vps-project-checkout/design/add-project.html`.
void main() {
  Future<AgentHarness> open(WidgetTester tester, List<String> replies) async {
    final h = await AgentHarness.paired(hosts: const [mac]);
    for (final reply in replies) {
      h.http.enqueue(reply);
    }
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () => showBrowseFolder(
            context,
            projects: h.projects,
            host: mac,
            machine: 'vps',
            onArrived: () async {},
          ),
          child: const Text('go'),
        ),
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pumpAndSettle();
    return h;
  }

  testWidgets('dengan dua root, ia mulai dengan menanyakan yang mana', (tester) async {
    await open(tester, [rootsOnly]);

    expect(find.text('lotus-workspaces'), findsOneWidget);
    expect(find.text('kerja'), findsOneWidget);
    // Tidak ada folder di layar untuk diambil, jadi tidak ada yang bisa ditekan.
    expect(tester.widget<StartButton>(find.byType(StartButton)).onStart, isNull);
  });

  testWidgets('mengetuk sebuah baris berarti masuk, dan tombolnya mengambil tempat kita berdiri',
      (tester) async {
    final h = await open(tester, [
      rootsOnly,
      pageAt('/op/kerja', entries: repoRow),
    ]);

    await tester.tap(find.text('kerja'));
    await tester.pumpAndSettle();

    expect(find.text('tkt'), findsOneWidget);
    expect(find.textContaining('GIT · MAIN'), findsOneWidget);
    // Labelnya mencetak path-nya, jadi tidak ada yang perlu diingat.
    expect(find.text('Use /op/kerja'), findsOneWidget);

    h.http.enqueue('{"id":"kerja","name":"kerja","path":"/op/kerja"}', status: 201);
    await tester.tap(find.byType(StartButton));
    await tester.pumpAndSettle();

    expect(h.http.last.uri.path, '/m/projects');
    expect(h.http.last.json, {'path': '/op/kerja'});
  });

  testWidgets('baris yang sudah jadi project tetap digambar, tapi tidak bisa dimasuki',
      (tester) async {
    final h = await open(tester, [
      rootsOnly,
      pageAt('/op/kerja', entries: '$repoRow,$takenRow'),
    ]);
    await tester.tap(find.text('kerja'));
    await tester.pumpAndSettle();

    // Digambar, bukan disembunyikan: daftar yang menyembunyikan apa yang ada di disk
    // membuat operator mencari sesuatu yang ia lihat lewat SSH lima menit lalu.
    expect(find.text('sudah'), findsOneWidget);
    expect(find.textContaining('ALREADY A PROJECT'), findsOneWidget);

    final before = h.http.sent.length;
    await tester.tap(find.text('sudah'));
    await tester.pumpAndSettle();
    expect(h.http.sent.length, before, reason: 'tidak ada permintaan baru: ia tidak bisa dimasuki');
  });

  testWidgets('di workspace root tombolnya mati, dan mengatakan alasannya', (tester) async {
    await open(tester, [
      pageAt('/op/ws', takeable: false, whyNot: '"workspace-root"'),
    ]);

    expect(tester.widget<StartButton>(find.byType(StartButton)).onStart, isNull);
    expect(find.textContaining('WORKSPACE ROOT'), findsOneWidget);
  });

  testWidgets('di root tidak ada jalan naik yang digambar', (tester) async {
    await open(tester, [pageAt('/op/kerja', entries: repoRow)]);

    expect(find.text('Up'), findsNothing);
  });

  testWidgets('satu folder dihitung tunggal, karena layar ini dibaca bukan dipindai',
      (tester) async {
    await open(tester, [
      pageAt('/op/kerja', entries:
          '{"name":"satu","path":"/op/kerja/satu","isRepo":false,"branch":null,"children":1,"isProject":false}'),
    ]);

    expect(find.textContaining('1 FOLDER ·'), findsOneWidget);
    expect(find.textContaining('1 FOLDERS'), findsNothing);
  });
}
