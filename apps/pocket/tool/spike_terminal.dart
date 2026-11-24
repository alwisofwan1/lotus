// `issues/03` — is `xterm.dart` enough for Lotus PTY output, and does that output read
// on a palm-sized screen?
//
// A throwaway artifact, as the ticket asks: it lives in `tool/`, not `lib/`, so it is
// outside the layering the app proper obeys. What it deliberately does NOT do is invent
// its own transport — it drives `HostSocket`, the same class the app uses, so the answer
// is about rendering rather than about a parallel implementation.
//
//   flutter run -d web-server --web-port 8099 -t tool/spike_terminal.dart
//   then open http://127.0.0.1:8099/?host=127.0.0.1:8787&token=<t>&pane=<paneId>
//
// The query parameters exist because Flutter web paints into a canvas: there are no DOM
// inputs for a driver to type into, so a scripted run (or a screenshot harness) needs the
// configuration in the URL. Typing by hand still works too.
//
// Only the WebSocket is used. `/m/bootstrap` needs an Authorization header, which a
// browser cannot send cross-origin — so the paneId is typed in rather than discovered.

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import 'package:lotus_pocket/core/host_socket.dart';
import 'package:lotus_pocket/core/ws_transport.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/server_event.dart';

void main() => runApp(const SpikeApp());

class SpikeApp extends StatelessWidget {
  const SpikeApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Lotus terminal spike',
        debugShowCheckedModeBanner: false,
        theme: ThemeData.dark(useMaterial3: true),
        home: const SpikeScreen(),
      );
}

class SpikeScreen extends StatefulWidget {
  const SpikeScreen({super.key});

  @override
  State<SpikeScreen> createState() => _SpikeScreenState();
}

class _SpikeScreenState extends State<SpikeScreen> {
  /// 5000 lines of scrollback is far more than the host can even offer (its ring is
  /// 64 KB), so nothing is lost to this number.
  final Terminal terminal = Terminal(maxLines: 5000);

  final TextEditingController _host = TextEditingController(text: '127.0.0.1:8787');
  final TextEditingController _token = TextEditingController();
  final TextEditingController _pane = TextEditingController();

  HostSocket? _socket;
  String _state = 'idle';
  bool _autoStarted = false;

  /// Font size, overridable from the URL.
  ///
  /// It exists because of what this spike found: a full-screen TUI addresses the
  /// cursor absolutely, so its bytes only mean what they say at the width they were
  /// drawn for (measured: 93 columns). Shrinking the font until 93 columns fit is how
  /// the two candidate causes — "the library cannot render this" versus "the geometry
  /// does not match" — are told apart.
  double _font = 11;

  /// Host geometry, when known. Setting it turns off `autoResize` and pins the
  /// emulator to the PTY's own size — the fix the research pointed at, since
  /// `Terminal.resize` resizes the **alternate** buffer too, which is the one a
  /// full-screen TUI draws into.
  int? _cols;
  int? _rows;
  int _frames = 0;
  int _bytes = 0;

  @override
  void initState() {
    super.initState();
    final params = Uri.base.queryParameters;
    if (params['host'] != null) _host.text = params['host']!;
    if (params['token'] != null) _token.text = params['token']!;
    if (params['pane'] != null) _pane.text = params['pane']!;
    _font = double.tryParse(params['font'] ?? '') ?? _font;
    _cols = int.tryParse(params['cols'] ?? '');
    _rows = int.tryParse(params['rows'] ?? '');
    final cols = _cols, rows = _rows;
    if (cols != null && rows != null) terminal.resize(cols, rows);
    if (!_autoStarted && _token.text.isNotEmpty) {
      _autoStarted = true;
      // After the first frame, so a failure has somewhere to render.
      WidgetsBinding.instance.addPostFrameCallback((_) => _connect());
    }
  }

  @override
  void dispose() {
    _socket?.dispose();
    _host.dispose();
    _token.dispose();
    _pane.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    _socket?.dispose();
    setState(() {
      _state = 'connecting';
      _frames = 0;
      _bytes = 0;
    });

    final socket = HostSocket(
      host: const HostId('spike'),
      baseUri: Uri.parse('ws://${_host.text.trim()}'),
      token: () => _token.text.trim(),
      transport: const WebSocketTransport(),
      sleep: (d) => Future<void>.delayed(d),
      onConnected: () => setState(() => _state = 'open'),
      onAttemptFailed: (failure) => setState(() => _state = 'failed: ${failure.cause.name}'),
    );
    _socket = socket;

    socket.events.listen((event) {
      switch (event) {
        case HelloEvent(:final hostId, :final mode):
          terminal.write('\x1b[38;5;244m— connected to $hostId ($mode) —\x1b[0m\r\n');
        case CellOutputEvent(:final chunk):
          // The whole question of this spike, in one line: PTY bytes arrive as text and
          // go straight in, ANSI and all. No parsing, no sanitising, no line splitting.
          terminal.write(chunk);
          setState(() {
            _frames += 1;
            _bytes += chunk.length;
          });
        case CellTruncatedEvent(:final missingBytes):
          terminal.write('\r\n\x1b[33m— $missingBytes bytes scrolled out of the ring —\x1b[0m\r\n');
        case FleetChangedEvent() || NotificationEvent() || ConversationFrame() || ConversationTruncatedFrame():
          break;
      }
    });

    await socket.connect();
    final pane = _pane.text.trim();
    if (pane.isNotEmpty) socket.subscribe(pane);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(8),
              child: Column(
                children: [
                  Row(
                    children: [
                      Expanded(child: _field(_host, 'host:port')),
                      const SizedBox(width: 6),
                      Expanded(flex: 2, child: _field(_token, 'device token')),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Row(
                    children: [
                      Expanded(flex: 3, child: _field(_pane, 'paneId')),
                      const SizedBox(width: 6),
                      FilledButton(onPressed: _connect, child: const Text('Connect')),
                    ],
                  ),
                ],
              ),
            ),
            Container(
              width: double.infinity,
              color: Colors.white10,
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              child: Text(
                '$_state · $_frames frames · $_bytes chars · ${terminal.viewWidth}x${terminal.viewHeight} · ${_font.toStringAsFixed(0)}px',
                style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
              ),
            ),
            // The point of the spike: how this reads at phone width.
            Expanded(child: _terminalArea()),
          ],
        ),
      ),
    );
  }

  Widget _terminalArea() {
    final view = TerminalView(
      terminal,
      theme: TerminalThemes.defaultTheme,
      textStyle: TerminalStyle(fontSize: _font, fontFamily: 'monospace'),
      padding: const EdgeInsets.all(6),
      // Read-first (ADR-6): no keyboard, no input path to a live agent from here.
      readOnly: true,
      autoResize: _cols == null,
    );
    final cols = _cols;
    if (cols == null) return view;

    // Pinned geometry needs somewhere to overflow to. 0.97 comes from measuring this
    // spike (font 6 → 67 columns in 390px, font 4 → 101), not from a font metric table.
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: SizedBox(width: cols * _font * 0.97, child: view),
    );
  }

  Widget _field(TextEditingController controller, String label) => TextField(
        controller: controller,
        style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
        decoration: InputDecoration(
          labelText: label,
          isDense: true,
          border: const OutlineInputBorder(),
        ),
      );
}
