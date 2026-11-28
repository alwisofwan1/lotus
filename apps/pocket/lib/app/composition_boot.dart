part of 'composition_root.dart';

/// Everything [CompositionRoot] has to build before the first frame.
///
/// A `part` rather than a method, for the reason `agent_page.dart` split the same way:
/// the class is a list of what this app is made of, and the ~120 lines of *how each one
/// is made* pushed that list past the repo's 300-line ceiling. Splitting it keeps the
/// inventory readable and leaves room for the next dependency.
/// Builds the graph and loads persisted credentials.
///
/// Credentials are read before anything connects, because a socket opened without a
/// bearer would earn a 401 and then retry with backoff for a token that was sitting
/// in the Keychain the whole time.
Future<CompositionRoot> bootRoot({
  Transport? transport,
  HttpTransport? httpTransport,
  SecureStore? secureStore,
  Biometrics? biometrics,
  PushTokens? pushTokens,
  PushMessages? pushMessages,
  QrScanner? scanner,
  VoiceRecorder? recorder,
  RefreshKeys? refreshKeys,
  AppBuild? build,
  Clock now = systemClock,
}) async {
  // The Keystore by default: nothing touches it until a pairing asks for a key.
  final keys = refreshKeys ?? const DeviceRefreshKeys();
  final gate = BiometricGate(biometrics ?? DeviceBiometrics(), now: now);
  final store = secureStore ?? const KeychainStore();
  final credentials = Credentials(store: store, now: now, gate: gate);
  await credentials.load();

  // Named once, then shared: pairing needs the same seam the registry uses, because
  // `POST /m/pair` is the one route with no host to ask for a `HostApi`.
  final http = httpTransport ?? PackageHttpTransport();

  final registry = HostRegistry(
    transport: transport ?? const WebSocketTransport(),
    httpTransport: http,
    // The registry reads the current token per connection, so a mid-session refresh
    // is invisible to it (ADR-12 no. 2).
    tokenReader: credentials.tokenFor,
    sleep: Future<void>.delayed,
    // A refused socket is checked over HTTP; this tells a lapsed token from a revoked one.
    tokenStillValid: credentials.isUsable,
  );

  // Every paired host is registered but not connected: pairing and connecting stay
  // separate so a known-but-asleep host is shown as such instead of failing quietly.
  for (final device in credentials.devices) {
    registry.add(PairedHost.of(device));
  }

  final fleet = FleetStore(registry.events);
  // One instance, two owners: the root hands it to Home, and `PairingRepository`
  // clears it on unpair. Two would disagree about which project is remembered.
  final snippets = Snippets(store);
  final seenMarks = SeenMarks(store, now: now);
  await seenMarks.load();
  final drafts = DraftKeeper(store);
  await drafts.load();
  final doneMarks = DoneMarks(store, now: now);
  await doneMarks.load();
  final introSeen = IntroSeen(store);
  await introSeen.load();
  // After the intro bit, which is what tells an upgraded phone from a fresh install.
  final buildSeen = BuildSeen(store, current: build ?? await readAppBuild());
  await buildSeen.load(returning: introSeen.isSeen);
  final themeChoice = ThemeChoice(store);
  await themeChoice.load();
  // Shared with `liveTranscript` below and read from `TerminalFeed` off `output`
  // itself, so every Fase 0 counter this app produces lands in one log.
  final measurements = MeasurementLog(now: now);
  final output = OutputBuffer(registry.events, measurements: measurements);
  final liveTranscript = LiveConversation(
    registry.events,
    measurements: measurements,
  );
  // Given a reader rather than an api client, so the pager owns no transport and the
  // failure policy stays with the repository, where every other read's already is.
  final transcriptPager = TranscriptPager(
    fetch: (ref, before) async =>
        registry.apiFor(ref.host)?.transcript(ref.paneId, before: before),
  );
  final agents = AgentRepository(
    registry: registry,
    credentials: credentials,
    gate: gate,
    output: output,
  );
  // The same three seams the agent mutations take, so both repositories pass the one
  // gate rather than each holding a copy of it (`data/host_gate.dart`).
  final projects = ProjectRepository(
    registry: registry,
    credentials: credentials,
    gate: gate,
  );

  return CompositionRoot._(
    credentials: credentials,
    projects: projects,
    registry: registry,
    fleet: fleet,
    fleetRepository: FleetRepository(
      registry: registry,
      store: fleet,
      credentials: credentials,
    ),
    agents: agents,
    output: output,
    snippets: snippets,
    seenMarks: seenMarks,
    drafts: drafts,
    doneMarks: doneMarks,
    introSeen: introSeen,
    buildSeen: buildSeen,
    themeChoice: themeChoice,
    pairing: PairingRepository(
      credentials: credentials,
      registry: registry,
      transport: http,
      // Unpairing removes a machine *entirely*: its rows leave the switcher and
      // the remembered project goes with it, if it was that machine's.
      fleet: fleet,
      snippets: snippets,
      keys: keys,
    ),
    // `UnavailablePushTokens` by default, and that is the honest default: without the
    // messaging plugin and a Firebase project this build genuinely cannot receive a
    // wake-up, so `PushRepository` registers nothing and the app runs on its live
    // socket exactly as before.
    push: PushRepository(
      tokens: pushTokens ?? const UnavailablePushTokens(),
      registry: registry,
    ),
    pushMessages: pushMessages ?? const UnavailablePushMessages(),
    wakes: WakeResolver(fleet),
    now: now,
    liveTranscript: liveTranscript,
    transcriptPager: transcriptPager,
    gate: gate,
    // The real camera by default, unlike `push`, whose honest default is the
    // unavailable one: this build genuinely ships `mobile_scanner`, and nothing
    // touches the hardware until the scan route is actually opened.
    scanner: scanner ?? const CameraQrScanner(),
    // The real microphone by default, for the same reason as the camera: this build
    // ships `record`, and nothing touches the hardware until a tap asks it to.
    dictation: Dictation(
      recorder: recorder ?? DeviceVoiceRecorder(),
      repository: agents,
      now: now,
    ),
    measurements: measurements,
    refreshKeys: keys,
  );
}
