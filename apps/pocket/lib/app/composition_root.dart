import 'dart:async';

import '../core/biometrics.dart';
import '../core/build_info.dart';
import '../core/clock.dart';
import '../core/device_biometrics.dart';
import '../core/device_voice_recorder.dart';
import '../core/http_transport.dart';
import '../core/keychain_store.dart';
import '../core/camera_qr_scanner.dart';
import '../core/push_messages.dart';
import '../core/push_tokens.dart';
import '../core/qr_scanner.dart';
import '../core/refresh_keys.dart';
import '../core/secure_store.dart';
import '../core/transport.dart';
import '../core/voice_recorder.dart';
import '../core/ws_transport.dart';
import '../data/agent_repository.dart';
import '../data/dictation.dart';
import '../data/fleet_repository.dart';
import '../data/fleet_store.dart';
import '../data/intro_seen.dart';
import '../data/build_seen.dart';
import '../data/draft_keeper.dart';
import '../data/seen_marks.dart';
import '../data/snippets.dart';
import '../data/live_conversation.dart';
import '../data/transcript_pager.dart';
import '../data/measurement_log.dart';
import '../data/output_buffer.dart';
import '../data/pairing_repository.dart';
import '../data/push_repository.dart';
import '../data/wake_resolver.dart';
import '../hosts/biometric_gate.dart';
import '../hosts/credentials.dart';
import '../data/project_repository.dart';
import 'host_naming.dart';
import '../hosts/host_registry.dart';
import '../hosts/paired_host.dart';
import '../models/app_build.dart';
import '../models/host_id.dart';

/// The object graph, built once.
///
/// This is the **only** place in the app allowed to name a concrete implementation —
/// `WebSocketTransport`, `KeychainStore`, `DeviceBiometrics`. Everything below
/// receives its collaborators through a constructor (ADR-13 no. 4), and because that
/// wiring happens here, `features/` never has to construct anything. That is what
/// makes the layering rule "features never touch transport" enforceable rather than
/// aspirational — there is nothing for a widget to reach for.
///
/// Every seam is a parameter with a real default, so a test can replace exactly the
/// one it cares about and let the rest stand.
part 'composition_boot.dart';

class CompositionRoot {
  CompositionRoot._({
    required this.credentials,
    required this.registry,
    required this.projects,
    required this.fleet,
    required this.fleetRepository,
    required this.agents,
    required this.output,
    required this.pairing,
    required this.push,
    required this.pushMessages,
    required this.wakes,
    required this.now,
    required this.liveTranscript,
    required this.transcriptPager,
    required this.gate,
    required this.scanner,
    required this.dictation,
    required this.snippets,
    required this.seenMarks,
    required this.drafts,
    required this.introSeen,
    required this.buildSeen,
    required this.measurements,
    required this.refreshKeys,
  });

  final Credentials credentials;
  final HostRegistry registry;
  final FleetStore fleet;
  final FleetRepository fleetRepository;
  final AgentRepository agents;

  /// Adding a project to a machine — a clone today, a picked folder later.
  final ProjectRepository projects;
  final OutputBuffer output;
  final PairingRepository pairing;

  /// Keeps every host that can wake this phone told where to reach it (ADR-4).
  final PushRepository push;

  /// Wake-ups arriving while the app is open or being tapped; `app/` draws and routes them.
  final PushMessages pushMessages;
  final WakeResolver wakes;

  /// The microphone and its host (PLAN §7 no. 9); one instance, because two composers
  /// each holding a recorder would be two things able to start the microphone at once.
  final Dictation dictation;

  /// Lines the operator keeps, and what this phone has sent, per machine. Built here
  /// like every other store so `features/` never constructs one (ADR-13 no. 1).
  final Snippets snippets;

  /// Which agents were opened since they last finished — Home's unread marks.
  final SeenMarks seenMarks;

