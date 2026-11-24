import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/projects/clone_flow.dart';
import 'package:lotus_pocket/features/projects/clone_form.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../../support/agent_harness.dart';

const HostId mac = HostId('mac');
const String running = '''
  {"taskId":"clone_1","state":"running","step":"cloning",
   "name":"tkt-worker","path":"/home/op/lotus-workspaces/tkt-worker"}
''';

/// Layar 08 dan 09 di `plans/pocket-vps-project-checkout/design/add-project.html`.
void main() {
  Future<void> run(WidgetTester tester, AgentHarness h, {required List<String> arrived}) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () => startCloneAndWatch(
            context,
            projects: h.projects,
            host: mac,
            machine: 'vps',
            ask: const CloneAsk(url: 'https://github.com/alwi/tkt-worker.git'),
            onArrived: () async => arrived.add('read again'),
            poll: const Duration(milliseconds: 10),
          ),
          child: const Text('go'),
        ),
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pump();
    await tester.pump();
  }

  testWidgets('menunggu, lalu menutup dirinya dan menyuruh indeks membaca ulang',
      (tester) async {
    final h = await AgentHarness.paired(hosts: const [mac]);
    final arrived = <String>[];
    h.http
      ..enqueue(running)
      ..enqueue(running)
      ..enqueue('''
        {"taskId":"clone_1","state":"done","step":"registering",
         "name":"tkt-worker","path":"/home/op/lotus-workspaces/tkt-worker"}
      ''');

    await run(tester, h, arrived: arrived);

    // Fakta terbesar di layar adalah "di mana" — aturan `StartingScreen` melawan R-10.
    expect(find.text('/home/op/lotus-workspaces/tkt-worker'), findsOneWidget);
    expect(find.text('LEAVING DOES NOT STOP IT'), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 12));
    await tester.pumpAndSettle();

    expect(find.text('LEAVING DOES NOT STOP IT'), findsNothing, reason: 'ia menutup dirinya');
    expect(arrived, ['read again']);
  });

  testWidgets('gagal: kata-kata git dicetak apa adanya, dan tidak ada yang tertulis',
      (tester) async {
    final h = await AgentHarness.paired(hosts: const [mac]);
    h.http
      ..enqueue(running)
      ..enqueue('''
        {"taskId":"clone_1","state":"failed","step":"cloning",
         "name":"tkt-worker","path":"/home/op/lotus-workspaces/tkt-worker",
         "error":"fatal: repository not found\\n\\ngh auth status -> not logged in"}
      ''');

    await run(tester, h, arrived: <String>[]);
    await tester.pump(const Duration(milliseconds: 12));
    await tester.pumpAndSettle();

    expect(find.text('Clone failed'), findsOneWidget);
    expect(find.textContaining('repository not found'), findsOneWidget);
    expect(find.textContaining('not logged in'), findsOneWidget);
    expect(find.text('NOTHING WAS WRITTEN'), findsOneWidget);
  });

  testWidgets('gagal tidak menyuruh indeks membaca ulang — tidak ada yang datang',
      (tester) async {
    // Penyegaran adalah satu `GET /m/bootstrap` ke setiap mesin. Melakukannya untuk
    // sesuatu yang tidak mendarat membuat gestur itu berarti lebih sedikit, dan pada
    // HP di jaringan seluler ia tidak gratis.
    final h = await AgentHarness.paired(hosts: const [mac]);
    final arrived = <String>[];
    h.http
      ..enqueue(running)
      ..enqueue('''
        {"taskId":"clone_1","state":"failed","step":"cloning",
         "name":"tkt-worker","path":"/home/op/lotus-workspaces/tkt-worker",
         "error":"fatal: repository not found"}
      ''');

    await run(tester, h, arrived: arrived);
    await tester.pump(const Duration(milliseconds: 12));
    await tester.pumpAndSettle();

    expect(find.text('Clone failed'), findsOneWidget);
    expect(arrived, isEmpty);
  });

  testWidgets('pergi lebih awal bukan kedatangan', (tester) async {
    // Clone-nya tetap berjalan — layar ini tidak pernah menghentikannya. Tapi HP tidak
    // tahu apakah ia selesai, jadi ia tidak mengklaim apa pun.
    final h = await AgentHarness.paired(hosts: const [mac]);
    final arrived = <String>[];
    h.http
      ..enqueue(running)
      ..enqueue(running);

    await run(tester, h, arrived: arrived);
    await tester.tap(find.text('BACK'));
    await tester.pumpAndSettle();

    expect(arrived, isEmpty);
  });
}
