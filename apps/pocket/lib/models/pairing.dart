import 'cell.dart';
import 'host_id.dart';

/// What `POST /m/pair` hands back: one credential, and who this host is.
class PairedDevice {
  const PairedDevice({
    required this.deviceToken,
    required this.deviceId,
    required this.expiresAt,
    required this.hardExpiresAt,
    required this.hostId,
    required this.hostLabel,
    required this.mode,
    required this.caps,
    required this.baseUri,
    this.nickname,
    this.refreshKeyAlias,
  });

  /// The client supplies the dialled address because the payload cannot identify its route (ADR-13 no. 2).
  final Uri baseUri;

  /// Never logged, never in a URL path — it rides the `?token=` query on the WS
  /// upgrade only because browsers cannot send headers there (ADR-10).
  final String deviceToken;
  final String deviceId;

  /// 72-hour TTL (ADR-8). It can expire while a socket is open, so a client
  /// refreshes proactively rather than waiting for a 401.
  final DateTime expiresAt;

  /// 30-day ceiling: no amount of refreshing extends a device past this.
  final DateTime hardExpiresAt;

  final HostId hostId;

  /// What the machine calls itself — its hostname, as it announced it.
  final String hostLabel;

  /// A nickname is phone-local; null restores the hostname (`issues/11`).
  final String? nickname;

  final String mode;
  final HostCaps caps;

  /// The Keystore alias of this pairing's hardware-bound refresh key, or null when the
  /// phone could not make one or the host does not take one. Storage-only, like
  /// [nickname]: the host knows the public half, and only this phone knows where the
  /// private half lives.
  final String? refreshKeyAlias;

  /// True while there is still enough runway to start work without a re-pair.
  bool refreshDueAt(DateTime now, {Duration lead = const Duration(hours: 1)}) =>
      !now.isBefore(expiresAt.subtract(lead));

  /// Same shape as the wire, so what is stored in the Keychain is exactly what
  /// `/m/pair` sent and [PairedDevice.fromJson] — the factory the contract fixture
  /// already tests — is what reads it back. A second, storage-only shape would be a
  /// second thing that can drift.
  Map<String, Object?> toJson() => {
        'deviceToken': deviceToken,
        'deviceId': deviceId,
        'expiresAt': expiresAt.millisecondsSinceEpoch,
        'hardExpiresAt': hardExpiresAt.millisecondsSinceEpoch,
        'hostId': hostId.value,
        'hostLabel': hostLabel,
        'mode': mode,
        'hostCaps': {'protocol': caps.protocol, 'features': caps.features},
        // The two keys the wire never carries. Written because storage is the only
        // record of where this host lives, and of what its owner calls it, once the
        // app has been closed.
        'baseUri': baseUri.toString(),
        if (nickname != null) 'nickname': nickname,
        if (refreshKeyAlias != null) 'refreshKeyAlias': refreshKeyAlias,
      };

  /// The same device with a refreshed token. The ceiling is copied unchanged: a
  /// refresh moves [expiresAt] and nothing else (ADR-8).
  PairedDevice withToken(RefreshedToken refreshed) => PairedDevice(
        deviceToken: refreshed.deviceToken,
        deviceId: deviceId,
        expiresAt: refreshed.expiresAt,
        hardExpiresAt: hardExpiresAt,
        hostId: hostId,
        hostLabel: hostLabel,
        nickname: nickname,
        mode: mode,
        caps: caps,
        baseUri: baseUri,
        refreshKeyAlias: refreshKeyAlias,
      );

  /// Back in on a hardware-key signature: a new bearer, and — unlike [withToken] — a new
  /// ceiling, which now counts from the last proof of presence the host could verify.
  PairedDevice renewed(RenewedToken renewal) => PairedDevice(
        deviceToken: renewal.deviceToken,
        deviceId: deviceId,
        expiresAt: renewal.expiresAt,
        hardExpiresAt: renewal.hardExpiresAt,
        hostId: hostId,
        hostLabel: hostLabel,
        nickname: nickname,
        mode: mode,
        caps: caps,
        baseUri: baseUri,
        refreshKeyAlias: refreshKeyAlias,
      );

