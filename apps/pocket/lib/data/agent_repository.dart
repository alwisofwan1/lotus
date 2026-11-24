import '../core/api_failure.dart';
import '../core/host_api.dart';
import '../core/transport.dart';
import '../hosts/biometric_gate.dart';
import '../hosts/credentials.dart';
import '../hosts/host_failure.dart';
import '../hosts/host_registry.dart';
import '../models/host_id.dart';
import '../models/transcript.dart';
import '../models/voice.dart';
import 'agent_view.dart';
import 'host_gate.dart';
import '../models/cell_result.dart';
import 'mutation_outcome.dart';
import 'output_buffer.dart';

// Re-exported because every screen that takes this repository also renders its answer.
export 'agent_view.dart';

part 'agent_repository_reads.dart';

/// Everything the Agent page reads and does, for one cell at a time.
///
/// This is where **policy** lives, and the reason it is not in `features/`: every
/// mutation passes the biometric gate (ADR-8) and a credential freshness check
/// (ADR-12 no. 2) *inside* this class. A screen cannot forget to ask, because a screen
/// has no other way to dispatch.
class AgentRepository {
  const AgentRepository({
    required this.registry,
    required this.credentials,
    required this.gate,
    required this.output,
  });

  /// Injected collaborators, visible at the call site (ADR-13 no. 4).
  final HostRegistry registry;
  final Credentials credentials;
  final BiometricGate gate;

  /// Where PTY bytes accumulate for the pane Terminal mode is showing.
  final OutputBuffer output;

  /// Points Terminal mode at a pane.
  ///
  /// Two steps that must not be separable by a caller: the buffer is told what to keep,
  /// **and** the socket is told to tail it. Leaving the second to a widget was the
  /// original shape and it produced a terminal that stayed empty forever — a connection
  /// with no subscription is told nothing about panes (ADR-10).
  void tail(CellRef ref) {
    output.watch(ref);
    registry.subscribe(ref.host, ref.paneId);
  }

  /// Stops tailing [ref] — leaving Terminal mode, or the page. Detaching matters on a
  /// phone: otherwise the stream keeps running, and `MVP.md` counts ~13 KB for one
  /// trivial prompt.
  ///
  /// **Takes a `CellRef`, not a `HostId`** (`issues/12`). Naming only the machine was
  /// enough while one page was ever alive; the pager keeps neighbours mounted, so "stop
  /// the tail on `mac`" from a page going away would cancel a different page's terminal.
  /// The cancel is conditional on the buffer agreeing this caller holds it.
  void stopTailing(CellRef ref) {
    if (output.release(ref)) registry.subscribe(ref.host, null);
  }

  Future<MutationOutcome> dispatch(CellRef ref, String text, {required String reason}) =>
      _mutate(ref, reason, (api) => api.dispatch(ref.paneId, text));

  /// One key press, straight through to the PTY. **Gated like everything else, and that
  /// costs nothing per key**: `BiometricGate` holds a proof for three minutes and drops
  /// it when the app backgrounds, so the first key asks and the rest do not.
  Future<MutationOutcome> sendInput(CellRef ref, String data, {required String reason}) =>
      _mutate(ref, reason, (api) => api.sendInput(ref.paneId, data));

  /// Interrupts the current turn. Still gated — ADR-8 calls it the loosest mutation,
  /// not an ungated one.
  Future<MutationOutcome> stop(CellRef ref, {required String reason}) =>
      _mutate(ref, reason, (api) => api.stop(ref.paneId));

  /// Ends the cell for good: the process stops and the pane leaves its workspace.
  ///
  /// The one irreversible thing this app can do, and it takes the **same** path as every
  /// other mutation. The extra weight it deserves is a confirmation, and copy belongs to
  /// `features/`. A second gate would be two prompts for one gesture.
  Future<MutationOutcome> close(CellRef ref, {required String reason}) =>
      _mutate(ref, reason, (api) => api.closeCell(ref.paneId));