  /// What was left unsent in each agent's composer. Loaded here with the others so a
  /// page that opens on the first frame already has the draft in hand.
  final DraftKeeper drafts;

  /// Loaded here too, so `PocketApp` picks its first screen synchronously.
  final IntroSeen introSeen;

  /// The running build, and whether this launch is the first of it. Diagnostics shows
  /// the first; `PocketApp` announces the second once.
  final BuildSeen buildSeen;

  /// The camera behind the pairing QR (ADR-5 step 1), handed to onboarding as
  /// `scanner.view` — a bare function — because `features/` may not import `core/`.
  final QrScanner scanner;

  /// The proof-of-presence gate every mutation passes (ADR-8).
  ///
  /// Held here, not only handed to `AgentRepository`, because its standing proof has to
  /// be dropped when the app leaves the foreground — and lifecycle belongs to `app/`.
  final BiometricGate gate;

  /// Chat's transcript, kept current from the socket rather than refetched.
  ///
  /// Fed from the same merged stream as [fleet] and [output]: the host broadcasts
  /// every hook event to every device already, so this costs nothing on the wire.
  final LiveConversation liveTranscript;

  /// Walks a cell's transcript backwards as the operator scrolls up (Fase 3).
  ///
  /// Built here rather than by the page, because cursors must survive a swipe: the pager
  /// keeps how far back each cell has been read, and a page rebuilt on every page change
  /// would forget it.
  final TranscriptPager transcriptPager;

  /// Held rather than only passed to [Credentials], because diagnostics reads it too:
  /// what is left of a token is a subtraction, and a screen doing it with its own
  /// `DateTime.now()` would be a second clock a test cannot move.
  final Clock now;

  /// Fase 0 counting (`plans/session-history-hardening/issues/01`) — one instance,
  /// shared with [output] and [liveTranscript] so their counters and the terminal's
  /// rebuild count (read off [output] — see `TerminalFeed._build`) land in the same
  /// log. Held here too because Diagnostics is where an operator copies it off the
  /// phone, and that screen never constructs anything of its own (ADR-13 no. 1).
  final MeasurementLog measurements;

  /// The hardware-bound refresh keys, for `CredentialKeeper` (`PocketApp` builds it).
  final RefreshKeys refreshKeys;

  /// Builds every dependency this app has, in the order they depend on each other.
  /// The body is in `composition_boot.dart` — see there for why.
  static Future<CompositionRoot> boot({
    Transport? transport,
    HttpTransport? httpTransport,
    SecureStore? secureStore,
    Biometrics? biometrics,
    PushTokens? pushTokens,
    PushMessages? pushMessages,
    QrScanner? scanner,
    VoiceRecorder? recorder,
    AppBuild? build,
    Clock now = systemClock,
  }) =>
      bootRoot(
        transport: transport,
        httpTransport: httpTransport,
        secureStore: secureStore,
        biometrics: biometrics,
        pushTokens: pushTokens,
        pushMessages: pushMessages,
        scanner: scanner,
        recorder: recorder,
        build: build,
        now: now,
      );

  /// Opens every socket and fills the store from every host at once.
  ///
  /// Not awaited as a set: a sleeping host retries for as long as it stays asleep, and
  /// the screen renders each host as it answers (R-11).
  Future<void> start() async {
    registry.connectAll();
    // Registered before the first fetch resolves: the token is what makes the *next*
    // background stretch useful, and it does not depend on the fleet.
    unawaited(push.start());
    await fleetRepository.hydrate();
  }

  /// The operator-facing name of a host, or empty when naming it says nothing.
  /// The rule, and why it exists, live in `host_naming.dart`.
  String hostLabel(HostId host) =>
      hostLabelFor(host, credentials: credentials, registry: registry);

  void dispose() {
    dictation.dispose();
    liveTranscript.dispose();
    output.dispose();
    fleetRepository.dispose();
    fleet.dispose();
    registry.dispose();
    credentials.dispose();
  }
}
