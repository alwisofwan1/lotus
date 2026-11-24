import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/launch_route.dart';

void main() {
  test('a phone with a machine goes straight to the project index', () {
    expect(
      launchRoute(paired: true, introSeen: true),
      LaunchRoute.projects,
    );
  });

  test('a first run gets the intro before the pairing form', () {
    expect(
      launchRoute(paired: false, introSeen: false),
      LaunchRoute.intro,
    );
  });

  test('the intro does not come back once a machine is paired', () {
    // The rule this whole file exists for. Someone will one day be tempted to
    // re-show the panes after an update, and this is where that stops.
    expect(
      launchRoute(paired: true, introSeen: false),
      LaunchRoute.projects,
    );
  });

  test('unpairing the last machine returns to pairing, not to the intro', () {
    // A repair, not a first run: the operator knows what Pocket is, and three
    // explanatory panes in front of the form would be in the way.
    expect(
      launchRoute(paired: false, introSeen: true),
      LaunchRoute.pairing,
    );
  });

  group('the line the splash holds up', () {
    test('names how many machines are being dialled', () {
      expect(launchLine(2), '2 machines · dialing');
    });

    test('does not say "1 machines"', () {
      expect(launchLine(1), '1 machine · dialing');
    });

    test('a phone with nothing paired says so, rather than dialling nothing', () {
      expect(launchLine(0), 'no machine paired');
    });
  });
}
