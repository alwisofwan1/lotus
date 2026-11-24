import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/api_failure.dart';
import '../core/host_api.dart';
import '../core/host_socket.dart';
import '../core/transport.dart';
import '../models/host_event.dart';
import '../models/host_id.dart';
import '../models/server_event.dart';
import 'host_failure.dart';
import 'paired_host.dart';

/// Reads the current credential for a host. Injected so a test never needs a
/// keychain, and so refreshing a token is invisible to the socket above (ADR-13).
typedef TokenReader = String Function(HostId host);

/// Whether a host's stored credential is still inside its TTL — `Credentials.isUsable`.
typedef CredentialClock = bool Function(HostId host);

/// Every paired host, and the sockets to them — the one place that opens and closes
/// connections (ADR-13 no. 5).
///
/// Fan-out is client-side by ADR-3: each host serves an identical `/m/*` surface,
/// so joining them is this app's job. The merged stream it exposes is what
/// `FleetStore` listens to.
class HostRegistry extends ChangeNotifier {
  HostRegistry({
    required this.transport,
    required this.httpTransport,
    required TokenReader tokenReader,
    required this.sleep,
    this.tokenStillValid,
  }) : _token = tokenReader;

  /// Lets a refused socket be diagnosed as expired-vs-revoked. Null skips the diagnosis
  /// and leaves the refusal as [HostRefused], which is all a socket alone can know.
  final CredentialClock? tokenStillValid;

  /// Hosts with a [_diagnoseRefusal] in flight, so a retry loop cannot stack them.
  final Set<HostId> _diagnosing = {};

  /// Injected collaborators, visible at the call site (ADR-13 no. 4).
  final Transport transport;

  /// The HTTP half. Held here rather than in `data/` so that a paired host is **one**
  /// thing — socket, API and credential together. Two registries, one per transport,
  /// would be two lists that can disagree about which hosts exist.
  final HttpTransport httpTransport;

  final Sleeper sleep;

  final TokenReader _token;

  final Map<HostId, HostSocket> _sockets = {};
  final Map<HostId, HostApi> _apis = {};
  final Map<HostId, HostStatus> _statuses = {};

  /// Keyed by host rather than a flat list, so re-adding one can cancel exactly its
  /// own subscription. See [add] for why re-adding happens at all.
  final Map<HostId, StreamSubscription<void>> _subscriptions = {};
  final StreamController<HostEvent> _events = StreamController<HostEvent>.broadcast();

  /// Frames from every host, tagged with where they came from.
  Stream<HostEvent> get events => _events.stream;

  List<HostStatus> get statuses => List.unmodifiable(_statuses.values);

  HostStatus? statusOf(HostId host) => _statuses[host];

  Iterable<PairedHost> get hosts => _statuses.values.map((s) => s.host);

  /// Registers a host without connecting. Pairing and connecting stay separate so
  /// onboarding can show a host as known-but-unreachable rather than failing quietly.
  ///
  /// **Safe to call again for a host already here, and that is not a nicety.**
  /// Re-pairing is the ordinary way back in once a token passes the 72-hour TTL or the
  /// 30-day ceiling — `Credentials` keeps the entry precisely so onboarding can name
  /// which host needs a new code. Replacing the maps without retiring what was there
  /// would leave the previous socket reconnecting with the dead token *and* a second
  /// live subscription delivering every frame twice into `FleetStore`.
  void add(PairedHost host) {
    _retire(host.id);
    _statuses[host.id] = HostStatus(host: host);
    _apis[host.id] = HostApi(
      host: host.id,
      baseUri: host.baseUri,
      token: () => _token(host.id),
      transport: httpTransport,
    );
    _sockets[host.id] = HostSocket(
      host: host.id,
      baseUri: host.baseUri,
      token: () => _token(host.id),
      transport: transport,
      sleep: sleep,
      onConnected: () => _markConnected(host.id),
      onAttemptFailed: (failure) {
        _fail(host.id, HostFailure.fromCause(failure.cause));
        if (failure.cause == TransportCause.rejected) unawaited(_diagnoseRefusal(host.id));
      },
    );
    _subscriptions[host.id] = _sockets[host.id]!.events.listen((event) {
      _markConnected(host.id);
      if (event is HelloEvent) _adoptHello(host.id, event);
      if (!_events.isClosed) _events.add((host.id, event));
    });
    notifyListeners();
  }

  /// Drops a host entirely — the operator unpaired it.
  ///
  /// Distinct from the re-pairing path above, which *replaces* these entries: here
  /// they go away, so the app stops listing a machine it no longer has a key to.
  /// The socket is torn down first, because a connection left dialling with a
  /// credential that is about to be deleted would spend its backoff earning 401s.
  void remove(HostId host) {
    _retire(host);
    _apis.remove(host);
    _statuses.remove(host);
    notifyListeners();
  }

