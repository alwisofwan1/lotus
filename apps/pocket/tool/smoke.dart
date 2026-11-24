// Proves the app's own code can pair with a live Lotus host and read `/m/stream`.
//
// It imports `models/` and `core/` rather than re-implementing them: a smoke run
// that speaks its own dialect proves the host works and tells you nothing about the
// app. Every frame here is parsed by the same `ServerEvent.fromJson` the phone uses.
//
//   dart run tool/smoke.dart --host 100.64.0.2:8787 --code 12345678
//   dart run tool/smoke.dart --host 100.64.0.2:8787 --token <token> --pane <paneId>
//
// The pairing code comes from the desktop: Settings → CodeCanvas → Mobile Access →
// Generate pairing code. It cannot be minted from here, and that is deliberate — the
// admin channel's secret is generated per run and never written to disk.

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:lotus_pocket/core/host_socket.dart';
import 'package:lotus_pocket/core/ws_transport.dart';
import 'package:lotus_pocket/models/bootstrap.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';
import 'package:lotus_pocket/models/server_event.dart';

/// Status of the last HTTP attempt, so a diagnosis is never invented: an
/// unreachable host and a stale pairing code need different words.
int? _lastStatus;

const String _usage = '''
usage: dart run tool/smoke.dart --host <ip:port> (--code <8 digits> | --token <token>)
                                [--pane <paneId>] [--seconds <n>]
''';

Future<void> main(List<String> argv) async {
  final args = _parse(argv);
  final host = args['host'];
  if (host == null || (args['code'] == null && args['token'] == null)) {
    stderr.writeln(_usage);
    exit(64);
  }
  final seconds = int.tryParse(args['seconds'] ?? '20') ?? 20;
  final report = _Report();

  final PairedDevice? paired;
  final String token;
  if (args['code'] != null) {
    paired = await _pair(host, args['code']!, report);
    if (paired == null) exit(1);
    token = paired.deviceToken;
  } else {
    paired = null;
    token = args['token']!;
    _ok('using the token given on the command line, skipping pairing');
  }

  await _bootstrap(host, token, report);
  await _stream(host, token, args['pane'], seconds, report);

  report.print(token: token, paired: paired);
  exit(report.failed ? 1 : 0);
}

/// `POST /m/pair` — the only route reachable without a bearer.
Future<PairedDevice?> _pair(String host, String code, _Report report) async {
  final body = await _json(
    'POST',
    Uri.parse('http://$host/m/pair'),
    body: {'pairingCode': code, 'deviceName': 'pocket-smoke'},
  );
  if (body == null) {
    if (_lastStatus == 401) {
      _fail('the host rejected the code — pairing codes are single-use and expire');
    }
    report.failed = true;
    return null;
  }

  final device = PairedDevice.fromJson(body, baseUri: Uri.parse('http://$host'));
  _ok('paired with ${device.hostId} (${device.hostLabel}), mode ${device.mode}');
  _ok('token valid until ${device.expiresAt.toLocal()}, hard stop ${device.hardExpiresAt.toLocal()}');
  report.pairing = true;

  // Drift check against the contract, in the direction the fixture cannot see: the
  // fixture proves the host *can* produce a shape, this proves the host in front of
  // us actually does.
  final expected = await _fixtureFeatures();
  final actual = device.caps.features.toSet();
  final missing = expected.difference(actual);
  final extra = actual.difference(expected);
  if (missing.isEmpty && extra.isEmpty) {
    _ok('hostCaps matches contract/fixtures exactly (${actual.length} features)');
  } else {
    if (missing.isNotEmpty) _warn('features in the fixture but not on this host: $missing');
    if (extra.isNotEmpty) _warn('features on this host but not in the fixture: $extra');
    _warn('not necessarily wrong — a standalone host advertises fewer (§7 no. 10)');
  }
  report.caps = actual;
  return device;
}

/// `GET /m/bootstrap` — one round-trip cold start.
Future<void> _bootstrap(String host, String token, _Report report) async {
  final body = await _json('GET', Uri.parse('http://$host/m/bootstrap'), token: token);
  if (body == null) {
    _fail('bootstrap failed');
    report.failed = true;
    return;
  }

  final boot = Bootstrap.fromJson(body);
  report.bootstrapCells = boot.cells.length;
  _ok('bootstrap: ${boot.cells.length} cells, ${boot.workspaces.length} workspaces');
  for (final cell in boot.cells) {
    final turn = cell.turnKnown ? cell.turn : 'unknown';
    _line('  ${cell.ref}  ${cell.title.padRight(12)} ${cell.agentType.padRight(7)} turn=$turn');
  }
  if (boot.cells.any((c) => !c.turnKnown)) {
    _line('  (turn=unknown means the runner never reports one — not "idle")');
  }
}

