import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/pairing_address.dart';

Uri? uriOf(String typed) {
  final reading = readAddress(typed);
  return reading is AddressReadable ? reading.uri : null;
}

String? reasonOf(String typed) {
  final reading = readAddress(typed);
  return reading is AddressUnreadable ? reading.reason : null;
}

void main() {
  test('reads the bare host:port the desktop prints', () {
    // `MobileTab.tsx` shows `Listening on 100.64.0.3:8787`, so this is the string the
    // operator copies — and the one `Uri.parse` gets wrong on its own, reading `mac`
    // as a scheme and leaving no host at all.
    expect(uriOf('100.64.0.3:8787'), Uri.parse('http://100.64.0.3:8787'));
    expect(uriOf('mac.tail1234.ts.net:8787'), Uri.parse('http://mac.tail1234.ts.net:8787'));
  });

  test('a host with no port gets the one the façade defaults to', () {
    // `parseBind` in the host's config falls back to 8787; guessing 80 here would
    // produce a request that cannot succeed.
    expect(uriOf('mac.tail1234.ts.net')!.port, defaultMobilePort);
  });

  /// A tunnel hostname carries no port, and the operator types the URL their browser
  /// would take. Defaulting THAT to 8787 dials a port the tunnel does not serve, on the
  /// one screen where a wrong guess is the whole experience — so an explicit scheme
  /// brings its own default, and 8787 stays what a bare host means.
  test('an explicit scheme brings its own default port', () {
    expect(uriOf('https://lotus-alwi.example-vps.com')!.port, 443);
    expect(uriOf('http://lotus.example.com')!.port, 80);
  });

  test('a bare host still means the mobile facade, not the web', () {
    expect(uriOf('mac.tail1234.ts.net')!.port, defaultMobilePort);
    expect(uriOf('100.64.0.3')!.port, defaultMobilePort);
  });

  test('an explicit port always wins over both defaults', () {
    expect(uriOf('https://lotus.example.com:8443')!.port, 8443);
    expect(uriOf('mac:8787')!.port, 8787);
  });

  test('an explicit scheme is kept, including https for a VPS behind TLS', () {
    expect(uriOf('https://lotus.example.com:8443'), Uri.parse('https://lotus.example.com:8443'));
    expect(uriOf('http://100.64.0.3:8787')!.scheme, 'http');
  });

  test('surrounding whitespace is forgiven', () {
    expect(uriOf('  100.64.0.3:8787 \n'), Uri.parse('http://100.64.0.3:8787'));
  });

  test('a pasted path is dropped rather than carried into every request', () {
    // Every route is absolute under `/m/`, so a base with a path would build URLs no
    // host serves — and the failure would surface as a 404 from a correct address.
    expect(uriOf('http://mac:8787/m/pair'), Uri.parse('http://mac:8787'));
  });

  group('what it refuses, and what it says', () {
    test('an empty field asks for the address rather than failing silently', () {
      expect(reasonOf('   '), isNotNull);
      expect(reasonOf('   '), contains('address'));
    });

    test('spaces inside are named as the typo they are', () {
      expect(reasonOf('100.64.0.3 :8787'), contains('spaces'));
    });

    test('a scheme Lotus does not answer on is named, not silently rewritten', () {
      // `ws://` is the plausible wrong guess — the app does open a socket, just not
      // from an address the operator types.
      expect(reasonOf('ws://mac:8787'), contains('ws'));
    });

    test('something with no host at all is refused', () {
      expect(reasonOf('http://'), isNotNull);
      expect(reasonOf(':::'), isNotNull);
    });
  });
}
