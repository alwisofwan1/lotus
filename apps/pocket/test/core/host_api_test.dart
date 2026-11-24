import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/api_failure.dart';
import 'package:lotus_pocket/core/host_api.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../support/fake_transport.dart';

/// The REST half of ADR-10, driven by the same files `packages/host` proves it
/// produces. Nine fixtures existed before this suite and none of them had ever
/// exercised an HTTP call — only a bare `fromJson`. Here the route, the bearer, the
/// body and the parse are checked together, which is where a client actually breaks.
final Directory fixtures = Directory('../../contract/fixtures');

String fixture(String name) => File('${fixtures.path}/$name.json').readAsStringSync();

const HostId onMac = HostId('mac');
final Uri hostUri = Uri.parse('http://mac.tail-scale.ts.net:9877');

void main() {
  late FakeHttpTransport transport;
  late HostApi api;
  var token = 'tok-1';

  setUp(() {
    token = 'tok-1';
    transport = FakeHttpTransport();
    api = HostApi(
      host: onMac,
      baseUri: hostUri,
      token: () => token,
      transport: transport,
    );
  });

  test('the contract directory is where we think it is', () {
    expect(fixtures.existsSync(), isTrue,
        reason: 'run from apps/pocket; fixtures live at repo-root contract/fixtures');
  });

  group('pairing — the only route without a bearer', () {
    test('exchanges a code for a credential and the host it belongs to', () async {
      transport.enqueue(fixture('rest-pair'));

      final device = await HostApi.pair(
        transport: transport,
        baseUri: hostUri,
        pairingCode: '12345678',
        deviceName: 'Pixel 8',
      );

      expect(transport.last.method, 'POST');
      expect(transport.last.uri.path, '/m/pair');
      expect(transport.last.json, {'pairingCode': '12345678', 'deviceName': 'Pixel 8'});
      expect(device.hostId, onMac);
      expect(device.hostLabel, 'MacBook');
      expect(device.mode, 'client');
      expect(device.caps.supports('stt'), isTrue);
    });

    test('sends no Authorization header, because there is nothing to send yet', () async {
      transport.enqueue(fixture('rest-pair'));

      await HostApi.pair(
        transport: transport,
        baseUri: hostUri,
        pairingCode: '12345678',
        deviceName: 'Pixel 8',
      );

      expect(transport.last.bearer, isNull);
    });

    test('a bad code is a rejected pairing, not an expired session', () async {
      transport.enqueue('{"error":"Pairing code is invalid or expired"}', status: 401);

      // 401 here cannot mean "refresh the token" — there is no token. Reusing the
      // generic unauthorized failure would send the app down a recovery path that
      // does not exist at this point in onboarding.
      await expectLater(
        HostApi.pair(
          transport: transport,
          baseUri: hostUri,
          pairingCode: '00000000',
          deviceName: 'Pixel 8',
        ),
        throwsA(isA<PairingRejected>()),
      );
    });
  });

  group('bootstrap — one round trip per host on a cold start', () {
    test('valid JSON of the wrong shape is a HostFaulted, not a TypeError', () async {
      transport.enqueue('{"hostId":"mac","cells":"nope"}');

      expect(api.bootstrap(), throwsA(isA<HostFaulted>()));
    });

    test('parses cells, workspaces and caps, and stamps cells with the host', () async {
      transport.enqueue(fixture('rest-bootstrap'));

      final boot = await api.bootstrap(workspaceId: 'ws-lotus');

      expect(transport.last.method, 'GET');
      expect(transport.last.uri.path, '/m/bootstrap');
      expect(transport.last.uri.queryParameters['workspaceId'], 'ws-lotus');
      expect(transport.last.bearer, 'Bearer tok-1');
      expect(boot.cells, hasLength(2));
      expect(boot.workspaces.single.workspaceId, 'ws-lotus');
      expect(boot.caps.protocol, 1);
      // R-10: a cell that did not know its host could be dispatched to the wrong
      // machine. The payload carries no `hostId` per cell — the client stamps it.
      expect(boot.cells.every((c) => c.host == onMac), isTrue);
    });

    test('an address that answers as a different host is refused, not merged', () async {
      final payload = jsonDecode(fixture('rest-bootstrap')) as Map<String, Object?>;
      transport.enqueue(jsonEncode({...payload, 'hostId': 'vps'}));

      // A tailnet name that has come to point at another machine would otherwise file
      // that machine's cells under `mac` — a host `HostRegistry` holds no socket for.
      await expectLater(
        api.bootstrap(),
        throwsA(isA<HostFaulted>()
            .having((e) => e.reason, 'reason', contains('answers as vps'))),
      );
    });

    test('omits the query entirely when no project is named', () async {
      transport.enqueue(fixture('rest-bootstrap'));

      await api.bootstrap();

      expect(transport.last.uri.queryParameters, isEmpty);
    });

    test('reads the token per request, so a mid-session refresh is picked up', () async {
      transport.enqueue(fixture('rest-bootstrap'));
      await api.bootstrap();
      expect(transport.sent.first.bearer, 'Bearer tok-1');

      // The 12-hour TTL can be refreshed while the app runs (ADR-12 no. 2). A client
      // holding the string it read at construction would 401 on every later call.
      token = 'tok-2';
      transport.enqueue(fixture('rest-bootstrap'));
      await api.bootstrap();

      expect(transport.sent.last.bearer, 'Bearer tok-2');
    });
  });

  group('result and diff — what the agent left behind', () {
    test('result reads git\'s view of the pane\'s directory', () async {
      transport.enqueue(fixture('rest-result'));

      final result = await api.result('p-1');

      expect(transport.last.uri.path, '/m/cell/p-1/result');
      expect(result.changes?.files, hasLength(4));
    });

    test('diff names the file in the query, encoded, and keeps the cap flag', () async {
      transport.enqueue(fixture('rest-diff'));

      final diff = await api.diff('p-1', 'src/legacy/shim.ts');

      expect(transport.last.uri.path, '/m/cell/p-1/diff');
      expect(transport.last.uri.queryParameters['file'], 'src/legacy/shim.ts');
      expect(diff.truncated, isFalse);
    });
  });

  group('transcript and permission — the two Chat reads', () {
    test('a transcript arrives oldest first, with diffs absent rather than zero', () async {
      transport.enqueue(fixture('rest-transcript'));

      final snapshot = await api.transcript('p-1');

      expect(transport.last.uri.path, '/m/cell/p-1/transcript');
      expect(snapshot.hostSupports, isTrue);
      expect(snapshot.entries, isNotEmpty);
      // "Changed nothing" and "no diff here" are different claims: a Read step must
      // not render `+0 −0`, so at least one entry carries null counts.
      expect(snapshot.entries.any((e) => e.linesAdded == null), isTrue);
    });

    test('a host with no hook pipeline says so instead of claiming an empty cell', () async {
      transport.enqueue(fixture('rest-transcript-unsupported'));

      final snapshot = await api.transcript('p-1');

      expect(snapshot.hostSupports, isFalse);
      expect(snapshot.entries, isEmpty);
    });

    test('a permission prompt is answerable only when both signals agree', () async {
      transport.enqueue(fixture('rest-permission'));

      final snapshot = await api.permission('p-1');

      expect(transport.last.uri.path, '/m/cell/p-1/permission');
      expect(snapshot.answerable, isTrue);
      // Answered by the printed digit, never by position (ADR-8).
      expect(snapshot.prompt!.options.map((o) => o.key), ['1', '2', '3']);
      expect(snapshot.readback, isNotNull);
    });

    test('a VPS answers "not knowable here", which is not "nothing to do"', () async {
      transport.enqueue(fixture('rest-permission-unsupported'));

      final snapshot = await api.permission('p-1');

      expect(snapshot.hostSupports, isFalse);
      expect(snapshot.awaiting, isFalse);
      // The whole point of the field: `awaiting: false` with `hostSupports: false`
      // must never draw buttons and must never render as a settled cell.
      expect(snapshot.answerable, isFalse);
      expect(snapshot.readback, isNull);
    });
  });

  group('mutations', () {
    test('dispatch posts the text and nothing else', () async {
      await api.dispatch('p-1', 'run the tests');

      expect(transport.last.method, 'POST');
      expect(transport.last.uri.path, '/m/cell/p-1/dispatch');
      expect(transport.last.json, {'text': 'run the tests'});
      expect(transport.last.headers['Content-Type'], 'application/json');
    });

    test('stop needs no body — the host knows what interrupting means', () async {
      await api.stop('p-1');

      expect(transport.last.method, 'POST');
      expect(transport.last.uri.path, '/m/cell/p-1/stop');
    });

    test('stop on a cell with no live session is a named state, not a fault', () async {
      transport.enqueue('{"error":"No live session for pane p-9"}', status: 404);

      // This is the VPS bug `plans/lotus-pocket` found by measuring: `stop` 404s when
      // no `sessionId` is set. The operator needs "that cell is gone", not "error".
      await expectLater(api.stop('p-9'), throwsA(isA<NoLiveSession>()));
    });

    test('starting a cell posts the runner, the brief and the posture', () async {
      transport.enqueue('{"paneId":"p-new","provider":"claude"}');

      final spawned = await api.spawnCell(
        provider: 'claude',
        workspaceId: 'ws-1',
        initialPrompt: 'run the suite',
        permissionMode: 'manual',
      );

      expect(transport.last.method, 'POST');
      expect(transport.last.uri.path, '/m/cells');
      expect(transport.last.json, {
        'provider': 'claude',
        'workspaceId': 'ws-1',
        'initialPrompt': 'run the suite',
        'permissionMode': 'manual',
      });
      expect(spawned.paneId, 'p-new');
    });

    test('a model and effort the operator chose ride along; unchosen ones are absent', () async {
      transport.enqueue('{"paneId":"p-new"}');

      await api.spawnCell(provider: 'codex', model: 'gpt-5.4-codex', effort: 'xhigh');
      expect(transport.last.json, {
        'provider': 'codex',
        'model': 'gpt-5.4-codex',
        'effort': 'xhigh',
      });

      transport.enqueue('{"paneId":"p-new"}');
      await api.spawnCell(provider: 'claude', model: 'opus');
      // Same rule as the posture: the resting choice is *absent*, so a host default that
      // moves later is still what the CLI picks.
      expect(transport.last.json, {'provider': 'claude', 'model': 'opus'});
    });

    test('a chosen account rides along as profileId (issues/07)', () async {
      transport.enqueue('{"paneId":"p-new"}');
      await api.spawnCell(provider: 'claude', profileId: 'hss');
      expect(transport.last.json, {'provider': 'claude', 'profileId': 'hss'});
    });

    test('a posture nobody chose is absent, not null', () async {
      transport.enqueue('{"paneId":"p-new"}');

      await api.spawnCell(provider: 'codex');

      // An absent field means *keep the runner's default*, which is what the host and
      // the desktop both read it as. Sending `null` would be this app saying something
      // it did not mean about the one property a cell cannot change later.
      expect(transport.last.json, {'provider': 'codex'});
    });

    test('closing a cell is a DELETE on the pane itself, with no body', () async {
      await api.closeCell('p-1');

      expect(transport.last.method, 'DELETE');
      expect(transport.last.uri.path, '/m/cell/p-1');
    });

    test('closing a cell that is already gone is a named state, not a fault', () async {
      transport.enqueue('{"error":"No such pane p-9"}', status: 404);

      // The outcome asked for has already happened. What the operator needs is "the
      // list you are looking at is stale", which is a different sentence from "that
      // failed" — the same distinction `stop` draws directly above.
      await expectLater(api.closeCell('p-9'), throwsA(isA<NoLiveSession>()));
    });

    test('a pane id is encoded, so it cannot forge a path', () async {
      await api.dispatch('p 1/../devices', 'x');

      expect(transport.last.uri.pathSegments,
          ['m', 'cell', 'p 1/../devices', 'dispatch']);
      expect(transport.last.uri.path, '/m/cell/p%201%2F..%2Fdevices/dispatch');
    });
  });

  group('pane size — the phone holds it while Terminal is open (v4 tiket 11)', () {
    test('a first hold sends the size and no token; a renewal sends the token', () async {
      transport.enqueue('{"held":true,"token":7}');
      final first = await api.holdSize('p-1', cols: 54, rows: 30);
      expect(transport.last.uri.path, '/m/cell/p-1/size');
      expect(transport.last.json, {'cols': 54, 'rows': 30});
      expect((first.held, first.token), (true, 7));

      transport.enqueue('{"held":false}');
      final renewed = await api.holdSize('p-1', cols: 54, rows: 30, token: 7);
      expect(transport.last.json, {'cols': 54, 'rows': 30, 'token': 7});
      expect((renewed.held, renewed.token), (false, null));
    });

    test('a release names the lease it gives back', () async {
      await api.releaseSize('p-1', 7);
      expect(transport.last.uri.path, '/m/cell/p-1/size/release');
      expect(transport.last.json, {'token': 7});
    });
  });

  group('dictation — the phone records, the host holds the key', () {
    test('sends audio and gets back a provider id, never a key', () async {
      transport.enqueue(fixture('rest-stt'));

      final result = await api.transcribe(audioBase64: 'AAAA', mime: 'audio/m4a');

      expect(transport.last.uri.path, '/m/stt');
      expect(transport.last.json, {'audioBase64': 'AAAA', 'mime': 'audio/m4a'});
      expect(result.transcribedHere, isTrue);
      expect(result.text, 'delete the legacy shim');
      expect(result.provider, 'openai');
    });

    test('an optional prompt is included only when given', () async {
      transport.enqueue(fixture('rest-stt'));

      await api.transcribe(audioBase64: 'AAAA', mime: 'audio/m4a', prompt: 'lotus jargon');

      expect(transport.last.json['prompt'], 'lotus jargon');
    });

    test('a host that transcribes on the device is a fork, not a failure', () async {
      transport.enqueue(fixture('rest-stt-unsupported'));

      final result = await api.transcribe(audioBase64: 'AAAA', mime: 'audio/m4a');

      expect(result.hostSupports, isFalse);
      expect(result.transcribedHere, isFalse);
      // The caller records again with the platform recogniser. A thrown exception
      // here would turn a fork in the road into an error dialog.
      expect(result.text, isNull);
    });

    test('audio past the 8 MiB cap is refused here, not after a cellular upload',
        () async {
      final tooBig = 'A' * (HostApi.sttMaxBodyBytes + 1);

      await expectLater(
        api.transcribe(audioBase64: tooBig, mime: 'audio/m4a'),
        throwsA(isA<HostRejected>()),
      );
      expect(transport.sent, isEmpty);
    });
  });

  group('credential lifecycle', () {
    test('a renewal asks for a nonce, then trades the signature — with no bearer', () async {
      transport
        ..enqueue(fixture('rest-devices-renew-challenge'))
        ..enqueue(fixture('rest-devices-renew'));

      final nonce = await api.renewalChallenge('dev_1');
      final renewed = await api.renew(deviceId: 'dev_1', nonce: nonce, signature: 'c2ln');

      expect(transport.sent.map((r) => r.uri.path),
          ['/m/devices/renew/challenge', '/m/devices/renew']);
      expect(transport.sent.map((r) => r.bearer), everyElement(isNull));
      expect(transport.last.json, {'deviceId': 'dev_1', 'nonce': nonce, 'signature': 'c2ln'});
      expect(renewed.hardExpiresAt.isAfter(renewed.expiresAt), isTrue);
      expect(renewalPayload('dev_1', 'n'), 'lotus-renew/v1\ndev_1\nn');
    });

    test('a refused renewal means re-pair', () async {
      transport.enqueue('{"error":"Renewal refused; pair again"}', status: 401);

      await expectLater(api.renewalChallenge('dev_1'), throwsA(isA<RenewalRefused>()));
    });

    test('a refresh returns a new token and a new expiry, not a new ceiling', () async {
      transport.enqueue(fixture('rest-devices-refresh'));

      final refreshed = await api.refreshToken();

      expect(transport.last.method, 'POST');
      expect(transport.last.uri.path, '/m/devices/refresh');
      expect(refreshed.deviceToken, isNotEmpty);
      expect(refreshed.expiresAt.millisecondsSinceEpoch, 1785924000000);
    });

    test('a refusal to refresh means re-pair, and is not the generic 401', () async {
      transport.enqueue('{"error":"Token can no longer be refreshed"}', status: 401);

      // The host rejects a refresh for a token already past its TTL exactly as it
      // rejects one past the 30-day ceiling (`device-store.ts`). Either way the only
      // way back in is a fresh pairing code — so this cannot be a "retry with
      // biometrics" failure.
      await expectLater(api.refreshToken(), throwsA(isA<RefreshRefused>()));
    });

    test('verifying the credential asks with the bearer and only reads the status',
        () async {
      transport.enqueue('{"items":[]}');

      await api.verifyCredential();

      expect(transport.last.method, 'GET');
      expect(transport.last.uri.path, '/m/devices');
      expect(transport.last.bearer, startsWith('Bearer '));
    });

    test('a credential the host no longer takes is a 401 hosts/ classifies', () async {
      transport.enqueue('{"error":"Unauthorized"}', status: 401);

      await expectLater(api.verifyCredential(), throwsA(isA<HostUnauthorized>()));
    });

    test('a 401 anywhere else is for hosts/ to classify', () async {
      transport.enqueue('{"error":"Unauthorized"}', status: 401);

      // `core/` deliberately does not decide expired-vs-revoked: that needs the
      // clock and the stored expiry, which live above it (ADR-13 no. 3).
      await expectLater(api.bootstrap(), throwsA(isA<HostUnauthorized>()));
    });
  });

  group('failures that are not the happy path', () {
    test('a 400 is our bug, and says so', () async {
      transport.enqueue('{"error":"text is required"}', status: 400);

      await expectLater(
        api.dispatch('p-1', ' '),
        throwsA(isA<HostRejected>()
            .having((e) => e.reason, 'reason', contains('text is required'))),
      );
    });

    test('a 5xx keeps its own meaning — a provider that really failed', () async {
      transport.enqueue('{"error":"openai: 400 invalid audio"}', status: 502);

      await expectLater(
        api.transcribe(audioBase64: 'AAAA', mime: 'audio/m4a'),
        throwsA(isA<HostFaulted>()),
      );
    });

    test('a body that is not JSON is a fault, not a crash on the only screen', () async {
      transport.enqueue('<html>gateway</html>');

      await expectLater(api.bootstrap(), throwsA(isA<HostFaulted>()));
    });

    test('an unreachable host surfaces the transport cause unchanged', () async {
      transport.failWith =
          const TransportUnavailable('asleep', cause: TransportCause.timedOut);

      // Not wrapped: `hosts/` maps `TransportCause` to `HostFailure`, and a second
      // translation in between would lose the distinction it depends on.
      await expectLater(
        api.bootstrap(),
        throwsA(isA<TransportUnavailable>()
            .having((e) => e.cause, 'cause', TransportCause.timedOut)),
      );
    });
  });

  test('every fixture this suite reads still exists', () {
    // A fixture renamed on the host side must fail here loudly rather than by way of
    // a confusing parse error inside one unrelated test.
    for (final name in const [
      'rest-pair',
      'rest-bootstrap',
      'rest-transcript',
      'rest-transcript-unsupported',
      'rest-permission',
      'rest-permission-unsupported',
      'rest-stt',
      'rest-stt-unsupported',
      'rest-devices-refresh',
    ]) {
      expect(File('${fixtures.path}/$name.json').existsSync(), isTrue, reason: name);
      expect(jsonDecode(fixture(name)), isA<Map<String, Object?>>(), reason: name);
    }
  });
}
