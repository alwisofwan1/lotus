import 'dart:convert';

import '../models/bootstrap.dart';
import '../models/cell.dart';
import '../models/cell_result.dart';
import '../models/browse.dart';
import '../models/clone_job.dart';
import '../models/conversation.dart';
import '../models/host_id.dart';
import '../models/pairing.dart';
import '../models/permission.dart';
import '../models/transcript.dart';
import '../models/voice.dart';
import 'api_failure.dart';
import 'api_reply.dart';
import 'transport.dart';

part 'host_api_reads.dart';
part 'host_api_renew.dart';
part 'host_api_size.dart';

/// One host's `/m/*` HTTP surface — the twin of `HostSocket`, and the only place in
/// the app that knows the route table (ADR-10).
///
/// Every mutation lives here rather than on the socket, so each one carries its own
/// bearer and lands in the host's audit trail as one request (ADR-8).
class HostApi {
  HostApi({
    required this.host,
    required this.baseUri,
    required String Function() token,
    required this.transport,
  }) : _tokenReader = token;

  final HostId host;

  /// Injected collaborators stay visible at the call site (ADR-13 no. 4).
  final Uri baseUri;
  final HttpTransport transport;

  /// Read per request, never cached: a refresh mid-session must reach the next call.
  final String Function() _tokenReader;

  /// `STT_MAX_BODY_BYTES` on the host — checked here so it fails before a cellular upload.
  static const int sttMaxBodyBytes = 8 * 1024 * 1024;

  /// `POST /m/pair` — the only route reachable without a bearer, and the only call
  /// that does not need a [HostApi]: who the host is arrives *in the reply*.
  static Future<PairedDevice> pair({
    required HttpTransport transport,
    required Uri baseUri,
    required String pairingCode,
    required String deviceName,
    String? refreshKey,
  }) async {
    final json = await _send(
      transport,
      'POST',
      baseUri.replace(pathSegments: const ['m', 'pair']),
      body: {'pairingCode': pairingCode, 'deviceName': deviceName, 'refreshKey': ?refreshKey},
      special: pairingFailure,
    );
    return PairedDevice.fromJson(json, baseUri: baseUri);
  }

  /// Everything a cold start needs from this host, in one round trip. Called per host
  /// in parallel so the slowest machine cannot hold the whole screen (R-11).
  Future<Bootstrap> bootstrap({String? workspaceId}) async {
    final json = await _authed(
      'GET',
      _uri(const ['m', 'bootstrap'],
          query: workspaceId == null ? null : {'workspaceId': workspaceId}),
    );
    final boot = parseShape(() => Bootstrap.fromJson(json));

    // Reject mismatched host identities to prevent dispatch to an unpaired machine (R-10).
    if (boot.hostId != host) {
      throw HostFaulted(
        status: 200,
        reason: 'paired with $host but this address answers as ${boot.hostId}',
      );
    }
    return boot;
  }

  /// Sends text to the agent in a pane. The target is a pane on **this** host — the
  /// reason a `CellRef` carries both ids (ADR-13 no. 2).
  Future<void> dispatch(String paneId, String text) =>
      _authed('POST', _uri(['m', 'cell', paneId, 'dispatch']), body: {'text': text});

  /// Send raw emulator bytes without appending a submit key.
  Future<void> sendInput(String paneId, String data) => _authed(
        'POST',
        _uri(['m', 'cell', paneId, 'input']),
        body: {'data': data},
        special: (reply) => reply.status == 404 ? NoLiveSession(paneId) : null,
      );

  /// Interrupts the current turn without killing the session.
  Future<void> stop(String paneId) => _authed(
        'POST',
        _uri(['m', 'cell', paneId, 'stop']),
        special: (reply) => reply.status == 404 ? NoLiveSession(paneId) : null,
      );

  /// Omit unselected tuning fields so runner defaults apply (`contract/README.md`, spawn-tuning).
  Future<SpawnedCell> spawnCell({
    required String provider,
    String? runnerId, String? workspaceId, String? initialPrompt,
    String? permissionMode,
    String? model, String? effort, String? profileId, bool? tui,
  }) async =>
      SpawnedCell.fromJson(await _authed('POST', _uri(const ['m', 'cells']), body: {
        'provider': provider,
        // Sent only for a runner the operator defined. The desktop resolves it against
        // its own registry; a native runner needs no override, and sending one would
        // be a second name for the same thing.
        'runnerId': ?runnerId,
        'workspaceId': ?workspaceId,
        'initialPrompt': ?initialPrompt,
        'permissionMode': ?permissionMode,
        'model': ?model, 'effort': ?effort, 'profileId': ?profileId,
        // Only ever `false`, and only when chosen: absent means a terminal, as always.
        'tui': ?tui,
      }));

  /// Treat a missing session as already closed.
  Future<void> closeCell(String paneId) => _authed(
        'DELETE',
        _uri(['m', 'cell', paneId]),
        special: (reply) => reply.status == 404 ? NoLiveSession(paneId) : null,
      );

