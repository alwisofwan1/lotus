import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/mutation_outcome.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../support/agent_harness.dart';

const HostId mac = HostId('mac');

/// Menambah project adalah mutasi, jadi ia lewat gerbang yang sama seperti memulai agen
/// — `HostGate`, ADR-8 dan ADR-12 no. 2. `plans/pocket-vps-project-checkout/issues/04`.
void main() {
  test('clone yang diterima mengembalikan job-nya, dan meminta bukti kehadiran lebih dulu',
      () async {
    final h = await AgentHarness.paired(hosts: const [mac]);
    h.http.enqueue('''
      {"taskId":"clone_1","state":"running","step":"cloning",
       "name":"tkt-worker","path":"/home/op/lotus-workspaces/tkt-worker"}
    ''');

    final started = await h.projects.startClone(
      mac,
      url: 'https://github.com/alwi/tkt-worker.git',
      branch: 'main',
    );

    expect(started.outcome, isA<MutationSent>());
    expect(started.job!.taskId, 'clone_1');
    expect(h.biometrics.prompts, 1, reason: 'gerbangnya harus ditanyakan');

    final request = h.http.last;
    expect(request.method, 'POST');
    expect(request.uri.path, '/m/projects/clone');
    expect(request.json, {
      'url': 'https://github.com/alwi/tkt-worker.git',
      'branch': 'main',
    });
  });

  test('gerbang yang ditolak tidak pernah mengirim apa pun', () async {
    final h = await AgentHarness.paired(hosts: const [mac]);
    h.biometrics.answer = false;

    final started = await h.projects.startClone(mac, url: 'x');

    expect(started.outcome, isA<MutationRefused>());
    expect(started.job, isNull);
    expect(h.http.sent, isEmpty);
  });

  test('nama folder yang ditolak host sampai ke layar sebagai penolakan, bukan kegagalan',
      () async {
    final h = await AgentHarness.paired(hosts: const [mac]);
    h.http.enqueue('{"error":"Cannot use \\".hidden\\" as a project folder"}', status: 400);

    final started = await h.projects.startClone(mac, url: 'x', name: '.hidden');

    expect(started.outcome, isA<MutationRejected>());
    expect((started.outcome as MutationRejected).reason, contains('.hidden'));
  });

  test('status dibaca tanpa gerbang — ia pembacaan, bukan mutasi', () async {
    final h = await AgentHarness.paired(hosts: const [mac]);
    h.biometrics.prompts = 0;
    h.http.enqueue('''
      {"taskId":"clone_1","state":"done","step":"registering",
       "name":"tkt-worker","path":"/home/op/lotus-workspaces/tkt-worker"}
    ''');

    final job = await h.projects.cloneStatus(mac, 'clone_1');

    expect(job!.isDone, isTrue);
    expect(h.biometrics.prompts, 0);
    expect(h.http.last.uri.path, '/m/projects/clone/clone_1');
  });

  test('menjelajah adalah pembacaan: tanpa gerbang, dan path-nya masuk ke query', () async {
    final h = await AgentHarness.paired(hosts: const [mac]);
    h.biometrics.prompts = 0;
    h.http.enqueue('''
      {"roots":[{"name":"kerja","path":"/home/op/kerja"}],
       "page":{"path":"/home/op/kerja","parent":null,
               "entries":[{"name":"tkt","path":"/home/op/kerja/tkt",
                           "isRepo":true,"branch":"main","children":9}]}}
    ''');

    final page = await h.projects.browse(mac, '/home/op/kerja');

    expect(page!.isAtRoot, isTrue);
    expect(page.entries.single.branch, 'main');
    expect(h.biometrics.prompts, 0);
    expect(h.http.last.uri.path, '/m/fs');
    expect(h.http.last.uri.queryParameters['path'], '/home/op/kerja');
  });

  test('mengambil folder adalah mutasi: gerbangnya ditanyakan lebih dulu', () async {
    final h = await AgentHarness.paired(hosts: const [mac]);
    h.http.enqueue('{"id":"tkt","name":"tkt","path":"/home/op/kerja/tkt"}', status: 201);

    final outcome = await h.projects.takeFolder(mac, '/home/op/kerja/tkt');

    expect(outcome, isA<MutationSent>());
    expect(h.biometrics.prompts, 1);
    expect(h.http.last.method, 'POST');
    expect(h.http.last.uri.path, '/m/projects');
    expect(h.http.last.json, {'path': '/home/op/kerja/tkt'});
  });

  test('tembok host sampai ke layar sebagai penolakan, bukan kegagalan', () async {
    final h = await AgentHarness.paired(hosts: const [mac]);
    h.http.enqueue('{"error":"/etc is not inside an allowed root"}', status: 403);

    final outcome = await h.projects.takeFolder(mac, '/etc');

    expect(outcome, isA<MutationRejected>());
  });
}
