// Home and the Agent page, on a fixed fleet, with no machine to pair with.
//
//   bun run pocket:dev            # this file, on the emulator, with hot reload
//
// It imports the app's own `HomeScreen`, `AgentScreen`, `FleetStore` and `buildAppTheme` —
// nothing is reimplemented, so what appears is what ships. Only the **network** is
// invented: `KeychainStore` and `DeviceBiometrics` are the real ones, so tapping through a
// dispatch here exercises the Android Keystore and the biometric gate for real. Those two
// are the only files in `lib/` that no unit test can reach.
//
// The gate's behaviour on a fresh emulator is worth knowing before it surprises you: with
// no lock configured, `DeviceBiometrics.canPrompt` is false and `BiometricGate` returns
// `grantedWithoutLock` — the exception ADR-12 no. 4 names out loud, so the dispatch
// proceeds without a prompt. Configure a screen lock and enrol a fingerprint
// (`adb emu finger touch 1`) to see the prompt itself.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lotus_pocket/models/app_build.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/core/device_biometrics.dart';
import 'package:lotus_pocket/core/keychain_store.dart';
import 'package:lotus_pocket/core/push_tokens.dart';
import 'package:lotus_pocket/data/agent_repository.dart';
import 'package:lotus_pocket/data/diagnostics.dart';
import 'package:lotus_pocket/data/fleet_repository.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/data/live_conversation.dart';
import 'package:lotus_pocket/data/transcript_pager.dart';
import 'package:lotus_pocket/data/measurement_log.dart';
import 'package:lotus_pocket/data/snippets.dart';
import 'package:lotus_pocket/data/output_buffer.dart';
import 'package:lotus_pocket/data/pairing_repository.dart';
import 'package:lotus_pocket/data/push_repository.dart';
import 'package:lotus_pocket/data/readdress_outcome.dart';
import 'package:lotus_pocket/features/agent/agent_screen.dart';
import 'package:lotus_pocket/features/home/home_screen.dart';
import 'package:lotus_pocket/features/home/projects_screen.dart';
import 'package:lotus_pocket/features/onboarding/onboarding_screen.dart';
import 'package:lotus_pocket/features/settings/settings_screen.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/hosts/paired_host.dart';
import 'package:lotus_pocket/models/bootstrap.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';
import 'package:lotus_pocket/models/server_event.dart';
import 'package:lotus_pocket/data/draft_keeper.dart';

import 'preview_host.dart';

/// The ids a **real** host sends, not the mockup's invented `mac` / `vps`.
///
/// A desktop identifies itself by machine hostname — measured 2026-08-06:
/// `Alwis-MacBook-Air.local`. Keeping the short forms here is what let the Agent
/// header's corner squeeze the persona to `A...` without any preview showing it. One
/// long and one short on purpose, so both cases are on screen at once.
const HostId mac = HostId('Alwis-MacBook-Air.local');
const HostId vps = HostId('vps-frankfurt');

/// `close` and `spawn` are here so the row drawer and the composer's new-agent mode are
/// on screen at all. They are **desktop-only** capabilities, and the standalone caps
/// below deliberately lack them — swipe to Nora's project to see the same drawer with
/// no Close in it, which is the rule ADR-14 states rather than a bug.
const HostCaps _fullCaps = HostCaps(
  protocol: 1,
  features: [
    'fleet',
    'dispatch',
    'stop',
    'stream',
    'transcript',
    'permission',
    'close',
    'spawn',
  ],
);

/// A Standalone Host: no hook pipeline, so the Agent page must draw Terminal only and say
/// why (§7 no. 10). Swipe to Nora to see that branch.
const HostCaps _standaloneCaps = HostCaps(
  protocol: 1,
  features: ['fleet', 'dispatch', 'stop', 'stream'],
);

