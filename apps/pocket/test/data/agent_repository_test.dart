import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/data/agent_repository.dart';
import 'package:lotus_pocket/data/output_buffer.dart';
import 'package:lotus_pocket/data/mutation_outcome.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_failure.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/hosts/paired_host.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';

import '../support/fake_security.dart';
import '../support/fake_transport.dart';

/// The layer that keeps policy out of widgets, tested the way a screen will use it:
/// one call in, one already-decided answer out. Nothing here throws.
const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

final Directory fixtures = Directory('../../contract/fixtures');
String fixture(String name) => File('${fixtures.path}/$name.json').readAsStringSync();

DateTime now = DateTime.utc(2026, 8, 5, 12);

PairedHost pairedHost(HostId id, {List<String>? features, String mode = 'client'}) => PairedHost(
      id: id,
      label: id.value,
      baseUri: Uri.parse('http://${id.value}:9877'),
      mode: mode,
      caps: HostCaps(
        protocol: 1,
        features: features ?? const ['fleet', 'dispatch', 'stop', 'transcript', 'permission', 'stt'],
      ),
    );

// Matches `DEVICE_TOKEN_TTL_MS` on the host. Must stay comfortably above
// `Credentials.refreshLead` (24h) or a "fresh" device in these tests would already
// read as due for refresh, and every dispatch test would need to script one.
PairedDevice pairedDevice(HostId id, {Duration ttl = const Duration(hours: 72)}) => PairedDevice(
      deviceToken: 'tok-${id.value}',
      deviceId: 'dev_a1',
      expiresAt: now.add(ttl),
      hardExpiresAt: now.add(const Duration(days: 30)),
      hostId: id,
      hostLabel: id.value,
      mode: 'client',
      caps: const HostCaps(protocol: 1, features: ['fleet']),
      baseUri: Uri.parse('http://${id.value}:9877'),
    );

