part of 'agent_repository.dart';

/// The reads — what Chat is built from — split from `agent_repository.dart` at the
/// 300-line mark when `result` and `diff` arrived. A `part`, so `_read` and the
/// registry's unauthorized report stay one implementation shared with the mutations.
extension AgentRepositoryReads on AgentRepository {
  /// Reads the two structured surfaces Chat is built from, concurrently.
  ///
  /// Both futures are started before either is awaited, so a screen opening costs one
  /// round trip rather than two — and each is awaited separately so one failing route
  /// does not hide the other's answer behind a combined error.
  Future<AgentView> load(CellRef ref) async {
    final host = registry.statusOf(ref.host)?.host;
    final api = registry.apiFor(ref.host);
    if (host == null || api == null) {
      return AgentView.failed(ref, const HostUnknownFailure());
    }
    // Asked of the host's own advertisement, never guessed from the mode, so a desktop
    // older than these routes is handled by the same branch as a VPS.
    if (!host.hasChat) return AgentView.terminalOnly(ref);

    final transcriptCall = api.transcript(ref.paneId);
    final permissionCall = api.permission(ref.paneId);
    // Asked only where advertised, and never allowed to fail the page: a git error on the
    // machine is a footnote missing, not a Chat that cannot open.
    final resultCall = host.canReport ? api.result(ref.paneId) : null;
    // Asked wherever the host serves it, and preferred for seeding Chat: the host's own
    // turns carry the ids its live lane sends, so a seed and a delta are the same part
    // rather than two copies of it. Never allowed to fail the page — the entries are
    // still there, and this app can still convert them itself.
    final conversationCall = host.hasConversation ? api.conversation(ref.paneId) : null;

    // Both are awaited even when the first fails: dropping the second would leave its
    // error unhandled, and an unawaited failed future is reported as a crash.
    final transcript = await _read(ref.host, () => transcriptCall);
    final permission = await _read(ref.host, () => permissionCall);

    final result = resultCall == null ? null : await _read(ref.host, () => resultCall);
    final conversation =
        conversationCall == null ? null : await _read(ref.host, () => conversationCall);
    final failure = transcript.failure ?? permission.failure;
    if (failure != null) return AgentView.failed(ref, failure);

    return AgentView(
      ref: ref,
      // The host's own verdict, not an inference from an empty list — three silences told
      // apart. A desktop whose hooks never reach its agents answers `hostSupports: false`
      // and is empty for every pane forever; that host-wide fault outranks the rest,
      // because fixing it is what makes every other pane work. `outlook` decides the other
      // two: `runnerReports` could not tell "steps are coming" from "cannot say", spelling
      // both as absent, so a pane the desktop could not place drew as an ordinary empty
      // Chat that never filled.
      blocked: switch (transcript.value) {
        final t? when !t.hostSupports => ChatBlocked.notRecording,
        final t? when t.outlook == TranscriptOutlook.never => ChatBlocked.runnerSilent,
        final t? when t.outlook == TranscriptOutlook.unknown => ChatBlocked.outlookUnknown,
        _ => null,
      },
      transcript: transcript.value,
      // Only when the host actually returned turns: an empty page from a pane it holds
      // nothing for must not shadow the entries, which may still have history.
      conversation: (conversation?.value?.turns.isEmpty ?? true)
          ? null
          : conversation!.value!.turns,
      permission: permission.value,
      result: result?.value,
    );
  }

  /// One file's diff against HEAD, or null when it could not be read — the screen that
  /// asked says so in a sentence; a diff is read, never retried into a gate.
  Future<CellDiff?> diff(CellRef ref, String file) async {
    final api = registry.apiFor(ref.host);
    if (api == null) return null;
    return (await _read(ref.host, () => api.diff(ref.paneId, file))).value;
  }


  /// Sends text to the agent. [reason] is shown by the OS in the biometric prompt, so
  /// it is passed in: naming the cell is copy, and copy belongs to `features/`.

  /// Reads one route, turning any failure into a named cause rather than an exception.
  Future<_Read<T>> _read<T>(HostId host, Future<T> Function() call) async {
    try {
      return _Read(value: await call());
    } on TransportUnavailable catch (failure) {
      return _Read(failure: HostFailure.fromCause(failure.cause));
    } on HostUnauthorized {
      return _Read(failure: _hostGate.reportUnauthorized(host) ?? const HostUnknownFailure());
    } on ApiFailure {
      return _Read(failure: const HostUnknownFailure());
    } on Object {
      // A 200 whose body is valid JSON but missing a required field — a proxy answering
      // `{}`, or a host that broke the contract. `HostApi` guards against a body that is
      // not JSON at all, but a hand-written `fromJson` still throws on an absent field,
      // and that landed here as a crash on the only screen the operator has. Named as
      // unclassified rather than diagnosed: nothing about it says which host is at fault.
      return _Read(failure: const HostUnknownFailure());
    }
  }

  /// Tells `hosts/` about a 401 and takes back the diagnosis it made.
  ///
  /// Whether an expired token differs from a revoked one is decided in exactly one
  /// place — `HostRegistry`, using the clock and the stored expiry — so reading its
  /// verdict back is cheaper than repeating the rule and safer than guessing it.
}

class _Read<T> {
  const _Read({this.value, this.failure});

  final T? value;
  final HostFailure? failure;
}
