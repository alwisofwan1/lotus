import 'dart:async';

import 'package:flutter/material.dart';

import '../data/credential_keeper.dart';
import '../features/home/home_screen.dart';
import '../features/home/add_project.dart';
import 'projects_route.dart';
import '../features/projects/clone_flow.dart';
import '../features/projects/browse_screen.dart';
import '../features/projects/clone_form.dart';
import '../features/onboarding/onboarding_screen.dart';
import '../models/cell.dart';
import '../models/host_id.dart';
import 'agent_route.dart';
import 'composition_root.dart';
import 'diagnostics_route.dart';
import 'launch_shell.dart';
import 'theme/theme_controller.dart';
import 'update_notice.dart';
import 'wake_routing.dart';

/// The app shell: one theme, and the screen the operator lands on.
///
/// `MaterialApp` is here as a **framework**, not as a look — Navigator, gestures, focus
/// traversal and text handling. Every visible surface takes its colours and type from
/// `buildAppTheme`, which is why nothing below reads a Material default. That split
/// mirrors what `apps/desktop` already does with Radix (behaviour) and its own tokens
/// (visual).
///
/// No router package and no route table: `MVP.md` settled on screens reached by tapping a
/// row, so `Navigator.push` is the whole story and a declarative router would be vocabulary
/// bought for nothing.
///
/// **There are three levels since 2026-08-11, and the first one is new.** The app used to
/// open on Home, which answered *which project* for itself — from a remembered selection,
/// falling back to whichever project the fleet happened to put first, changeable through a
/// sheet. That is now a fact about the route: the root is the project index, opening a project
/// pushes Home scoped to it, and opening an agent pushes the pager. Three mechanisms went with
/// the change (the memory, the fallback, the sheet), and no capability did.
///
/// **The index deliberately does not restore the last project on launch.** It could, and the
/// stored value existed to. But Pocket is opened to find out whether an agent needs an answer,
/// and that question spans every project — pushing Home over the index at startup would put
/// the other projects' waiting agents behind a back tap, which is the exact failure ADR-3's
/// falsification clause named. Landing on the index answers it in one glance.
class PocketApp extends StatefulWidget {
  const PocketApp({required this.root, this.themeController, super.key});

  final CompositionRoot root;

  /// Which theme and mode; the app makes its own (classic, dark) when none is given.
  final ThemeController? themeController;

  @override
  State<PocketApp> createState() => _PocketAppState();
}

/// Watches the app's own lifecycle, which nothing did before.
///
/// It exists for one rule: **proof of presence does not survive the app leaving the
/// foreground.** `BiometricGate` lets a proof stand for a few minutes so answering an
/// agent is a conversation rather than a queue of fingerprint prompts — and the event
/// that bound is really about is not the clock, it is the phone being handed over,
/// pocketed, or taken. So the window is dropped here, and the timer is only the
/// backstop for a phone left unlocked with Pocket open.
///
/// **`inactive` deliberately does not count**, and that was found the hard way. The OS
/// biometric sheet takes focus from the app while it is up, which Flutter reports as
/// `inactive` — so clearing on it meant every proof was thrown away moments after it was
/// given, and the gate prompted on every single message exactly as before. Measured on a
/// real phone 2026-08-07: two dispatches 2m32s apart, both prompting, with
/// `Changing focus from Window{BiometricPrompt} to Window{com.serayu.lotus_pocket}` in
/// between. The emulator never showed it, because a device with no lock never opens a
/// sheet at all.
///
/// `paused` is the state that means what this rule is about: the app is in the
/// background and another app is in front of it. What is given up is the iOS case of
/// peeking at the task switcher and coming straight back — and nobody can act in Pocket
/// from there anyway.
///
/// This is the same fact `local_auth`'s `persistAcrossBackgrounding: true` exists for:
/// backgrounding caused by our own prompt is not the operator walking away.
class _PocketAppState extends State<PocketApp> with WidgetsBindingObserver {
  /// Assembled here rather than on [CompositionRoot], which sits exactly at the 300-line
  /// ceiling `test/architecture/layering_test.dart` enforces — any field added there
  /// breaks it. This is still the composition layer, and the keeper is stateless and
  /// `const`, so there is nothing a root would be holding for us.
  late final CredentialKeeper _credentials;