Cell _cell(
  HostId host,
  String paneId, {
  required String title,
  required String workspace,
  String agentType = 'claude',
  String? turn,
  int? turnAgeMs,
  String? gating,
  String? preview,
}) =>
    Cell(
      host: host,
      paneId: paneId,
      // What production actually sends: an opaque canvas id, **no** `workspaceLabel`,
      // and the readable name only in `cwd`. This preview used to set the label to the
      // project name, which meant nothing here ever exercised the fallback every real
      // cell depends on — and so the opaque id was never once seen on screen.
      workspaceId: 'canvas:cp_${workspace.toLowerCase()}',
      workspaceLabel: null,
      cwd: '/Users/alwisofwan/workspace/experiments/$workspace',
      agentType: agentType,
      title: title,
      status: 'live',
      isAlive: true,
      turn: turn,
      turnAgeMs: turnAgeMs,
      gating: gating,
      lastOutputPreview: preview,
    );

/// The fleet from `design/pocket-flow.html` screen 02.
///
/// CNVS sits on `mac` rather than the mockup's `vps` for a reason worth seeing:
/// `FleetStore` breaks a tie between two waiting cells by host id, so this is what makes
/// CNVS the project Home opens on — the ordering rule working, not a preview cheat.
final List<Cell> _cnvsOnMac = [
  _cell(mac, 'p-1',
      title: 'Atlas',
      workspace: 'CNVS',
      turn: 'needs-input',
      turnAgeMs: 120000,
      preview: 'Delete src/legacy/shim.ts?'),
  _cell(mac, 'p-2',
      title: 'Chess',
      workspace: 'CNVS',
      turn: 'running',
      turnAgeMs: 45000,
      preview: '6 of 13 suites'),
  _cell(mac, 'p-3',
      title: 'Koda',
      workspace: 'CNVS',
      agentType: 'codex',
      gating: Cell.gatingRunnerCannot,
      turnAgeMs: 240000),
];

/// One waiting agent in another project, so the `elsewhere` row is on screen — the row
/// that carries a security property rather than a convenience one (ADR-3).
final List<Cell> _lotusOnVps = [
  _cell(vps, 'p-9',
      title: 'Nora',
      workspace: 'Lotus',
      turn: 'needs-input',
      turnAgeMs: 30000,
      preview: 'Run the migration against prod?'),
];

/// The two rows that make the switcher worth opening, and neither can be seen from
/// Home itself.
///
/// `CNVS` again, on the other machine: same name, different repository, and the sheet
/// is where R-10 stops being an abstraction — two entries, told apart by the host.
/// `orbit` has every agent reporting `idle`, which is the one silence a row is
/// allowed to name (a `codex` cell reports no turn at all and shows its count instead;
/// Koda above is that case).
final List<Cell> _cnvsOnVps = [
  _cell(vps, 'p-4', title: 'Rune', workspace: 'CNVS', turn: 'running', turnAgeMs: 90000),
];

