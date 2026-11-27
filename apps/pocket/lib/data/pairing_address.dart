/// Validate typed addresses locally so typos are distinct from unreachable hosts.
sealed class AddressReading {
  const AddressReading();
}

class AddressReadable extends AddressReading {
  const AddressReadable(this.uri);

  /// Scheme, host and port only. Any path the operator pasted is dropped: every
  /// route this app calls is absolute under `/m/`, so a base with a path would build
  /// URLs no host serves.
  final Uri uri;
}

class AddressUnreadable extends AddressReading {
  const AddressUnreadable(this.reason);

  /// Said in the operator's terms, not the parser's. This is the one failure whose
  /// fix is entirely on this screen.
  final String reason;
}

/// The mobile façade's own default (`parseBind` in `packages/host/src/core/config.ts`).
/// Used when the operator types a host with no port, which is the likeliest omission.
const int defaultMobilePort = 8787;

/// Accept common address forms but reject inputs without a host.
AddressReading readAddress(String typed) {
  final trimmed = typed.trim();
  if (trimmed.isEmpty) return const AddressUnreadable('Enter the address Lotus shows.');
  if (trimmed.contains(' ')) {
    return const AddressUnreadable('An address has no spaces in it.');
  }

  // `Uri.parse('mac:8787')` reads `mac` as a *scheme*, not a host — so a bare
  // `host:port`, the exact form the desktop prints, parses into something with no
  // host at all. Adding the scheme first is what stops that.
  final withScheme = _hasScheme(trimmed) ? trimmed : 'http://$trimmed';

  final Uri parsed;
  try {
    parsed = Uri.parse(withScheme);
  } on FormatException {
    return const AddressUnreadable('That is not an address.');
  }

  if (parsed.host.isEmpty) return const AddressUnreadable('That is not an address.');
  if (parsed.scheme != 'http' && parsed.scheme != 'https') {
    return AddressUnreadable('Lotus answers over http or https, not ${parsed.scheme}.');
  }

  return AddressReadable(Uri(
    scheme: parsed.scheme,
    host: parsed.host,
    // Bare hosts use the service port; explicit URLs use their scheme default.
    port: parsed.hasPort
        ? parsed.port
        : _hasScheme(trimmed)
            ? parsed.port // Uri already reports 443/80 for the scheme
            : defaultMobilePort,
  ));
}

/// Whether the operator already said how to speak to the host.
///
/// Matched on the `scheme://` shape rather than on `contains(':')`, because
/// `mac:8787` contains a colon and means the opposite.
bool _hasScheme(String typed) => RegExp(r'^[a-zA-Z][a-zA-Z0-9+.-]*://').hasMatch(typed);