  final _navigator = GlobalKey<NavigatorState>();
  final _messenger = GlobalKey<ScaffoldMessengerState>();
  late final WakeRouting _wakes;
  late final ThemeController _theme = widget.themeController ?? ThemeController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _credentials = CredentialKeeper(
      registry: widget.root.registry,
      credentials: widget.root.credentials,
      keys: widget.root.refreshKeys,
    );
    // A cold start is an app open too, and `resumed` is not delivered for one. Deferred
    // by a frame so the biometric sheet has something to sit on top of.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      unawaited(_credentials.refreshDueHosts());
      announceUpdate(_messenger.currentState, widget.root.buildSeen);
    });
    _wakes = WakeRouting(
      messages: root.pushMessages,
      wakes: root.wakes,
      messenger: _messenger,
      open: _openAgent,
    );
  }

  @override
  void dispose() {
    _wakes.dispose();
    if (widget.themeController == null) _theme.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused:
      case AppLifecycleState.hidden:
      case AppLifecycleState.detached:
        widget.root.gate.forget();
      case AppLifecycleState.inactive:
        // See the class comment: this is what the biometric sheet itself produces.
        break;
      case AppLifecycleState.resumed:
        // The credential first, because it is the only thing here that expires. See
        // `CredentialKeeper`: the 2026-08-05 addendum promised a renewal "saat app
        // dibuka" and nothing ever opened that window, so a token could only ever be
        // renewed by dispatching — and an operator who only read for three days met a
        // re-pair instead.
        unawaited(_credentials.refreshDueHosts());
        // Proof of presence stays dropped — the next mutation asks, which is the
        // point. What *is* restored is the picture of each machine: a socket that
        // survived backgrounding says no `hello` on the way back, and `projects[]`
        // rides only on `GET /m/bootstrap` (see `FleetRepository`). Without this,
        // a project opened on the desktop while the phone was in a pocket stayed
        // invisible until the app was killed.
        unawaited(widget.root.fleetRepository.hydrate());
    }
  }

  CompositionRoot get root => widget.root;

  @override
  Widget build(BuildContext context) {
    return ThemedApp(controller: _theme, builder: _app);
  }

  Widget _app(ThemeData theme, ThemeData darkTheme, ThemeMode mode) {
    return MaterialApp(
      navigatorKey: _navigator,
      scaffoldMessengerKey: _messenger,
      title: 'Lotus Pocket',
      theme: theme,
      darkTheme: darkTheme,
      themeMode: mode,
      // The banner covers the corner where the project title lives.
      debugShowCheckedModeBanner: false,
      // Which screen the app opens on is a question about **stored credentials**, so
      // it is asked of the thing that holds them rather than tracked as a second flag
      // that could disagree. Pairing calls `Credentials.remember`, which notifies —
      // so the swap to Home is the same rebuild that stores the token, and unpairing
      // the last host would return here by the same path.
      home: LaunchShell(
        credentials: root.credentials,
        introSeen: root.introSeen,
        pairing: (_) => _onboarding(),
        projects: (_) => _projects(),
      ),
    );
  }

  Widget _onboarding() => OnboardingScreen(
        pairing: root.pairing,
        // The seam becomes a plain builder here, which is the whole point: `features/`
        // gets a way to draw a camera and never a type it could reach the plugin
        // through (ADR-13 no. 1).
        scanner: root.scanner.view,
        // A newly paired host has a socket but no cells: `StreamHub.attach` sends
        // `hello` and nothing else, and `fleet.changed` is only broadcast when the
        // host's poll sees a change. Without this, Home would sit empty after a
        // successful pairing until something on the machine happened to move.
        //
        // `push.start()` runs again for the host that just joined: it did not exist
        // when the app booted, so it has not been told where to ring. Re-running is
        // cheap — FCM returns the same token, and the host skips a write for a value
        // it already holds.
        onPaired: () {
          unawaited(root.fleetRepository.hydrate());
          unawaited(root.push.start());
        },
      );

  Widget _projects() => Builder(
        builder: (context) => ProjectsRoute(
          registry: root.registry,
          fleet: root.fleet,
          hostLabel: root.hostLabel,
          onOpenProject: (project) => _openProject(context, project),
          // Straight to the agent, skipping the project it lives in. That shortcut is why a
          // level could be added at all: the thing an operator opens Pocket for is still one
          // tap from the first screen.
          onOpenAgent: _openAgent,
          onOpenDiagnostics: () => _openDiagnostics(context),
          // Re-dial, then re-read. `app/` owns the wiring and `data/` owns the order
          // the two happen in — this is the seam, not a third opinion about either.
          onRefresh: root.fleetRepository.refreshAll,
          onAddProject: (choice) => _addProject(context, choice),
        ),
      );

  /// Two ways in, each with its own capability behind it — a row for one the machine does
  /// not advertise is never drawn (`add_project.dart`).
  Future<void> _addProject(BuildContext context, AddProjectChoice choice) async {
    if (choice.door == AddProjectDoor.browse) {
      await showBrowseFolder(
        context,
        projects: root.projects,
        host: choice.target.host,
        machine: choice.host,
        onArrived: root.fleetRepository.refreshAll,
      );
      return;
    }
    final ask = await showCloneForm(context, machine: choice.host);
    if (ask == null || !context.mounted) return;
    await startCloneAndWatch(
      context,
      projects: root.projects,
      host: choice.target.host,
      machine: choice.host,
      ask: ask,
      // The registry re-scans on every read, so the project exists the moment the clone
      // lands — what the phone still needs is to ask again (`issues/05`).
      onArrived: root.fleetRepository.refreshAll,
    );
  }

  /// Pushes Home, scoped to one project.
  ///
  /// The [ProjectRef] travels rather than a name: two machines can each run a `CNVS`, and a
  /// name alone would open one operator's project on the other's machine (R-10).
  ///
  /// [startAgent] opens it already choosing a runner — the pager's `New` from a pager that
  /// was not opened from this Home (index, wake-up), so there is no Home underneath to ask.
  void _openProject(BuildContext context, ProjectRef project, {bool startAgent = false}) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (context) => HomeScreen(
          fleet: root.fleet,
          project: project,
          hostLabel: root.hostLabel,
          startAgent: startAgent,
          onOpenCell: _showAgent,
          onBack: () => Navigator.of(context).pop(),
          onRefresh: root.fleetRepository.refreshAll,
          seen: root.seenMarks,
          // The same repository the Agent page gets: a dispatch from Home is not a
          // different kind of dispatch, and there is one path that runs the gate.
          agents: root.agents,
          dictation: root.dictation,
        ),
      ),
    );
  }

  /// Pushes Diagnostics. The wiring lives in its own file — see `diagnostics_route.dart`
  /// for why the two routes there belong together.
  void _openDiagnostics(BuildContext context) => openDiagnostics(context, root);

  /// Opens the agent pager — from Home's list, the index's `needs you` block, or a
  /// wake-up. From the last two nothing underneath can start an agent, so the pager's
  /// `New` (v4 tiket 08) opens the project's Home already choosing one.
  void _openAgent(Cell cell) => unawaited(() async {
        final startAgent = await _showAgent(cell);
        final navigator = _navigator.currentState;
        if (!startAgent || navigator == null || !navigator.mounted) return;
        // `Navigator.of` on the navigator's own context answers that navigator.
        _openProject(navigator.context, cell.project, startAgent: true);
      }());

  /// Home's way in: it answers `New` itself — see `agent_route.dart`.
  Future<bool> _showAgent(Cell cell) => showAgentPager(_navigator.currentState, root, cell);
}