final List<Cell> _orbitOnMac = [
  _cell(mac, 'p-5', title: 'Vela', workspace: 'orbit', turn: 'idle', turnAgeMs: 900000),
  _cell(mac, 'p-6', title: 'Bram', workspace: 'orbit', turn: 'idle', turnAgeMs: 600000),
];

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final http = PreviewHttpTransport();
  // The real Keystore and the real gate. Only the network above is a stand-in.
  final credentials = Credentials(
    store: const KeychainStore(),
    now: DateTime.now,
    gate: BiometricGate(DeviceBiometrics()),
  );
  await credentials.load();

  final registry = HostRegistry(
    transport: const SilentTransport(),
    httpTransport: http,
    tokenReader: credentials.tokenFor,
    sleep: (d) => Future<void>.delayed(d),
  );

  for (final entry in {mac: _fullCaps, vps: _standaloneCaps}.entries) {
    registry.add(PairedHost(
      id: entry.key,
      label: entry.key.value,
      baseUri: Uri.parse('http://${entry.key.value}.preview:9877'),
      mode: entry.value == _standaloneCaps ? 'standalone' : 'client',
      caps: entry.value,
    ));
    // A credential has to exist or every mutation answers `MutationNeedsPairing` before it
    // reaches the gate. Written through the real store, which is the point.
    await credentials.remember(PairedDevice(
      deviceToken: 'preview-${entry.key.value}',
      deviceId: 'dev_preview',
      expiresAt: DateTime.now().add(const Duration(hours: 72)),
      hardExpiresAt: DateTime.now().add(const Duration(days: 30)),
      hostId: entry.key,
      hostLabel: entry.key.value,
      mode: 'client',
      caps: entry.value,
      baseUri: Uri.parse('http://${entry.key.value}.preview:9877'),
    ));
  }

  final events = StreamController<HostEvent>.broadcast();
  final fleet = FleetStore(events.stream);
  // What a real desktop advertises since `spawn-tuning` (2026-08-27), so the summon
  // sheet's second step is on screen here: claude with its aliases and `--effort` scale,
  // codex with six account models (the case that made the model pill scroll), and a
  // custom runner with nothing to tune — one tap, no second step.
  fleet.adoptRunners(mac, const [
    HostRunner(
      id: 'claude',
      name: 'Claude Code',
      gates: true,
      models: [
        RunnerModel(id: 'opus', label: 'opus'),
        RunnerModel(id: 'sonnet', label: 'sonnet', isDefault: true),
        RunnerModel(id: 'haiku', label: 'haiku'),
      ],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    ),
    HostRunner(
      id: 'codex',
      name: 'Codex',
      gates: false,
      models: [
        RunnerModel(id: 'gpt-5.6-sol', label: '5.6-sol', isDefault: true),
        RunnerModel(id: 'gpt-5.6-terra', label: '5.6-terra'),
        RunnerModel(id: 'gpt-5.6-luna', label: '5.6-luna'),
        RunnerModel(id: 'gpt-5.5', label: '5.5'),
        RunnerModel(id: 'gpt-5.4', label: '5.4'),
        RunnerModel(id: 'gpt-5.4-mini', label: '5.4-mini'),
      ],
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    ),
    HostRunner(id: 'custom-acme', name: 'acme', gates: true),
  ]);
  // Fed from the same controller as the fleet, **not** from `registry.events`.
  //
  // Production wires it to the registry, whose stream is filled by sockets. This preview has
  // no socket (see `SilentTransport`), so the controller below is what stands in for that
  // merged stream — wiring it to the registry instead left the terminal permanently empty,
  // which is exactly how this was found.
  final output = OutputBuffer(events.stream);
  // Same controller as the fleet and the terminal, for the same reason: this preview
  // has no socket, so it is what stands in for the registry's merged stream.
  final live = LiveConversation(events.stream);

  // The one screen here that is **not** invented data: `Diagnostics` reads the registry
  // and the credentials this file just filled for real, so the runways it prints are the
  // ones the real Keystore holds, and `reach` is what `SilentTransport` actually did.
  final push = PushRepository(tokens: const UnavailablePushTokens(), registry: registry);
  final pairing = PairingRepository(
    credentials: credentials,
    registry: registry,
    transport: http,
    snippets: const Snippets(KeychainStore()),
    // Real, like the credentials above: unpairing from this preview's Diagnostics
    // clears the same store the app would.
    fleet: fleet,
  );

  runApp(_Preview(
    pairing: pairing,
    fleet: fleet,
    repository: AgentRepository(
      registry: registry,
      credentials: credentials,
      gate: BiometricGate(DeviceBiometrics()),
      output: output,
    ),
    hostLabel: (h) => registry.statusOf(h)?.host.label ?? h.value,
    live: live,
    diagnostics: () => Diagnostics.of(
      registry: registry,
      credentials: credentials,
      push: push,
      now: DateTime.now(),
    ),
    revision: Listenable.merge([registry, credentials]),
    // The real path, including the revoke that `SilentTransport` will fail: unpairing here
    // really does delete the Keystore entry, so the host is gone until the preview is
    // restarted. That is the behaviour being previewed, not a leak.
    onUnpair: pairing.unpair,
    onReaddress: (host, address) => pairing.readdress(host: host, address: address),
    // The real path too: renaming a machine here writes to the Keystore entry the
    // preview paired, which is exactly what makes the label change on Home behind it.
    onRename: pairing.rename,
  ));

  // After the first frame, as a real snapshot would arrive.
  Future<void>.delayed(const Duration(milliseconds: 120), () {
    events.add((mac, FleetChangedEvent(cells: [..._cnvsOnMac, ..._orbitOnMac])));
    events.add((vps, FleetChangedEvent(cells: [..._lotusOnVps, ..._cnvsOnVps])));
    _streamPtyOutput(events);
  });
}