void main() {
  late FakeHttpTransport http;
  late FakeBiometrics biometrics;
  late InMemorySecureStore secure;
  late Credentials credentials;
  late HostRegistry registry;
  late AgentRepository repository;
  late OutputBuffer output;
  late FakeTransport ws;

  setUp(() async {
    now = DateTime.utc(2026, 8, 5, 12);
    http = FakeHttpTransport();
    biometrics = FakeBiometrics();
    secure = InMemorySecureStore();
    credentials = Credentials(
      store: secure,
      now: () => now,
      gate: BiometricGate(biometrics),
    );
    ws = FakeTransport();
    registry = HostRegistry(
      transport: ws,
      httpTransport: http,
      tokenReader: credentials.tokenFor,
      sleep: (_) async {},
    );
    registry.add(pairedHost(mac));
    await credentials.remember(pairedDevice(mac));
    output = OutputBuffer(registry.events);
    repository = AgentRepository(
      registry: registry,
      credentials: credentials,
      gate: BiometricGate(biometrics),
      output: output,
    );
  });

  tearDown(() => registry.dispose());

  const ref = CellRef(mac, 'p-1');

  group('tailing a pane, and whose tail it is', () {
    const other = CellRef(mac, 'p-2');

    /// A live connection, because `subscribe` is a frame and a frame needs a channel.
    Future<void> connected() async {
      registry.connect(mac);
      await pumpEventQueue();
    }

    /// Panes the phone actually asked for, in order. `null` is a detach.
    List<Object?> subscribes() => ws.channels
        .expand((c) => c.sent)
        .where((f) => f['type'] == 'subscribe')
        .map((f) => f['paneId'])
        .toList();

    test('tailing points the buffer and tells the socket, in one step', () async {
      await connected();

      repository.tail(ref);

      expect(output.watching, ref);
      expect(subscribes(), ['p-1']);
    });

    test('stopping the tail you hold clears the buffer and detaches', () async {
      await connected();
      repository.tail(ref);

      repository.stopTailing(ref);

      expect(output.watching, isNull);
      expect(subscribes(), ['p-1', null]);
    });

    test('stopping a tail you do not hold changes nothing at all', () async {
      // The state the pager now creates on every swipe: page `i` has Terminal open on
      // `p-2` while page `i-2` falls out of the cache and disposes. Before this took a
      // `CellRef` it said only "stop tailing mac", and the page nobody could see
      // cancelled the subscription of the page that was on screen (`issues/12`, C3).
      await connected();
      repository.tail(other);

      repository.stopTailing(ref);

      expect(output.watching, other, reason: 'the terminal on screen keeps its bytes');
      expect(subscribes(), ['p-2'], reason: 'and nothing was detached');
    });
  });

  group('what Chat is built from', () {
    test('reads transcript and permission together', () async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));

      final view = await repository.load(ref);

      expect(view.chatAvailable, isTrue);
      expect(view.isFailed, isFalse);
      expect(view.transcript!.entries, isNotEmpty);
      expect(view.answerable, isTrue);
      // Both requests, not one after a wait for the other.
      expect(http.sent.map((r) => r.uri.path),
          containsAll(['/m/cell/p-1/transcript', '/m/cell/p-1/permission']));
    });

    test('asks git\'s view too, but only where the host advertises `result`', () async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'));

      final plain = await repository.load(ref);
      expect(plain.result, isNull);
      expect(http.sent.map((r) => r.uri.path), isNot(contains('/m/cell/p-1/result')));

      registry.add(pairedHost(vps,
          features: const ['fleet', 'dispatch', 'transcript', 'permission', 'result']));
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'))
        ..enqueue(fixture('rest-result'));

      final view = await repository.load(const CellRef(vps, 'p-1'));
      expect(view.result?.changes?.files, hasLength(4));
      expect(view.chatAvailable, isTrue);
    });

    test('a failed result read is a missing footnote, never a failed page', () async {
      registry.add(pairedHost(vps,
          features: const ['fleet', 'dispatch', 'transcript', 'permission', 'result']));
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue(fixture('rest-permission'))
        ..enqueue('{"error":"git exploded"}', status: 500);

      final view = await repository.load(const CellRef(vps, 'p-1'));
      expect(view.isFailed, isFalse);
      expect(view.result, isNull);
    });

    test('a diff is read, and a host that cannot answer gives null rather than throwing', () async {
      http.enqueue(fixture('rest-diff'));
      final diff = await repository.diff(ref, 'src/legacy/shim.ts');
      expect(diff?.diff, startsWith('diff --git'));
      expect(http.last.uri.queryParameters['file'], 'src/legacy/shim.ts');

      http.enqueue('{"error":"file must be a relative path inside the project"}', status: 400);
      expect(await repository.diff(ref, '../x'), isNull);
    });

    test('a host with no hook pipeline gets Terminal, not an empty Chat', () async {
      registry.add(pairedHost(vps, mode: 'standalone', features: const ['fleet', 'dispatch']));

      final view = await repository.load(const CellRef(vps, 'p-9'));

      // PLAN §7 no. 10: a VPS cannot know, and "nothing to do" would be a lie.
      expect(view.chatAvailable, isFalse);
      expect(view.isFailed, isFalse);
      expect(http.sent, isEmpty, reason: 'do not call routes the host does not advertise');
    });

    test('a desktop that records nothing is said so, not drawn as an empty Chat',
        () async {
      http
        ..enqueue(fixture('rest-transcript-unsupported'))
        ..enqueue(fixture('rest-permission-unsupported'));

      final view = await repository.load(ref);

      // The host advertises `transcript` and `permission`, so `hasChat` is true and the
      // routes were called — and then the host itself answered "I cannot know". A
      // desktop whose hooks never reach the agents it spawns says exactly this, and its
      // transcript is empty for every pane forever (measured 2026-08-09).
      expect(view.isFailed, isFalse);
      expect(view.chatAvailable, isFalse);
      expect(view.blocked, ChatBlocked.notRecording);
    });

    test('a runner that never reports steps is said so, not drawn as an empty Chat',
        () async {
      // Codex has no hook mechanism — its whole surface into Lotus is one
      // `agent-turn-complete` notify, so no prompt, no tool steps, no prose ever reach
      // the transcript ring. The host is healthy; this runner simply cannot report. Left
      // unsaid, the phone drew a blank Chat beside a working Terminal and the operator
      // had no way to tell which of the two was broken.
      http
        ..enqueue(fixture('rest-transcript-runner-silent'))
        ..enqueue(fixture('rest-permission'));

      final view = await repository.load(ref);

      expect(view.isFailed, isFalse);
      expect(view.chatAvailable, isFalse);
      expect(view.blocked, ChatBlocked.runnerSilent);
    });

    test('a pane the host cannot place says so, instead of an empty Chat that never fills',
        () async {
      // Measured on 2026-08-10: a desktop twelve minutes up, with the Canvas route
      // loaded, answered absent for every pane — including a Codex cell it had called
      // `runnerReports: false` minutes earlier. The pane→runner map is pushed by the
      // desktop UI, so it empties on restart, and absence on this wire is a promise.
      http
        ..enqueue(fixture('rest-transcript-outlook-unknown'))
        ..enqueue(fixture('rest-permission'));

      final view = await repository.load(ref);

      expect(view.isFailed, isFalse);
      expect(view.blocked, ChatBlocked.outlookUnknown);
      // Not `runnerSilent`: that sentence sends the operator away for good, and this
      // answer may still arrive on the next refresh.
      expect(view.blocked, isNot(ChatBlocked.runnerSilent));
    });

    test('a host that records nothing outranks a silent runner', () async {
      // Both are true at once on a misconfigured desktop running Codex. The host-wide
      // fault is the one worth naming: fixing it is what makes every other pane work.
      http
        ..enqueue('{"paneId":"p-1","total":0,"entries":[],'
            '"hostSupports":false,"runnerReports":false}')
        ..enqueue(fixture('rest-permission'));

      final view = await repository.load(ref);

      expect(view.blocked, ChatBlocked.notRecording);
    });

    test('an empty transcript from a working host is not blocked', () async {
      http
        ..enqueue('{"paneId":"p-1","total":0,"entries":[]}')
        ..enqueue(fixture('rest-permission'));

      final view = await repository.load(ref);

      // Absent means supported. A pane that has recorded nothing yet — the normal state
      // after a desktop restart, since the ring lives in memory — must keep its Chat.
      expect(view.chatAvailable, isTrue);
      expect(view.blocked, isNull);
      expect(view.transcript!.entries, isEmpty);
    });

    test('a waiting cell whose options could not be read is not answerable', () async {
      http
        ..enqueue(fixture('rest-transcript'))
        ..enqueue('{"paneId":"p-1","awaiting":true,"prompt":null}');

      final view = await repository.load(ref);

      // Waiting, but the digits are unknown. Buttons here would answer a question the
      // operator was never shown (ADR-8).
      expect(view.permission!.awaiting, isTrue);
      expect(view.answerable, isFalse);
    });

    test('an unreachable host names the cause instead of throwing', () async {
      http.failWith =
          const TransportUnavailable('asleep', cause: TransportCause.timedOut);

      final view = await repository.load(ref);

      // A widget renders this. It never sees an exception, which is the point.
      expect(view.isFailed, isTrue);
      expect(view.failure, isA<HostAsleep>());
    });

    test('a 401 on a read is diagnosed once, by the layer that owns the clock', () async {
      http
        ..enqueue('{"error":"Unauthorized"}', status: 401)
        ..enqueue('{"error":"Unauthorized"}', status: 401);

      final view = await repository.load(ref);

      // Token still inside its TTL, so this is a revoke rather than an expiry — the
      // distinction `HostRegistry` makes, read back rather than repeated here.
      expect(view.failure, isA<CredentialRevoked>());
      expect(registry.statusOf(mac)!.failure, isA<CredentialRevoked>());
    });

    test('a 200 that is JSON but missing required fields is named, not a crash', () async {
      // A proxy answering `{}`, or a host that broke the contract. `HostApi` guards a body
      // that is not JSON at all; a hand-written `fromJson` still throws on an absent
      // field, and that reached a widget as a crash before this branch existed.
      http
        ..enqueue('{}')
        ..enqueue('{}');

      final view = await repository.load(ref);

      expect(view.isFailed, isTrue);
      expect(view.failure, isA<HostUnknownFailure>());
    });

    test('a cell on a host that was never paired fails without a request', () async {
      final view = await repository.load(const CellRef(vps, 'p-1'));

      expect(view.failure, isA<HostUnknownFailure>());
      expect(http.sent, isEmpty);
    });
  });

  group('every mutation passes the gate', () {
    test('a dispatch asks for proof, then sends', () async {
      final outcome = await repository.dispatch(ref, 'run the tests', reason: 'Dispatch to Atlas');

      expect(outcome, isA<MutationSent>());
      expect(biometrics.reasons.single, 'Dispatch to Atlas');
      expect(http.last.uri.path, '/m/cell/p-1/dispatch');
      expect(http.last.json, {'text': 'run the tests'});
    });

    test('refused proof sends nothing at all', () async {
      biometrics.answer = false;

      final outcome = await repository.dispatch(ref, 'rm -rf', reason: 'Dispatch to Atlas');

      expect(outcome, isA<MutationRefused>());
      // The assertion that matters: the request was never made, not merely ignored.
      expect(http.sent, isEmpty);
    });

    test('stop is gated too — the loosest mutation, not an ungated one', () async {
      final outcome = await repository.stop(ref, reason: 'Stop Atlas');

      expect(outcome, isA<MutationSent>());
      expect(biometrics.prompts, 1);
      expect(http.last.uri.path, '/m/cell/p-1/stop');
    });

    test('starting an agent is gated, and names the host rather than a cell', () async {
      http.enqueue('{"paneId":"p-new"}');

      final outcome = await repository.spawn(
        host: mac,
        provider: 'claude',
        workspaceId: 'ws-1',
        permissionMode: 'manual',
        reason: 'Start a claude agent that asks first',
      );

      expect(outcome, isA<MutationSent>());
      expect(biometrics.prompts, 1);
      expect(http.last.uri.path, '/m/cells');
    });

    test('a 503 from spawn is the window not being on a board, not a refusal', () async {
      http.enqueue('{"error":"HTTP 503: no active Lotus workspace UI"}', status: 503);

      final outcome = await repository.spawn(
        host: mac,
        provider: 'codex',
        reason: 'Start a codex agent',
      );

      // Measured on a real phone (2026-08-27): the desktop answers this while its window
      // is still on the start page. It is a state the operator can fix on that machine,
      // so it must not be lumped with a 500.
      expect(outcome, isA<MutationHostNotReady>());
    });

    test('a refused check starts nothing', () async {
      biometrics.answer = false;

      final outcome = await repository.spawn(
        host: mac,
        provider: 'claude',
        reason: 'Start a claude agent',
      );

      expect(outcome, isA<MutationRefused>());
      expect(http.sent, isEmpty);
    });

    test('close is gated exactly like the rest, and reaches the pane by DELETE', () async {
      final outcome = await repository.close(ref, reason: 'Close Atlas');

      expect(outcome, isA<MutationSent>());
      // One prompt, not two. Ending a cell is the irreversible one, and the weight it
      // deserves is a confirmation in the UI — a second gate here would be the same
      // question asked twice in one gesture, which is how a gate stops being one.
      expect(biometrics.prompts, 1);
      expect(http.last.method, 'DELETE');
      expect(http.last.uri.path, '/m/cell/p-1');
    });

    test('a refused check ends no cell', () async {
      biometrics.answer = false;

      final outcome = await repository.close(ref, reason: 'Close Atlas');

      expect(outcome, isA<MutationRefused>());
      expect(http.sent, isEmpty);
    });

    test('a device with no lock still acts, because locking the operator out is worse',
        () async {
      biometrics.hasLock = false;

      final outcome = await repository.dispatch(ref, 'go', reason: 'Dispatch to Atlas');

      // ADR-12 no. 4's named exception, reaching all the way through.
      expect(outcome, isA<MutationSent>());
      expect(biometrics.prompts, 0);
    });

    test('a plugin that cannot answer refuses the mutation', () async {
      biometrics.failCanPrompt = Exception('no platform channel');

      final outcome = await repository.dispatch(ref, 'go', reason: 'Dispatch to Atlas');

      expect(outcome, isA<MutationRefused>());
      expect(http.sent, isEmpty);
    });
  });

  group('one gesture, one prompt', () {
    test('a due refresh is the mutation\'s proof, so the operator is asked once',
        () async {
      now = now.add(const Duration(hours: 71, minutes: 30));
      http.enqueue(jsonEncode({
        'deviceToken': 'tok-fresh',
        'expiresAt': now.add(const Duration(hours: 72)).millisecondsSinceEpoch,
      }));

      final outcome = await repository.dispatch(ref, 'go', reason: 'Dispatch to Atlas');

      expect(outcome, isA<MutationSent>());
      // Both rules — refresh needs proof, every mutation needs proof — satisfied by one
      // prompt in one gesture. Two prompts per tap trains the operator to tap through.
      expect(biometrics.prompts, 1);
      expect(credentials.tokenFor(mac), 'tok-fresh');
      // And the dispatch carried the *new* bearer, not the one it started with.
      expect(http.last.bearer, 'Bearer tok-fresh');
    });

    test('declining the refresh prompt does not fall through to sending', () async {
      now = now.add(const Duration(hours: 71, minutes: 30));
      biometrics.answer = false;

      final outcome = await repository.dispatch(ref, 'go', reason: 'Dispatch to Atlas');

      expect(outcome, isA<MutationRefused>());
      expect(http.sent, isEmpty);
    });

    test('a credential past the ceiling asks for a new pairing, not a fingerprint',
        () async {
      now = now.add(const Duration(days: 31));

      final outcome = await repository.dispatch(ref, 'go', reason: 'Dispatch to Atlas');

      expect(outcome, isA<MutationNeedsPairing>());
      expect(biometrics.prompts, 0, reason: 'nothing a fingerprint can fix');
      expect(http.sent, isEmpty);
    });
  });

  group('what the host answered, as something a screen can render', () {
    test('a stop on a dead pane is a named state, not an error', () async {
      http.enqueue('{"error":"No live session for pane p-1"}', status: 404);

      final outcome = await repository.stop(ref, reason: 'Stop Atlas');

      expect(outcome, isA<MutationNoLiveSession>());
      expect((outcome as MutationNoLiveSession).paneId, 'p-1');
    });

    test('a 400 carries the host\'s own words, not friendlier copy', () async {
      http.enqueue('{"error":"text is required"}', status: 400);

      final outcome = await repository.dispatch(ref, ' ', reason: 'Dispatch to Atlas');

      expect(outcome, isA<MutationRejected>());
      expect((outcome as MutationRejected).reason, 'text is required');
    });

    test('a sleeping host is unreachable with the cause already named', () async {
      http.failWith = const TransportUnavailable('silent', cause: TransportCause.timedOut);

      final outcome = await repository.dispatch(ref, 'go', reason: 'Dispatch to Atlas');

      expect(outcome, isA<MutationUnreachable>());
      expect((outcome as MutationUnreachable).failure, isA<HostAsleep>());
    });

    test('a refused connection is Lotus not running, and says so', () async {
      http.failWith = const TransportUnavailable('refused', cause: TransportCause.refused);

      final outcome = await repository.stop(ref, reason: 'Stop Atlas');

      expect((outcome as MutationUnreachable).failure, isA<LotusNotRunning>());
    });

    test('a 401 mid-mutation asks for pairing and carries the diagnosis', () async {
      http.enqueue('{"error":"Unauthorized"}', status: 401);

      final outcome = await repository.dispatch(ref, 'go', reason: 'Dispatch to Atlas');

      expect(outcome, isA<MutationNeedsPairing>());
      expect((outcome as MutationNeedsPairing).cause, isA<CredentialRevoked>());
    });

    test('a cell on an unpaired host cannot be mutated', () async {
      final outcome = await repository.dispatch(
        const CellRef(vps, 'p-1'),
        'go',
        reason: 'Dispatch',
      );

      expect(outcome, isA<MutationUnknownHost>());
      expect(biometrics.prompts, 0);
    });
  });

  group('dictation', () {
    test('goes to the host when it holds a provider key', () async {
      http.enqueue(fixture('rest-stt'));

      final result = await repository.transcribe(mac, audioBase64: 'AAAA', mime: 'audio/m4a');

      expect(result.transcribedHere, isTrue);
      expect(result.provider, 'openai');
      // Not gated: the dispatch that follows is the mutation that gets the prompt.
      expect(biometrics.prompts, 0);
    });

    test('a host without stt answers the fork itself, with no round trip', () async {
      registry.add(pairedHost(vps, features: const ['fleet', 'dispatch']));

      final result = await repository.transcribe(vps, audioBase64: 'AAAA', mime: 'audio/m4a');

      // Same shape the host would have answered, so the caller has one path back to
      // the device recogniser (ADR-11).
      expect(result.hostSupports, isFalse);
      expect(result.transcribedHere, isFalse);
      expect(http.sent, isEmpty);
    });
  });
}