/// The part that matters: the app's own socket against the real façade.
Future<void> _stream(
  String host,
  String token,
  String? pane,
  int seconds,
  _Report report,
) async {
  final socket = HostSocket(
    host: const HostId('smoke'),
    // `http://`, the same base the HTTP calls above use — **not** a hand-made
    // `ws://`. This tool exists to catch what unit tests cannot, and building the
    // socket URI itself is how it missed the one bug only a live host could show:
    // `HostSocket` was handing an `http://` URI straight to
    // `WebSocketChannel.connect`, which refuses it. Passing what a real paired host
    // carries is what makes this a smoke test rather than a rehearsal.
    baseUri: Uri.parse('http://$host'),
    token: () => token,
    transport: const WebSocketTransport(),
    sleep: (d) => Future<void>.delayed(d),
    onAttemptFailed: (failure) => _fail('connect failed: ${failure.cause.name} — ${failure.reason}'),
  );

  final counts = <String, int>{};
  socket.events.listen((event) {
    final name = switch (event) {
      HelloEvent() => 'hello',
      FleetChangedEvent() => 'fleet.changed',
      CellOutputEvent() => 'cell.output',
      CellTruncatedEvent() => 'cell.truncated',
      NotificationEvent() => 'notification',
      ConversationFrame() => 'conversation',
      ConversationTruncatedFrame() => 'conversation.truncated',
    };
    counts[name] = (counts[name] ?? 0) + 1;
    _describe(event);
  });

  _line('connecting to ws://$host/m/stream …');
  await socket.connect();
  if (!socket.isConnected) {
    report.failed = true;
    return;
  }
  _ok('socket open');
  report.streaming = true;

  if (pane != null) {
    socket.subscribe(pane);
    _ok('subscribed to $pane — output below is the live PTY tail');
  }

  _line('listening for ${seconds}s (Ctrl-C to stop early) …');
  await Future<void>.delayed(Duration(seconds: seconds));
  report.frames = counts;
  socket.dispose();
}

void _describe(ServerEvent event) {
  switch (event) {
    case HelloEvent(:final hostId, :final mode, :final caps):
      _line('← hello        $hostId mode=$mode protocol=${caps.protocol}');
    case FleetChangedEvent(:final cells):
      final waiting = cells.where((c) => c.needsInput).map((c) => c.title);
      _line('← fleet        ${cells.length} cells'
          '${waiting.isEmpty ? '' : ', waiting: ${waiting.join(', ')}'}');
    case CellOutputEvent(:final paneId, :final chunk, :final byteOffset):
      _line('← output       $paneId @$byteOffset ${chunk.length}B');
      stdout.write(chunk);
    case CellTruncatedEvent(:final paneId, :final missingBytes):
      _line('← truncated    $paneId lost ${missingBytes}B (ring buffer moved on)');
    case NotificationEvent(:final hook):
      _line('← notification ${hook.kind} ${hook.status ?? ''} ${hook.toolTarget ?? ''}');
    case ConversationTruncatedFrame(:final paneId):
      _line('← conversation.truncated $paneId');
    case ConversationFrame(:final paneId, :final update):
      _line('← conversation $paneId ${update.runtimeType}');
  }
}

/// Features the committed fixture says a desktop host advertises.
Future<Set<String>> _fixtureFeatures() async {
  final file = File('../../contract/fixtures/stream-hello.json');
  if (!file.existsSync()) return {};
  final json = jsonDecode(await file.readAsString()) as Map<String, Object?>;
  final caps = json['hostCaps']! as Map<String, Object?>;
  return (caps['features']! as List<Object?>).cast<String>().toSet();
}

Future<Map<String, Object?>?> _json(
  String method,
  Uri uri, {
  Map<String, Object?>? body,
  String? token,
}) async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 8);
  try {
    final request = await client.openUrl(method, uri);
    if (token != null) request.headers.set('authorization', 'Bearer $token');
    if (body != null) {
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode(body));
    }
    final response = await request.close();
    _lastStatus = response.statusCode;
    final text = await response.transform(utf8.decoder).join();
    if (response.statusCode >= 400) {
      _fail('${uri.path} → HTTP ${response.statusCode}: ${text.trim()}');
      return null;
    }
    return jsonDecode(text) as Map<String, Object?>;
  } on SocketException catch (error) {
    _lastStatus = null;
    _fail('${uri.path} unreachable: ${error.message}'
        '${error.osError == null ? '' : ' (errno ${error.osError!.errorCode})'}');
    return null;
  } finally {
    client.close(force: true);
  }
}

Map<String, String> _parse(List<String> argv) {
  final args = <String, String>{};
  for (var i = 0; i < argv.length - 1; i += 2) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].substring(2)] = argv[i + 1];
  }
  return args;
}

class _Report {
  bool failed = false;
  bool pairing = false;
  bool streaming = false;
  int? bootstrapCells;
  Set<String> caps = {};
  Map<String, int> frames = {};

  void print({required String token, PairedDevice? paired}) {
    stdout.writeln('\n${'─' * 64}');
    stdout.writeln('what this run proved');
    stdout.writeln('  pairing        ${pairing ? 'yes' : 'skipped or failed'}');
    stdout.writeln('  bootstrap      ${bootstrapCells ?? 'failed'} cells parsed by app models');
    stdout.writeln('  /m/stream      ${streaming ? 'open, frames parsed' : 'never opened'}');
    stdout.writeln('  frames         ${frames.isEmpty ? 'none — was anything happening?' : frames}');
    if (frames.isEmpty && streaming) {
      stdout.writeln('    a quiet fleet sends nothing but hello; run an agent to see more');
    }
    if (paired != null) {
      stdout.writeln('\nfor issues/02 Part B, open on the phone:');
      stdout.writeln('  phone-probe.html#host=<tailnet-ip>:<port>&token=$token');
    }
    stdout.writeln('─' * 64);
  }
}

void _ok(String message) => stdout.writeln('✓ $message');
void _warn(String message) => stdout.writeln('! $message');
void _fail(String message) => stdout.writeln('✗ $message');
void _line(String message) => stdout.writeln('  $message');