  /// Starts a cell on [host], in [workspaceId], and says what came back.
  ///
  /// Gated like every other mutation, and **not** confirmed: choosing a runner, a model
  /// and a posture in the composer already states the intent, so a second tap would add
  /// a step without information. All three are fixed for the cell's life (ADR-8).
  Future<MutationOutcome> spawn({
    required HostId host,
    required String provider,
    required String reason,
    String? runnerId,
    String? workspaceId,
    String? initialPrompt,
    String? permissionMode,
    String? model, String? effort,
    String? profileId,
    bool? tui,
  }) =>
      _mutateOn(
        host,
        reason,
        (api) => api.spawnCell(
          provider: provider,
          runnerId: runnerId,
          workspaceId: workspaceId,
          initialPrompt: initialPrompt,
          permissionMode: permissionMode,
          model: model, effort: effort,
          profileId: profileId,
          tui: tui,
        ),
      );

  /// Whether this host runs an agent with no terminal on request (`structured-spawn`).
  bool canRunHeadlessOn(HostId host) => registry.statusOf(host)?.host.canRunHeadless ?? false;

  /// Whether this host will start a cell at all — what decides if the control exists.
  bool canSpawnOn(HostId host) => registry.statusOf(host)?.host.canStartCells ?? false;

  /// Whether this host will end a cell at all — what decides if the control exists.
  /// Read live rather than from pairing, like [canDictateOn]: a desktop that has since
  /// gained the route gets the control without a re-pair.
  bool canCloseOn(HostId host) => registry.statusOf(host)?.host.canEndCells ?? false;

  /// Whether this host advertises `stt`, which decides if a microphone is drawn
  /// (`DESKTOP_ONLY_FEATURES` — a Standalone Host has no key store). Read live, for the
  /// same reason `PairedHost.withHello` refreshes caps.
  bool canDictateOn(HostId host) => registry.statusOf(host)?.host.canTranscribe ?? false;

  /// Whether this host takes keystrokes — what decides if the terminal offers `⌨`.
  bool canTypeOn(HostId host) => registry.statusOf(host)?.host.canTakeKeys ?? false;

  /// Holds [ref]'s PTY at [cols]×[rows] while Terminal is open (v4 tiket 11). **Not
  /// gated** — no byte reaches the agent (`host_api_size.dart`).
  ///
  /// Null when the host could not be asked: it does not advertise `pty-size`, it is
  /// offline, or it refused. The caller tries again on its next renewal, which is cheap
  /// here — a host without the flag is never sent a request at all.
  Future<SizeHold?> holdSize(CellRef ref, {required int cols, required int rows, int? token}) async {
    final api = registry.apiFor(ref.host);
    if (api == null || !(registry.statusOf(ref.host)?.host.canHoldSize ?? false)) return null;
    return (await _read(ref.host,
            () => api.holdSize(ref.paneId, cols: cols, rows: rows, token: token)))
        .value;
  }

  /// Gives [ref]'s size back to the desktop. Best effort: a release that never arrives
  /// is what the lease's expiry is for.
  Future<void> releaseSize(CellRef ref, int token) async {
    final api = registry.apiFor(ref.host);
    if (api != null) await _read(ref.host, () => api.releaseSize(ref.paneId, token));
  }

  /// Dictation. Not gated: what it produces is text in a composer, and the dispatch
  /// that follows is the mutation that gets the prompt.
  ///
  /// Answers the same shape the host would when it cannot transcribe, so the caller has
  /// one path for "record again on the device" (ADR-11) rather than two.
  Future<Transcription> transcribe(
    HostId host, {
    required String audioBase64,
    required String mime,
    String? prompt,
  }) async {
    final paired = registry.statusOf(host)?.host;
    final api = registry.apiFor(host);
    if (paired == null || api == null || !paired.canTranscribe) {
      return const Transcription(hostSupports: false);
    }
    return api.transcribe(audioBase64: audioBase64, mime: mime, prompt: prompt);
  }

  Future<MutationOutcome> _mutate(
    CellRef ref,
    String reason,
    Future<void> Function(HostApi api) action,
  ) =>
      _mutateOn(ref.host, reason, action);

  /// The gate itself, which moved to [HostGate] when a second repository needed it.
  ///
  /// Built per call rather than held, so this class stays `const` and its constructor
  /// keeps naming the three seams `app/` hands it. It is a three-field value object;
  /// what would be expensive is a second copy of the policy, not a second allocation.
  HostGate get _hostGate =>
      HostGate(registry: registry, credentials: credentials, gate: gate);

  Future<MutationOutcome> _mutateOn(
    HostId host,
    String reason,
    Future<void> Function(HostApi api) action,
  ) =>
      _hostGate.run(host, reason, action);

}

/// One read: a value, or the named reason there is none.
