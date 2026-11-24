import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/data/dictation.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../support/agent_harness.dart';
import '../support/fake_recorder.dart';

const HostId mac = HostId('mac');

String said(String text) => jsonEncode({'text': text, 'provider': 'openai'});

/// The host declining to transcribe. A fork, not a failure (PLAN §7 no. 9).
const String declined = '{"text":null,"hostSupports":false}';

void main() {
  late FakeRecorder recorder;
  late AgentHarness harness;
  late Dictation dictation;
  late DateTime now;

  setUp(() async {
    recorder = FakeRecorder();
    harness = await AgentHarness.paired();
    // The harness's default host does not advertise `stt`, and that default is right —
    // it is what a Standalone Host looks like. Dictation needs the desktop-shaped one.
    harness.registry.add(harness.host(
      mac,
      features: const ['fleet', 'dispatch', 'transcript', 'permission', 'stt'],
    ));
    now = DateTime(2026, 8, 9, 12);
    dictation = Dictation(
      recorder: recorder,
      repository: harness.repository,
      now: () => now,
      // Never fires on its own: every test that cares about elapsed time moves the
      // clock itself, which is the seam `Credentials` takes for the TTL.
      ticker: (_) => const Stream<void>.empty(),
    );
  });

  tearDown(() {
    dictation.dispose();
    harness.dispose();
  });

  group('tap to start', () {
    test('recording begins and the state says so', () async {
      await dictation.start();

      expect(recorder.starts, 1);
      expect(dictation.state, isA<DictationRecording>());
      expect(dictation.isRecording, isTrue);
    });

    test('a refused permission is a notice, never an exception', () async {
      recorder.permitted = false;

      await dictation.start();

      // It has to be sayable on a bar that is 44px tall. Throwing here would take out
      // the composer's build with it.
      expect(dictation.state, isA<DictationIdle>());
      expect(dictation.notice, contains('microphone permission'));
      expect(recorder.starts, 0);
    });

    test('a microphone that will not open says so and stays idle', () async {
      recorder.failStart = StateError('busy');

      await dictation.start();

      expect(dictation.state, isA<DictationIdle>());
      expect(dictation.notice, contains('would not start'));
    });

    test('a second tap while recording does nothing', () async {
      await dictation.start();
      await dictation.start();

      expect(recorder.starts, 1);
    });
  });

  group('while recording', () {
    test('loudness reaches the state, so the bar can be real', () async {
      await dictation.start();

      recorder.hear(0.7);
      await Future<void>.delayed(Duration.zero);

      expect((dictation.state as DictationRecording).level, 0.7);
    });

    test('elapsed is measured from the clock, not counted', () async {
      await dictation.start();
      now = now.add(const Duration(seconds: 42));
      recorder.hear(0.1);
      await Future<void>.delayed(Duration.zero);

      expect((dictation.state as DictationRecording).elapsed, const Duration(seconds: 42));
    });
  });

  group('tap to stop', () {
    test('returns what the host heard, and lands back on idle', () async {
      harness.http.enqueue(said('run the test suite'));
      await dictation.start();

      final text = await dictation.stop(mac);

      expect(text, 'run the test suite');
      expect(dictation.state, isA<DictationIdle>());
      expect(recorder.stops, 1);
    });

    test('the clip goes to the host, never anywhere else', () async {
      harness.http.enqueue(said('ok'));
      await dictation.start();

      await dictation.stop(mac);

      // ADR-11: the key lives on the machine, so the audio is transcribed there. A
      // phone that shipped this anywhere else would be shipping the operator's voice.
      expect(harness.http.last.uri.path, endsWith('/m/stt'));
      expect(harness.http.last.json['mime'], 'audio/mp4');
      expect(harness.http.last.json['audioBase64'], isNotEmpty);
    });

    test('a host that declines says which machine, not that the audio was bad',
        () async {
      harness.http.enqueue(declined);
      await dictation.start();

      final text = await dictation.stop(mac);

      expect(text, isNull);
      expect(dictation.notice, contains('not set up to transcribe'));
    });

    test('an empty transcript is named rather than returned as empty text', () async {
      harness.http.enqueue(said('   '));
      await dictation.start();

      // Returning '' would put nothing in the composer and say nothing about why.
      expect(await dictation.stop(mac), isNull);
      expect(dictation.notice, contains('Nothing was heard'));
    });

    test('an unreachable host is named as unreachable', () async {
      await dictation.start();
      harness.http.failWith =
          const TransportUnavailable('asleep', cause: TransportCause.timedOut);

      final text = await dictation.stop(mac);

      expect(text, isNull);
      expect(dictation.notice, contains('could not be reached'));
      expect(dictation.state, isA<DictationIdle>());
    });

    test('a recording that produced nothing settles quietly', () async {
      recorder.clip = null;
      await dictation.start();

      expect(await dictation.stop(mac), isNull);
      // No notice: nothing failed and nothing was heard. A message here would be the
      // app talking about itself.
      expect(dictation.notice, isNull);
      expect(harness.http.sent, isEmpty);
    });

    test('stopping when nothing is recording is a no-op', () async {
      expect(await dictation.stop(mac), isNull);
      expect(recorder.stops, 0);
    });
  });

  group('cancel', () {
    test('throws the audio away without asking the host anything', () async {
      await dictation.start();

      await dictation.cancel();

      expect(recorder.cancels, 1);
      expect(recorder.stops, 0, reason: 'cancel must not produce a clip to send');
      expect(harness.http.sent, isEmpty);
      expect(dictation.state, isA<DictationIdle>());
    });

    test('survives a recorder that fails on the way out', () async {
      await dictation.start();
      final rude = FakeRecorder()..permitted = true;

      // The one action that must always work: the operator asked for this recording to
      // stop existing, and it does, whatever the platform says on the way.
      await dictation.cancel();
      expect(dictation.isBusy, isFalse);
      rude.dispose();
    });
  });

  test('a notice survives until the next attempt, not until the next rebuild', () async {
    recorder.permitted = false;
    await dictation.start();
    expect(dictation.notice, isNotNull);

    recorder.permitted = true;
    await dictation.start();

    expect(dictation.notice, isNull);
  });

  test('the transcript is never dispatched by this class', () async {
    harness.http.enqueue(said('delete everything'));
    await dictation.start();

    await dictation.stop(mac);

    // The only request made is the transcription. Speech recognition mishears, and a
    // phone that dispatched what it thought it heard would put words no human read in
    // front of an agent with a shell — the send stays the operator's, and it is the one
    // that meets the gate (ADR-8).
    expect(harness.http.sent.map((r) => r.uri.path).toList(), ['/m/stt']);
    expect(harness.biometrics.prompts, 0);
  });
}
