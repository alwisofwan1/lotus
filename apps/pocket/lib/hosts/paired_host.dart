import '../models/cell.dart';
import '../models/host_id.dart';
import '../models/pairing.dart';
import 'host_failure.dart';

/// A host this phone has paired with, and how to reach it.
class PairedHost {
  const PairedHost({
    required this.id,
    required this.label,
    required this.baseUri,
    required this.mode,
    required this.caps,
  });

  final HostId id;

  /// What the operator calls it — `MacBook`, `VPS`. Shown wherever a project name
  /// could collide across hosts (R-10).
  final String label;

  /// Where the mobile façade listens for this host. Every host serves the same
  /// paths, so only this and the credential differ (ADR-10).
  final Uri baseUri;

  /// `client` or `standalone`. Decides the shape of the Agent page before it opens:
  /// a standalone host has no Chat at all (§7 no. 10).
  final String mode;

  final HostCaps caps;

  /// The registry's view of a stored credential.
  ///
  /// A named constructor rather than five lines at the call site: `PairedDevice` is
  /// what the Keychain holds and this is what the registry dials, and the mapping
  /// between them belongs beside the type it produces.
  PairedHost.of(PairedDevice device)
      : id = device.hostId,
        label = device.hostLabel,
        baseUri = device.baseUri,
        mode = device.mode,
        caps = device.caps;

  bool get isStandalone => mode == 'standalone';

  /// Whether Chat can exist here. Asked of the host, not guessed from the mode, so
  /// a desktop older than those routes is also handled.
  bool get hasChat => caps.supports('transcript') && caps.supports('permission');

  /// Whether dictation can be sent here at all; when false the phone uses its own
  /// recogniser (ADR-11).
  bool get canTranscribe => caps.supports('stt');

  /// Whether a repository can be cloned onto this machine
  /// (`plans/pocket-vps-project-checkout`). Asked of the host, never inferred from the
  /// mode: a standalone host with no workspace root cannot, and says so.
  bool get canCloneProjects => caps.supports('projects-create');

  /// Whether a folder already on this machine can be picked as a project. Ships after
  /// cloning does, which is why it is a second flag rather than the same one.
  bool get canBrowseProjects => caps.supports('projects-browse');

  /// Whether this host will end a cell on request.
  ///
  /// Asked rather than assumed, and the answer decides whether the control is drawn at
  /// all — the same rule the microphone follows. A host that cannot do it is not a
  /// broken host, so the phone shows no disabled remnant of a button; it shows nothing.
  ///
  /// On a desktop the work is not done by its API but by the Lotus window, which can be
  /// closed or sitting on no workspace. That is a *readiness* question rather than a
  /// capability one, it can change minute to minute, and it cannot be answered by a
  /// capability list — it arrives as the refusal of an attempt.
  bool get canEndCells => caps.supports('close');

  /// Whether this host will start a cell on request. Same rule as [canEndCells]: the
  /// control is drawn only where the machine advertised it.
  bool get canStartCells => caps.supports('spawn');

  /// `POST /m/cells` with `tui: false`: this host runs the agent itself over its structured
  /// protocol, no terminal anywhere (`structured-spawn`, Codex only today).
  bool get canRunHeadless => caps.supports('structured-spawn');

  /// Whether this host takes key-level writes to a pane's PTY. Same rule again, and it
  /// matters more here than elsewhere: a host that predates the route answers 404, which
  /// this app words as *no live session* — a sentence about the wrong thing entirely.
  bool get canTakeKeys => caps.supports('input');

  /// Whether the phone may hold a pane's PTY size while Terminal is open (v4 tiket 11).
  /// Desktop only: a standalone host has no second screen to give the size back to.
  bool get canHoldSize => caps.supports('pty-size');

  /// Whether this host answers `/result` and `/diff` — git's view of a pane's directory.
  /// Base in both modes, but a host older than the routes has no flag, and asking it
  /// would 404 into a sentence about the wrong thing.
  bool get canReport => caps.supports('result');

  /// Whether this host serves the conversation it derived itself.
  ///
  /// Preferred over `/transcript` wherever it is true, because the host's own turns are
  /// the same ones its live lane sends — the ids match, so a seed and a delta describe
  /// the same part instead of two copies of it.
  bool get hasConversation => caps.supports('conversation');

  /// Whether this host can wake a backgrounded app, so a push token is only ever
  /// registered where it will be used.
  ///
  /// Asked rather than assumed for a reason worth stating: a host with no Firebase
  /// service account cannot send, and registering anyway produces an app that waits
  /// for wake-ups which can never arrive — indistinguishable, from the operator's
  /// side, from a fleet where nothing is happening.
  bool get canPush => caps.supports('push');

  /// The same host as its `hello` frame currently describes it.
  ///
  /// [caps] and [mode] arrive twice — once in the pairing reply, then on every
  /// connection — and the second is the one that is true *now*. Without this the app
  /// keeps deciding whether to draw Chat from what was advertised the day it paired,
  /// so a desktop that has since gained the hook pipeline stays hidden behind stale
  /// capabilities. The contract's rule is to hide what the host does not advertise,
  /// which only works if "advertise" means the latest frame.
  PairedHost withHello({required String label, required String mode, required HostCaps caps}) =>
      PairedHost(id: id, label: label, baseUri: baseUri, mode: mode, caps: caps);
}

/// What the app currently knows about reaching one host.
class HostStatus {
  const HostStatus({required this.host, this.connected = false, this.failure});

  final PairedHost host;
  final bool connected;

  /// Set when the last attempt failed. Kept alongside `connected` rather than
  /// replacing it: a host can be disconnected for a reason worth naming.
  final HostFailure? failure;

  HostStatus copyWith({
    PairedHost? host,
    bool? connected,
    HostFailure? failure,
    bool clearFailure = false,
  }) =>
      HostStatus(
        host: host ?? this.host,
        connected: connected ?? this.connected,
        failure: clearFailure ? null : (failure ?? this.failure),
      );
}