  /// What Chat renders: hook events, oldest first. Answers `hostSupports: false`
  /// rather than 404 on a host with no hook pipeline, so the fork is in the payload.
  /// [before] walks backwards: pass the previous page's `oldestCursor` for older history.
  Future<TranscriptSnapshot> transcript(String paneId, {int? before, int? limit}) async =>
      TranscriptSnapshot.fromJson(await _authed(
        'GET',
        _uri(['m', 'cell', paneId, 'transcript'], query: {
          if (before != null) 'before': '$before',
          if (limit != null) 'limit': '$limit',
        }),
      ));

  /// Dictation: the phone records, the host calls the provider with its own key, and
  /// the reply names the provider id only (ADR-11).
  Future<Transcription> transcribe({
    required String audioBase64,
    required String mime,
    String? prompt,
  }) async {
    if (audioBase64.length > sttMaxBodyBytes) {
      throw HostRejected('audio is ${audioBase64.length} base64 bytes, '
          'past the $sttMaxBodyBytes cap this host enforces');
    }
    final json = await _authed('POST', _uri(const ['m', 'stt']), body: {
      'audioBase64': audioBase64,
      'mime': mime,
      // Null-aware entry: the host treats an absent prompt and a null one the same,
      // but sending `"prompt": null` would still be us saying something we did not mean.
      'prompt': ?prompt,
    });
    return Transcription.fromJson(json);
  }

  /// Tells this host where to wake the phone when its socket is closed (ADR-4).
  ///
  /// The host binds the token to **the calling device** from the bearer — there is no
  /// `deviceId` in the body, so one paired phone cannot redirect another's wake-ups.
  Future<void> registerPushToken(String token) => _authed(
        'POST',
        _uri(const ['m', 'devices', 'push-token']),
        body: {'token': token, 'platform': 'fcm'},
      );

  /// Stops wake-ups for this device — notifications switched off, or signing out.
  Future<void> clearPushToken() =>
      _authed('DELETE', _uri(const ['m', 'devices', 'push-token']));

  /// Throws [HostUnauthorized] when the host no longer takes the bearer — the 401 a
  /// refused WebSocket upgrade drops (`TransportCause.rejected`). `GET /m/devices`, unread.
  Future<void> verifyCredential() => _authed('GET', _uri(const ['m', 'devices']));

  /// `DELETE /m/devices/:deviceId` — hands a credential back for good.
  ///
  /// Takes an id because the route is wider than self-revoke — a phone in hand can retire
  /// a lost one (`device-routes.ts`). Pocket only ever passes its own, when unpairing.
  Future<void> revokeDevice(String deviceId) =>
      _authed('DELETE', _uri(['m', 'devices', deviceId]));

  /// Pushes the 72-hour TTL forward; the 30-day ceiling stays, so only expiry returns.
  Future<RefreshedToken> refreshToken() async {
    final json = await _authed(
      'POST',
      _uri(const ['m', 'devices', 'refresh']),
      special: (reply) => reply.status == 401 ? const RefreshRefused() : null,
    );
    return RefreshedToken.fromJson(json);
  }

  /// Return the asynchronous job; omit blank branch and name (`issues/02`).
  Future<CloneJob> cloneProject({
    required String url,
    String? branch,
    String? name,
  }) async {
    final json = await _authed(
      'POST',
      _uri(const ['m', 'projects', 'clone']),
      body: {
        'url': url,
        if (branch != null && branch.isNotEmpty) 'branch': branch,
        if (name != null && name.isNotEmpty) 'name': name,
      },
    );
    return CloneJob.fromJson(json);
  }

  /// `POST /m/projects` — takes a folder that is already on the machine.
  ///
  /// **Nothing is copied.** What changes is the host's claim on a directory that was already
  /// there, which is why this answers with no job to wait on.
  Future<void> addProject(String path) =>
      _authed('POST', _uri(const ['m', 'projects']), body: {'path': path});

  /// Empty query passed as null: `Uri.replace({})` renders a trailing `?`.
  Uri _uri(List<String> segments, {Map<String, String>? query}) => baseUri.replace(
        pathSegments: segments,
        queryParameters: (query == null || query.isEmpty) ? null : query,
      );

  Future<Map<String, Object?>> _authed(
    String method,
    Uri uri, {
    Map<String, Object?>? body,
    ApiFailure? Function(HttpReply)? special,
  }) =>
      _send(transport, method, uri,
          bearer: _tokenReader(), body: body, special: special);
}

/// The one place a request is actually shaped, so `pair` — which has no instance and
/// no bearer — takes the same path as everything else.
Future<Map<String, Object?>> _send(
  HttpTransport transport,
  String method,
  Uri uri, {
  String? bearer,
  Map<String, Object?>? body,
  ApiFailure? Function(HttpReply)? special,
}) async {
  final reply = await transport.send(
    method: method,
    uri: uri,
    headers: {
      // A token in the query string would leak into logs; only the WS upgrade has an
      // excuse for that, and it is that browsers cannot set headers there (ADR-10).
      if (bearer != null) 'Authorization': 'Bearer $bearer',
      if (body != null) 'Content-Type': 'application/json',
    },
    body: body == null ? null : jsonEncode(body),
  );

  // A route with a status of its own gets first refusal, then the shared meanings.
  if (!reply.isOk) throw special?.call(reply) ?? classify(reply);
  return decode(reply);
}