  /// The same pairing, with the alias of the key the host has just accepted — or none.
  PairedDevice withRefreshKey(String? alias) => PairedDevice(
        deviceToken: deviceToken,
        deviceId: deviceId,
        expiresAt: expiresAt,
        hardExpiresAt: hardExpiresAt,
        hostId: hostId,
        hostLabel: hostLabel,
        nickname: nickname,
        mode: mode,
        caps: caps,
        baseUri: baseUri,
        refreshKeyAlias: alias,
      );

  /// The same machine under the name its owner gives it.
  ///
  /// A blank name is stored as null rather than as `''`: emptying the field is how an
  /// operator says "go back to what the machine calls itself", and keeping an empty
  /// string would make every screen check for two kinds of nothing.
  PairedDevice named(String? name) {
    final trimmed = name?.trim();
    return PairedDevice(
      deviceToken: deviceToken,
      deviceId: deviceId,
      expiresAt: expiresAt,
      hardExpiresAt: hardExpiresAt,
      hostId: hostId,
      hostLabel: hostLabel,
      nickname: trimmed == null || trimmed.isEmpty ? null : trimmed,
      mode: mode,
      caps: caps,
      baseUri: baseUri,
      refreshKeyAlias: refreshKeyAlias,
    );
  }

  /// Changes the route without changing the pairing credential.
  PairedDevice at(Uri baseUri) => PairedDevice(
        deviceToken: deviceToken,
        deviceId: deviceId,
        expiresAt: expiresAt,
        hardExpiresAt: hardExpiresAt,
        hostId: hostId,
        hostLabel: hostLabel,
        nickname: nickname,
        mode: mode,
        caps: caps,
        baseUri: baseUri,
        refreshKeyAlias: refreshKeyAlias,
      );

  /// Parses the `POST /m/pair` reply. [baseUri] is required because the reply does not
  /// contain it — the caller passes the address it just dialled, exactly as
  /// `Cell.fromJson` is passed the host whose socket the frame arrived on.
  factory PairedDevice.fromJson(
    Map<String, Object?> json, {
    required Uri baseUri,
  }) =>
      PairedDevice(
        deviceToken: json['deviceToken']! as String,
        deviceId: json['deviceId']! as String,
        expiresAt: DateTime.fromMillisecondsSinceEpoch(json['expiresAt']! as int),
        hardExpiresAt: DateTime.fromMillisecondsSinceEpoch(json['hardExpiresAt']! as int),
        hostId: HostId(json['hostId']! as String),
        hostLabel: json['hostLabel']! as String,
        // Absent from the pairing reply, present in storage once the operator has
        // named the machine. Optional in both, so a credential stored before this
        // field existed still reads back.
        nickname: json['nickname'] as String?,
        mode: json['mode']! as String,
        caps: HostCaps.fromJson(json['hostCaps']! as Map<String, Object?>),
        baseUri: baseUri,
        refreshKeyAlias: json['refreshKeyAlias'] as String?,
      );

  /// Reads back what [toJson] wrote. Separate from [PairedDevice.fromJson] because the
  /// two have different sources of truth for [baseUri]: storage has it in the record,
  /// the wire never does.
  factory PairedDevice.fromStored(Map<String, Object?> json) => PairedDevice.fromJson(
        json,
        baseUri: Uri.parse(json['baseUri']! as String),
      );
}

/// `POST /m/devices/refresh` — a new token and its new expiry, nothing else. The
/// 30-day ceiling is not restated because refreshing cannot move it.
class RefreshedToken {
  const RefreshedToken({required this.deviceToken, required this.expiresAt});

  final String deviceToken;
  final DateTime expiresAt;

  factory RefreshedToken.fromJson(Map<String, Object?> json) => RefreshedToken(
        deviceToken: json['deviceToken']! as String,
        expiresAt: DateTime.fromMillisecondsSinceEpoch(json['expiresAt']! as int),
      );
}

/// `POST /m/devices/renew` — a new bearer with both clocks restarted.
class RenewedToken {
  const RenewedToken({
    required this.deviceToken,
    required this.expiresAt,
    required this.hardExpiresAt,
  });

  final String deviceToken;
  final DateTime expiresAt;
  final DateTime hardExpiresAt;

  factory RenewedToken.fromJson(Map<String, Object?> json) => RenewedToken(
        deviceToken: json['deviceToken']! as String,
        expiresAt: DateTime.fromMillisecondsSinceEpoch(json['expiresAt']! as int),
        hardExpiresAt: DateTime.fromMillisecondsSinceEpoch(json['hardExpiresAt']! as int),
      );
}
