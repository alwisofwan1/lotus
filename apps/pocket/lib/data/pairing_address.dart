/// Turning what the operator typed into an address the app can dial.
///
/// A separate, pure step because it is the one part of pairing that fails **before**
/// anything leaves the phone, and a typo must read as a typo rather than as a host
/// that would not answer. `MobileTab.tsx` prints the address as bare `host:port`
/// (`Listening on 100.64.0.3:8787`), so that is the form the operator copies — and
/// the form this must accept without ceremony.
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

/// Reads a typed address.
///
/// Deliberately permissive about the shape and strict about the result: `mac:8787`,
/// `http://mac:8787`, `100.64.0.3` and `mac.tail1234.ts.net` all land somewhere
/// dialable, while anything without a host is refused here rather than becoming a
/// request that cannot succeed.
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
    // Which default applies depends on what the operator said, because the two forms mean
    // different things:
    //
    // - A bare `mac` or `100.64.0.3` is the desktop's own `host:port` line with the port
    //   left off, so 8787 — the façade's `parseBind` default — is the right guess. 80 here
    //   would dial a web server that is not there.
    // - An explicit `https://lotus.example.com` is a URL, and a URL with no port means
    //   443. A host reached through a tunnel has no port in it at all, so guessing 8787
    //   would dial a port the tunnel does not serve — and the operator would be looking at
    //   "could not connect" for an address that is completely correct.
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
