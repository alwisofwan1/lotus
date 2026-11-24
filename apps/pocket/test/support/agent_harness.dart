import 'package:lotus_pocket/data/agent_repository.dart';
import 'package:lotus_pocket/data/live_conversation.dart';
import 'package:lotus_pocket/data/output_buffer.dart';
import 'package:lotus_pocket/data/project_repository.dart';
import 'package:lotus_pocket/data/snippets.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/hosts/paired_host.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';

import 'fake_security.dart';
import 'fake_transport.dart';

/// A real [AgentRepository] over fake seams — the graph `app/` builds, in a test.
///
/// Every screen that can mutate goes through this repository, because that is where the
/// biometric gate and the credential freshness check live (ADR-8, ADR-12 no. 2). So a
/// test must not substitute a fake repository: it would be testing a path production
/// does not have. What is faked is the **transport and the lock** — the two things a
/// test cannot have — and everything above them is the code that ships.
///
/// Written when Home gained a composer and needed the same wiring the Agent page tests
/// already had. Two copies of forty lines of graph-building is two places for it to
/// drift from the composition root.
class AgentHarness {
  AgentHarness._({
    required this.http,
    required this.biometrics,
    required this.credentials,
    required this.registry,
    required this.output,
    required this.snippets,
    required this.live,
    required this.repository,
    required this.now,
  });

  final FakeHttpTransport http;
  final FakeBiometrics biometrics;
  final Credentials credentials;
  final HostRegistry registry;
  final OutputBuffer output;

  /// Kept lines, over the same in-memory store the credentials use.
  final Snippets snippets;

  /// Chat's transcript, fed from the same merged stream the composition root uses.
  final LiveConversation live;

  final AgentRepository repository;

  /// The other repository built on the same seams — same gate, same credentials.
  ProjectRepository get projects => ProjectRepository(
        registry: registry,
        credentials: credentials,
        gate: BiometricGate(biometrics),
      );
  final DateTime now;

  /// Builds the graph and pairs [hosts], so a dispatch has a credential to carry.
  ///
  /// Async because storing a credential is: `Credentials.remember` writes before it
  /// updates memory, so that a token live in RAM but never persisted cannot exist.
  static Future<AgentHarness> paired({
    List<HostId> hosts = const [HostId('mac')],
    DateTime? at,
  }) async {
    final now = at ?? DateTime.utc(2026, 8, 6, 12);
    final http = FakeHttpTransport();
    final biometrics = FakeBiometrics();
    final store = InMemorySecureStore();
    final credentials = Credentials(
      store: store,
      now: () => now,
      gate: BiometricGate(biometrics),
    );
    final registry = HostRegistry(
      transport: FakeTransport(),
      httpTransport: http,
      tokenReader: credentials.tokenFor,
      sleep: (_) async {},
    );
    final output = OutputBuffer(registry.events);
    final live = LiveConversation(registry.events);

    final harness = AgentHarness._(
      http: http,
      biometrics: biometrics,
      credentials: credentials,
      registry: registry,
      output: output,
      snippets: Snippets(store),
      live: live,
      repository: AgentRepository(
        registry: registry,
        credentials: credentials,
        gate: BiometricGate(biometrics),
        output: output,
      ),
      now: now,
    );

    for (final host in hosts) {
      harness.registry.add(harness.host(host));
      await harness.pair(host);
    }
    return harness;
  }

  /// A host as the registry knows it. Default caps carry the Chat routes; a standalone
  /// host is asked for explicitly, because that difference decides what a screen draws.
  PairedHost host(
    HostId id, {
    List<String>? features,
    String mode = 'client',
  }) =>
      PairedHost(
        id: id,
        label: id.value,
        baseUri: Uri.parse('http://${id.value}:9877'),
        mode: mode,
        caps: HostCaps(
          protocol: 1,
          features: features ?? const ['fleet', 'dispatch', 'transcript', 'permission'],
        ),
      );

  /// Stores a credential for [id] — without one, every mutation answers
  /// `MutationNeedsPairing` before it ever reaches the gate.
  Future<void> pair(HostId id) => credentials.remember(PairedDevice(
        deviceToken: 'tok-${id.value}',
        deviceId: 'dev_${id.value}',
        expiresAt: now.add(const Duration(hours: 72)),
        hardExpiresAt: now.add(const Duration(days: 30)),
        hostId: id,
        hostLabel: id.value,
        mode: 'client',
        caps: const HostCaps(protocol: 1, features: ['fleet']),
        baseUri: Uri.parse('http://${id.value}:9877'),
      ));

  void dispose() {
    live.dispose();
    output.dispose();
    registry.dispose();
    credentials.dispose();
  }
}
