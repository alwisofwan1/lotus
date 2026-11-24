/// What a link found in a reply actually points at.
///
/// **The question this answers is not "is it a URL", it is "whose machine is it on".**
/// `agent_prose.dart` refused to open links for a good reason, written down at the time:
/// an agent's URL usually names a port on the machine *it* runs on, so tapping it here
/// opens a browser on the phone that cannot reach the host. That reason is true for
/// those links and false for the ones an agent cites while explaining itself — a doc
/// page, an issue, a pub.dev listing — and the old rule treated both the same.
///
/// So the classification is the feature: a target the phone can reach gets an open
/// action, one that belongs to the other machine says so instead of failing silently.
enum LinkKind {
  /// `https://pub.dev/packages/record` — reachable from the phone.
  web,

  /// `http://127.0.0.1:9877/admin`, `http://192.168.1.4:3000` — a port on the machine
  /// the agent runs on, or on a network the phone may not be joined to.
  machine,

  /// `apps/pocket/lib/main.dart:88` — a place in a repository, not an address.
  path,
}

/// A link, classified, with the pieces the sheet needs.
class LinkTarget {
  const LinkTarget({required this.raw, required this.kind, this.line});

  /// Exactly what was written in the reply, which is also what gets copied — an operator
  /// pasting this at the desk wants the agent's own string, not a normalised one.
  final String raw;

  final LinkKind kind;

  /// The `:88` in `agent_prose.dart:88`, when there was one.
  final int? line;

  /// Hosts that mean "the machine this came from" rather than a place on the network.
  static const _loopback = {'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'};

  static LinkTarget of(String raw) {
    final trimmed = raw.trim();
    final uri = Uri.tryParse(trimmed);

    if (uri != null && (uri.scheme == 'http' || uri.scheme == 'https')) {
      return LinkTarget(
        raw: trimmed,
        kind: _isOwnMachine(uri.host) ? LinkKind.machine : LinkKind.web,
      );
    }

    // `path.dart:88` — the line number is the agent's own convention for pointing at a
    // place in a file, and it is why this is parsed rather than passed through.
    final atLine = RegExp(r':(\d+)$').firstMatch(trimmed);
    return LinkTarget(
      raw: trimmed,
      kind: LinkKind.path,
      line: atLine == null ? null : int.tryParse(atLine.group(1)!),
    );
  }

  /// A host on the agent's own machine, or on a private network the phone is only
  /// sometimes joined to. `.local` is included because mDNS names resolve on the LAN and
  /// nowhere else, which is the same promise a private address makes.
  static bool _isOwnMachine(String host) {
    if (_loopback.contains(host)) return true;
    if (host.endsWith('.local')) return true;

    final octets = host.split('.');
    if (octets.length != 4) return false;
    final first = int.tryParse(octets.first);
    final second = int.tryParse(octets[1]);
    if (first == null || second == null) return false;

    return first == 10 ||
        (first == 192 && second == 168) ||
        (first == 172 && second >= 16 && second <= 31);
  }

  /// Whether a browser on this phone stands a chance of reaching it.
  bool get reachableFromPhone => kind == LinkKind.web;
}
