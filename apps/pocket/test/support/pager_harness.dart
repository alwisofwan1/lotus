import 'dart:async';

import 'package:lotus_pocket/data/agent_repository.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/data/live_conversation.dart';
import 'package:lotus_pocket/data/output_buffer.dart';
import 'package:lotus_pocket/data/snippets.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/hosts/paired_host.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/notification_event.dart' show HookNotification;
import 'package:lotus_pocket/models/pairing.dart';
import 'package:lotus_pocket/models/server_event.dart';

import 'fake_security.dart';
import 'fake_transport.dart';

/// The graph the **pager** needs, which is a strictly larger one than [AgentHarness]
/// builds.
///
/// Two things it adds, and both are the reason `issues/12` went unnoticed through 686
/// green tests. First a [FleetStore] with more than one cell in it, because a pager with
/// one page has one owner and the defect is about two. Second a [RouteAwareTransport]
/// instead of a queue, because the defect is a race and a queue cannot express which
/// side is slow.
///
/// The event stream is driven by hand rather than by a socket, exactly as
/// `live_transcript_test.dart` drives it: a hook frame is a hook frame regardless of
/// which pipe carried it, and a test that has to fake a WebSocket to assert on a
/// transcript is testing the pipe.
class PagerHarness {
  PagerHarness._({
    required this.http,
    required this.registry,
    required this.credentials,
    required this.output,
    required this.snippets,
    required this.live,
    required this.repository,
    required this.fleet,
    required this.now,
    required this._events,
  });

  final RouteAwareTransport http;
  final HostRegistry registry;
  final Credentials credentials;
  final OutputBuffer output;

  /// Kept lines, over the same in-memory store the credentials use.
  final Snippets snippets;

  final LiveConversation live;
  final AgentRepository repository;
  final FleetStore fleet;
  final DateTime now;

  final StreamController<HostEvent> _events;

  /// Builds the graph and pairs [hosts], so a read carries a credential.
  static Future<PagerHarness> paired({
    List<HostId> hosts = const [HostId('mac')],
    DateTime? at,
    bool canSpawn = false,
  }) async {
    final when = at ?? DateTime.utc(2026, 8, 6, 12);
    final events = StreamController<HostEvent>.broadcast();
    final http = RouteAwareTransport();
    final store = InMemorySecureStore();
    final credentials = Credentials(
      store: store,
      now: () => when,
      gate: BiometricGate(FakeBiometrics()),
    );
    final registry = HostRegistry(
      transport: FakeTransport(),
      httpTransport: http,
      tokenReader: credentials.tokenFor,
      sleep: (_) async {},
    );
    final output = OutputBuffer(events.stream);
    final live = LiveConversation(events.stream);

    final harness = PagerHarness._(
      http: http,
      snippets: Snippets(store),
      registry: registry,
      credentials: credentials,
      output: output,
      live: live,
      repository: AgentRepository(
        registry: registry,
        credentials: credentials,
        gate: BiometricGate(FakeBiometrics()),
        output: output,
      ),
      fleet: FleetStore(events.stream),
      now: when,
      events: events,
    );

    for (final host in hosts) {
      registry.add(harness.hostFor(host, canSpawn: canSpawn));
      await harness.pair(host);
    }
    return harness;
  }

  PairedHost hostFor(HostId id, {bool canSpawn = false}) => PairedHost(
        id: id,
        label: id.value,
        baseUri: Uri.parse('http://${id.value}:9877'),
        mode: 'client',
        caps: HostCaps(
          protocol: 1,
          features: ['fleet', 'dispatch', 'transcript', 'permission', if (canSpawn) 'spawn'],
        ),
      );

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

  /// One host's cells, entire — the same replacement semantics `fleet.changed` has.
  void withCells(HostId host, List<Cell> cells) => fleet.adopt(host, cells);

  /// Pushes one hook frame as the host broadcasts it: snake_case, straight from Rust.
  ///
  /// [toolTarget] is what a test should assert on, not [title]. Two reasons, and both
  /// are about matching what the host really sends: a tool event always carries a
  /// target (`notification_event.rs`), and `StepLine` draws the tool's **name**
  /// lowercased while drawing the target verbatim — so asserting on the title would be
  /// asserting on a typographic rule instead of on the step arriving.
  /// A reply line, which Chat draws (tool steps stay in Terminal).
  void emitReply({String paneId = 'p-1', required String body}) =>
      emitHook(paneId: paneId, event: 'agent-response', title: '', toolTarget: '', body: body);

  void emitHook({
    HostId host = const HostId('mac'),
    String paneId = 'p-1',
    String title = 'Grep',
    String event = 'tool-pre',
    String body = '',
    required String toolTarget,
    int at = 1785664900000,
  }) =>
      _events.add((
        host,
        NotificationEvent(
          hook: HookNotification.fromJson({
            'kind': 'agent_stop',
            'timestamp': at,
            'pane_id': paneId,
            'agent_type': 'claude',
            'event': event,
            'tool_target': toolTarget,
            'title': title,
            'body': body,
            'status': 'running',
            'body_truncated': false,
          }),
        ),
      ));

  /// One PTY chunk as the host streams it. Only the buffer's current tail keeps it.
  void emitOutput(String chunk, {HostId host = const HostId('mac'), String paneId = 'p-1'}) =>
      _events.add((host, CellOutputEvent(paneId: paneId, chunk: chunk, byteOffset: 0)));

  void dispose() {
    fleet.dispose();
    live.dispose();
    output.dispose();
    registry.dispose();
    credentials.dispose();
    _events.close();
  }
}

/// A cell in the shape Home hands the pager. Everything quiet by default, so
/// `FleetStore`'s order is pane id and a test's fleet reads in the order it is written.
Cell pagerCell(
  String paneId,
  String title, {
  HostId host = const HostId('mac'),
  String project = 'CNVS',
}) =>
    Cell(
      host: host,
      paneId: paneId,
      workspaceId: project,
      workspaceLabel: project,
      agentType: 'claude',
      title: title,
      status: 'live',
      isAlive: true,
      turn: 'running',
    );
