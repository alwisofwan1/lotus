part of 'host_api.dart';

/// Size changes do not reach the agent and need no biometric gate (ADR-6 addendum).
extension HostApiSize on HostApi {
  /// Starts a hold with no [token], renews one with it. A renewal that lost — someone at
  /// the desk typed, or the lease ran out — answers `held: false`, not an error.
  Future<SizeHold> holdSize(String paneId, {required int cols, required int rows, int? token}) async =>
      SizeHold.fromJson(await _authed(
        'POST',
        _uri(['m', 'cell', paneId, 'size']),
        body: {'cols': cols, 'rows': rows, 'token': ?token},
        special: (reply) => reply.status == 404 ? NoLiveSession(paneId) : null,
      ));

  /// Gives the size back to the desktop. Succeeds for a pane that is already gone.
  Future<void> releaseSize(String paneId, int token) => _authed(
        'POST',
        _uri(['m', 'cell', paneId, 'size', 'release']),
        body: {'token': token},
      );
}

/// What a hold came to.
class SizeHold {
  const SizeHold({required this.held, this.token});

  factory SizeHold.fromJson(Map<String, Object?> json) =>
      SizeHold(held: json['held']! as bool, token: (json['token'] as num?)?.toInt());

  final bool held;

  /// The lease to renew and release with; absent when [held] is false.
  final int? token;
}