/// Feeds Terminal mode the kind of bytes it will actually meet.
///
/// Repeated on a timer, and that is not laziness — it stands in for something the real host
/// does that this preview cannot: on `subscribe`, the host **replays its 64 KB ring buffer**,
/// so bytes arrive right after Terminal mode is entered. Here there is no socket, and
/// `OutputBuffer` correctly holds nothing until a pane is being watched — so a single push at
/// startup lands before anyone is listening and is dropped. Re-pushing means the frame shows
/// up shortly after the operator opens Terminal, which is the behaviour being previewed.
///
/// Not decoration: `issues/03` found that agent output is a **TUI** — alternate screen,
/// absolute cursor addressing, colour — not a stream of lines, and that a terminal narrower
/// than the PTY renders it as overlapping nonsense. So the preview draws at 93 columns, the
/// width measured from a real Claude Code session, which is the case worth looking at.
void _streamPtyOutput(StreamController<HostEvent> events) {
  Timer.periodic(const Duration(seconds: 2), (_) => _pushFrame(events));
  _pushFrame(events);
}

int _offset = 0;

void _pushFrame(StreamController<HostEvent> events) {
  const esc = '\x1b';

  void push(String chunk) {
    _offset += chunk.length;
    events.add((mac, CellOutputEvent(paneId: 'p-1', chunk: chunk, byteOffset: _offset)));
  }

  // Enter the alternate screen and draw a box at column 1, then text addressed well to the
  // right of a 390px phone's own column count — the overlap case, if the width were wrong.
  push('$esc[?1049h$esc[2J$esc[H');
  push('$esc[1;36m┌${'─' * 91}┐$esc[0m\r\n');
  push('$esc[1;36m│$esc[0m $esc[1mClaude Code$esc[0m  '
      '$esc[2mv2.1.221$esc[0m${' ' * 26}'
      '$esc[33mesc$esc[0m $esc[2mto interrupt$esc[0m${' ' * 20}'
      '$esc[1;36m│$esc[0m\r\n');
  push('$esc[1;36m└${'─' * 91}┘$esc[0m\r\n\r\n');
  push('  $esc[32m✓$esc[0m  Read $esc[1msrc/legacy/shim.ts$esc[0m '
      '$esc[2m(34 lines)$esc[0m\r\n');
  push('  $esc[32m✓$esc[0m  Grep $esc[1mTODO$esc[0m in src/ '
      '$esc[2m(0 matches)$esc[0m\r\n\r\n');
  push('$esc[33m Do you want to delete src/legacy/shim.ts?$esc[0m\r\n');
  push('   $esc[7m 1. Yes $esc[0m\r\n');
  push('   2. Yes, allow all edits during this session $esc[2m(shift+tab)$esc[0m\r\n');
  push('   3. No\r\n');

  // Cursor addressed absolutely to column 78 — past a phone's own width, and the exact thing
  // that turns to nonsense if the emulator is narrower than the host.
  push('$esc[2;78H$esc[35m● live$esc[0m');
}

