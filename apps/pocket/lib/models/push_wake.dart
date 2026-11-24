/// One wake-up as the host sent it through FCM (`issues/04`, content rule).
///
/// The host's `PushMessage` is a closed shape — `kind`, the agent's name, one short
/// sentence, and the pane id — and this is its mirror. Nothing here is trusted beyond
/// *which agent to look at*: the phone still fetches the truth over its own bearer.
class PushWake {
  const PushWake({
    required this.kind,
    required this.paneId,
    required this.title,
    required this.body,
  });

  /// `data.kind` is the contract; a title/body may be absent on a data-only frame.
  static PushWake? fromMessage({
    required Map<String, Object?> data,
    String? title,
    String? body,
  }) {
    final paneId = data['paneId'];
    final kind = switch (data['kind']) {
      'attention' => WakeKind.attention,
      'finished' => WakeKind.finished,
      _ => null,
    };
    if (kind == null || paneId is! String || paneId.isEmpty) return null;
    return PushWake(
      kind: kind,
      paneId: paneId,
      title: (title ?? '').trim().isEmpty ? 'An agent' : title!.trim(),
      body: (body ?? '').trim().isEmpty ? kind.fallbackBody : body!.trim(),
    );
  }

  final WakeKind kind;
  final String paneId;
  final String title;
  final String body;

  /// `Atlas needs you` — the one line a banner shows.
  String get sentence => '$title $body';
}

enum WakeKind {
  attention('needs you'),
  finished('finished');

  const WakeKind(this.fallbackBody);
  final String fallbackBody;
}