  /// Tears down one host's connection, leaving nothing running behind it.
  void _retire(HostId host) {
    unawaited(_subscriptions.remove(host)?.cancel() ?? Future<void>.value());
    _sockets.remove(host)?.dispose();
  }

  /// Tails one pane's PTY output, or detaches with null.
  ///
  /// One tail per connection: the host replaces the previous subscription rather than
  /// adding to it (ADR-10), which is why this takes a pane and not a list. Terminal mode
  /// is the only caller — without it `cell.output` never arrives at all, because a
  /// connection with no subscription is told nothing about panes.
  void subscribe(HostId host, String? paneId) => _sockets[host]?.subscribe(paneId);

  /// The HTTP surface for one host, or null when it was never paired.
  ///
  /// `data/` asks for this rather than building its own: the token reader and the base
  /// URI are already resolved here, and a second construction site is a second place
  /// to get the bearer wrong.
  HostApi? apiFor(HostId host) => _apis[host];

  /// Starts every host at once and returns immediately.
  ///
  /// Deliberately not awaited to completion: a sleeping host retries for as long as
  /// it stays asleep, and awaiting that would hold the whole screen hostage on the
  /// slowest machine (R-11). Progress arrives through [notifyListeners] instead.
  void connectAll() {
    for (final host in _sockets.keys) {
      connect(host);
    }
  }

  /// Begins connecting one host. Failures are reported through the socket's
  /// callbacks — including the ones after the first, since a cause can change while
  /// retrying.
  void connect(HostId host) {
    unawaited(_sockets[host]?.connect() ?? Future<void>.value());
  }

  /// App going to background: close everything on purpose (ADR-13 no. 5). The phone
  /// would kill these anyway, and a socket that claims to be alive while dead is
  /// worse than one that is honestly shut.
  Future<void> closeAll() async {
    for (final socket in _sockets.values) {
      await socket.close();
    }
    for (final id in _statuses.keys) {
      _statuses[id] = _statuses[id]!.copyWith(connected: false);
    }
    notifyListeners();
  }

  /// 401 on a socket or a request. Which of the two failures it is depends on the
  /// clock, not the status code: a token past its 12-hour TTL is expired and asks
  /// for biometrics; one still inside it was revoked and needs a fresh pairing.
  void reportUnauthorized(HostId host, {required bool tokenStillValid}) {
    _fail(host, tokenStillValid ? const CredentialRevoked() : const CredentialExpired());
  }

  /// Asks over HTTP what the refused upgrade could not say: is it the credential?
  ///
  /// Without this a lapsed or revoked token surfaced as [HostRefused] — "something turned
  /// the connection down" — and the operator was never told the one thing that fixes it,
  /// a new pairing code. Only a 401 changes the verdict; a host that answers, or does not
  /// answer at all, leaves [HostRefused] standing, because then it was not the token.
  ///
  /// A dead credential also stops the socket: every further upgrade would be refused the
  /// same way, and the failure it would report is the vaguer one this just replaced.
  Future<void> _diagnoseRefusal(HostId host) async {
    final clock = tokenStillValid;
    final api = _apis[host];
    if (clock == null || api == null || !_diagnosing.add(host)) return;
    try {
      await api.verifyCredential();
    } on HostUnauthorized {
      if (_apis[host] != api) return; // Re-paired or unpaired while this was in flight.
      await _sockets[host]?.close();
      reportUnauthorized(host, tokenStillValid: clock(host));
    } on TransportUnavailable {
      // Down between the two requests — the socket's own retries cover it.
    } on ApiFailure {
      // Answered with something other than a 401: not the credential.
    } finally {
      _diagnosing.remove(host);
    }
  }

  /// Takes the host's current self-description from the frame that always arrives
  /// first. What was advertised at pairing time is only what was true then.
  void _adoptHello(HostId host, HelloEvent hello) {
    final current = _statuses[host];
    if (current == null) return;
    _statuses[host] = current.copyWith(
      host: current.host.withHello(
        label: hello.hostLabel,
        mode: hello.mode,
        caps: hello.caps,
      ),
    );
    notifyListeners();
  }

  void _markConnected(HostId host) {
    final current = _statuses[host];
    if (current == null || (current.connected && current.failure == null)) return;
    _statuses[host] = current.copyWith(connected: true, clearFailure: true);
    notifyListeners();
  }

  void _fail(HostId host, HostFailure failure) {
    final current = _statuses[host];
    if (current == null) return;
    if (current.failure?.code == failure.code && !current.connected) return;
    _statuses[host] = current.copyWith(connected: false, failure: failure);
    notifyListeners();
  }

  @override
  void dispose() {
    for (final subscription in _subscriptions.values) {
      subscription.cancel();
    }
    for (final socket in _sockets.values) {
      socket.dispose();
    }
    _events.close();
    super.dispose();
  }
}