class _Preview extends StatelessWidget {
  const _Preview({
    required this.fleet,
    required this.repository,
    required this.hostLabel,
    required this.live,
    required this.diagnostics,
    required this.revision,
    required this.onUnpair,
    required this.onReaddress,
    required this.onRename,
    required this.pairing,
  });

  final FleetStore fleet;
  final AgentRepository repository;
  final String Function(HostId) hostLabel;
  final LiveConversation live;
  final Diagnostics Function() diagnostics;
  final Listenable revision;
  final Future<void> Function(HostId) onUnpair;
  final Future<ReaddressOutcome> Function(HostId, String) onReaddress;
  final Future<void> Function(HostId, String?) onRename;

  /// Real, like the credentials: pairing a second machine from this preview writes to
  /// the same Keystore the app uses.
  final PairingRepository pairing;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Lotus Pocket · preview',
      theme: buildAppTheme(),
      debugShowCheckedModeBanner: false,
      // Akar yang sama seperti aplikasinya: indeks project, lalu Home yang tercakup.
      // Preview ini ada untuk dilihat, jadi ia harus punya IA yang sama — sebuah preview
      // yang membuka satu layar lebih dalam akan menyembunyikan tepat perubahan yang
      // paling ingin dilihat.
      home: Builder(
        builder: (context) => ProjectsScreen(
          fleet: fleet,
          hostLabel: hostLabel,
          onOpenProject: (project) => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (context) => HomeScreen(
                fleet: fleet,
                project: project,
                hostLabel: hostLabel,
                agents: repository,
                onRefresh: _refresh,
                onBack: () => Navigator.of(context).pop(),
                onOpenCell: (cell) async {
                  _openAgent(context, cell);
                  return false;
                },
              ),
            ),
          ),
          onOpenAgent: (cell) => _openAgent(context, cell),
          onOpenDiagnostics: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => SettingsScreen(
                read: diagnostics,
                revision: revision,
                onUnpair: onUnpair,
                onReaddress: onReaddress,
                onRename: onRename,
                // The preview invents the network, not the routing: this is the same
                // screen the app pushes, so the control has to be here too or the
                // preview stops resembling what ships.
                onPairAnother: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => OnboardingScreen(
                      pairing: pairing,
                      onBack: () => Navigator.of(context).pop(),
                      onPaired: () {},
                    ),
                  ),
                ),
                onPairAgain: (address) => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => OnboardingScreen(
                      pairing: pairing,
                      onBack: () => Navigator.of(context).pop(),
                      initialAddress: address,
                      onPaired: () {},
                    ),
                  ),
                ),
                onRefresh: () async {},
                // Fase 0 counting (`issues/01`): the preview has no real socket, so
                // there is nothing for a shared instance to collect — an empty one
                // is the honest stand-in.
                measurements: MeasurementLog(),
                running: const AppBuild(version: '1.0.0', buildNumber: 29850748),
              ),
            ),
          ),
          onRefresh: () async => _refresh(),
        ),
      ),
    );
  }

  /// The preview has no hosts to ask, so this only makes the gesture real enough to look
  /// at: a pause the indicator can be seen during, then a report saying everything
  /// answered. Enough to review the motion and the displacement against the header, which
  /// is what this file is for.
  Future<HydrationReport> _refresh() async {
    await Future<void>.delayed(const Duration(milliseconds: 900));
    return const HydrationReport(answered: [], failed: {});
  }

  void _openAgent(BuildContext context, Cell cell) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => AgentScreen(
          fleet: fleet,
          repository: repository,
          live: live,
          pager: TranscriptPager(fetch: (_, _) async => null),
          snippets: const Snippets(KeychainStore()),
          drafts: DraftKeeper(const KeychainStore()),
          hostLabel: hostLabel,
          initial: cell.ref,
          project: cell.project,
        ),
      ),
    );
  }
}
