import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/api_failure.dart';
import '../core/clock.dart';
import '../core/transport.dart';
import '../core/voice_recorder.dart';
import '../models/host_id.dart';
import 'agent_repository.dart';

/// Failures return to idle with a notice rather than requiring dismissal.
sealed class DictationState {
  const DictationState();
}

class DictationIdle extends DictationState {
  const DictationIdle();
}

class DictationRecording extends DictationState {
  const DictationRecording({required this.elapsed, required this.level});

  final Duration elapsed;

  /// `0.0`–`1.0`, already normalised by the recorder. Always zero on a device that
  /// cannot measure loudness, which the composer renders as motion that depends on
  /// nothing rather than as a flat bar.
  final double level;
}

class DictationTranscribing extends DictationState {
  const DictationTranscribing();
}

/// Never dispatch recognized text automatically; the operator must review it and pass the gate (ADR-8, ADR-13 no. 1).
class Dictation extends ChangeNotifier {
  Dictation({
    required this.recorder,
    required this.repository,
    this.now = systemClock,
    Stream<void> Function(Duration)? ticker,
  }) : _ticker = ticker ?? _defaultTicker;

  final VoiceRecorder recorder;
  final AgentRepository repository;

  /// Injected so the elapsed clock is tested by moving time rather than waiting it out —
  /// the seam `Credentials` takes for the TTL.
  final Clock now;

  final Stream<void> Function(Duration) _ticker;

  static Stream<void> _defaultTicker(Duration every) =>
      Stream<void>.periodic(every, (_) {});

  /// How often the elapsed counter redraws. One second, because it is rendered as
  /// `0:07` — anything faster is rebuilds nobody can see.
  static const Duration tick = Duration(seconds: 1);

  DictationState _state = const DictationIdle();
  DictationState get state => _state;

  bool get isRecording => _state is DictationRecording;
  bool get isBusy => _state is! DictationIdle;

  /// What to say about the last attempt, or null when there is nothing to say.
  ///
  /// Cleared when the next one starts, not when it is read: a notice that vanishes on
  /// the first rebuild is a notice nobody sees.
  String? notice;

  DateTime? _startedAt;
  double _level = 0;
  StreamSubscription<double>? _levels;
  StreamSubscription<void>? _ticks;

  /// Whether the microphone could be used at all. Asking may prompt for the permission,
  /// which is why this is called on the tap and not on every build.
  Future<bool> get available => recorder.canRecord;

  /// Begins recording. A refusal is a notice, not an exception.
  Future<void> start() async {
    if (isBusy) return;
    notice = null;

    if (!await recorder.canRecord) {
      notice = 'Lotus Pocket has no microphone permission.';
      notifyListeners();
      return;
    }

    try {
      await recorder.start();
    } on Object {
      notice = 'The microphone would not start.';
      notifyListeners();
      return;
    }

    _startedAt = now();
    _level = 0;
    _state = DictationRecording(elapsed: Duration.zero, level: 0);
    _levels = recorder.level.listen(_onLevel);
    _ticks = _ticker(tick).listen((_) => _onTick());
    notifyListeners();
  }

  /// Ends the recording and returns what was heard, or null when there is nothing to
  /// put in the composer. [host] is where the audio goes — dictation is transcribed by
  /// the machine, never on the phone, because that is where the key is (ADR-11).
  Future<String?> stop(HostId host) async {
    if (_state is! DictationRecording) return null;
    _quiet();

    final RecordedClip? clip;
    try {
      clip = await recorder.stop();
    } on Object {
      return _settle('The recording could not be read.');
    }
    if (clip == null) return _settle(null);

    _state = const DictationTranscribing();
    notifyListeners();

    try {
      final result = await repository.transcribe(
        host,
        audioBase64: clip.audioBase64,
        mime: clip.mime,
      );
      // The host declining is a fork, not a failure (PLAN §7 no. 9) — it means "record
      // again with the phone's own recogniser". This build has no on-device recogniser,
      // so the honest answer is to say which machine cannot help rather than to pretend
      // the audio was bad.
      if (!result.hostSupports) {
        return _settle('That machine is not set up to transcribe.');
      }
      final text = result.text?.trim();
      if (text == null || text.isEmpty) return _settle('Nothing was heard.');
      _settle(null);
      return text;
    } on TransportUnavailable {
      return _settle('That machine could not be reached.');
    } on ApiFailure {
      return _settle('That machine could not transcribe it.');
    }
  }

  /// Throws the recording away. The one action that must always work, so it forgives
  /// everything the recorder might say on the way out.
  Future<void> cancel() async {
    if (!isBusy) return;
    _quiet();
    try {
      await recorder.cancel();
    } on Object {
      // Nothing to tell the operator: they asked for this to stop existing, and it has.
    }
    _settle(null);
  }

  @override
  void dispose() {
    _quiet();
    unawaited(recorder.dispose());
    super.dispose();
  }

  void _onLevel(double level) {
    _level = level;
    if (_state is DictationRecording) _publishRecording();
  }

  void _onTick() {
    if (_state is DictationRecording) _publishRecording();
  }

  void _publishRecording() {
    final started = _startedAt;
    _state = DictationRecording(
      elapsed: started == null ? Duration.zero : now().difference(started),
      level: _level,
    );
    notifyListeners();
  }

  /// Back to idle, saying [message] if there is anything worth saying. Returns null so
  /// the failure paths above can `return _settle(…)` and read as one statement.
  String? _settle(String? message) {
    notice = message;
    _startedAt = null;
    _level = 0;
    _state = const DictationIdle();
    notifyListeners();
    return null;
  }

  /// Do not await teardown on the user action path; late events are ignored.
  void _quiet() {
    unawaited(_levels?.cancel() ?? Future<void>.value());
    unawaited(_ticks?.cancel() ?? Future<void>.value());
    _levels = null;
    _ticks = null;
  }
}
