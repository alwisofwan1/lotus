# Lotus Pocket

The mobile client for Lotus — **a remote control for a machine that is already running**,
not a small copy of the desktop app. It attaches to live sessions; it never clones a repo
or syncs one.

Decisions live in [`plans/lotus-pocket/PLAN.md`](../../plans/lotus-pocket/PLAN.md) (ADR-1…13),
the screen shapes in [`design/pocket-flow.html`](../../plans/lotus-pocket/design/pocket-flow.html),
and the wire format in [`contract/README.md`](../../contract/README.md). Read those before
changing behaviour here — this README covers only how to run and extend the code.

## Commands

Run from the repo root; each is a pass-through to this package.

```bash
bun run pocket:dev                 # Home preview on the emulator, hot reload attached
bun run pocket:dev lib/main.dart   # the real app instead of the preview
bun run pocket:emulator            # just boot the emulator and leave it up
bun run pocket:test                # 476 tests
bun run pocket:analyze             # analyser, strict mode
```

`pocket:dev` boots the emulator if nothing is attached, then hands over to `flutter run`, so
`r` hot-reloads, `R` restarts, `q` quits. A second run reuses the running emulator and skips
the cold boot.

**`pocket:dev` defaults to the preview, not the app, and that is deliberate:** the real app opens
on onboarding and needs a machine to pair with, while
[`tool/preview_home.dart`](tool/preview_home.dart) feeds the real `HomeScreen` and `AgentScreen` a
fixed fleet — the app's own widgets and theme, only the data invented.

## First-time emulator setup

`pocket:emulator` expects an AVD named `lotus_pocket_pixel8` and prints the exact commands to
create one if it is missing. In full, once:

```bash
export JAVA_HOME=$(ls -d /opt/homebrew/opt/openjdk@21/libexec/*.jdk/Contents/Home | head -1)
SDK=/opt/homebrew/share/android-commandlinetools   # or ~/Library/Android/sdk

$SDK/cmdline-tools/latest/bin/sdkmanager --install \
    'emulator' 'system-images;android-35;google_apis;arm64-v8a'   # ~3.8 GB unpacked

$SDK/cmdline-tools/latest/bin/avdmanager create avd \
    --name lotus_pocket_pixel8 \
    --package 'system-images;android-35;google_apis;arm64-v8a' \
    --device pixel_8
```

Override the name with `POCKET_AVD=other-avd bun run pocket:dev`.

Four things on this path cost real time to work out, so they are worth knowing:

| Symptom | Cause |
|---|---|
| The real app opens on **Home**, empty, instead of onboarding | The preview writes real credentials through the real Keystore (deliberately — it is how the biometric gate gets exercised), so the app is genuinely paired with two hosts that do not exist. `adb shell pm clear com.serayu.lotus_pocket` to get onboarding back. **And it overwrites a real pairing, not just adds to it:** `preview_home.dart` uses the machine's actual host id (`Alwis-MacBook-Air.local`), credentials are keyed by host id, so running the preview replaces the live credential with one pointing at `…preview:9877`. Walked into on 2026-08-07 while verifying against a real host — the phone looked paired and silent. **Diagnostics names it in seconds**, which is why that screen prints the origin *with its scheme*: `http://alwis-macbook-air.local.preview:9877` is unmistakable, `reach: tailnet_down` alone would not have been. |
| `sdkmanager`: *Unable to locate a Java Runtime* while `flutter doctor` reports Android ✓ | Those tools need `JAVA_HOME`; `flutter` resolves a JDK on its own. Set it for them only. |
| `avdmanager`: *Could not load … devices.xml* | Harmless — an optional per-image file. Confirm success with `avdmanager list avd`, not by a silent run. |
| `avdmanager`: *Valid system image paths are: null* | The image genuinely is not on disk yet. `sdkmanager` downloads the whole archive before unpacking, so the target directory stays empty and `package.xml` absent until the very end — that file is the completion marker. |
| A push is accepted by FCM (`mobile.push.sent`) but never arrives | **This emulator cannot receive push.** The AVD is built from the `google_apis` image, which has Google Play Services — enough to *mint* a token over HTTPS — but holds no MCS connection, the persistent channel that actually delivers. Measured 2026-08-07: zero ESTABLISHED sockets on ports 5228–5230, awake, app foregrounded, token matching the host's byte for byte. So the send path can be proven here and the receive path cannot: use a real phone, or an AVD from `google_apis_playstore` with a Google account signed in. |
| Sluggish frames, multi-second `app_time_stats` | The emulator falls back to **software GL** when free RAM is under ~5 GB (it says so in `/tmp/lotus-pocket-emulator.log`). Close other apps before booting; do not read it as the app being slow. |

`adb install` + `adb shell monkey` is not a substitute for `flutter run`: the launch races the
package replacement and dies with `VM exiting with result code -5`. Use `adb shell am start -W
-n com.serayu.lotus_pocket/.MainActivity` if you ever need to launch by hand.

## Release build

```bash
bun run pocket:release              # split per ABI — what you install on a phone
bun run pocket:release --install    # …and adb install -r it, then read back the versionCode
bun run pocket:release --fat        # one universal APK, for an unknown device
bun run pocket:release --aab        # an App Bundle, for a future Play Store upload
```

ADR-9 distributes this by **sideload**, and the APK stays the default. `--aab` exists so a
store build, when one is wanted, is the same script, number and checks — not a second
pipeline.

### Versioning

`scripts/version.sh` is the one source of a build's identity; every packaging path reads
it. Bump the **name** (semver) in `pubspec.yaml`; never type a **build number** — it is
minutes since the Unix epoch, so it rises on every build from every branch and machine,
which is what Android, Play and App Store Connect all require. The file says why a
counter or the attached phone's versionCode was not good enough.

To know the phone took an update:

- `release.sh` prints `Lotus Pocket 1.0.0 (29850748) · <commit>`; with `--install` it also
  reads the versionCode back off the phone and fails if it does not match.
- The first launch of a newer build shows `Updated to Lotus Pocket 1.0.0 (29850748)` once.
- Diagnostics ends with the running build, commit, build time and channel; long-press
  copies it.

An APK's Android versionCode is the build number **plus the ABI offset** (`+2000` on
arm64) — Diagnostics shows the bare number, which is the one every ABI and store agree on.

Four things the Flutter template does not do, each of which fails quietly rather than
loudly:

- **A real signing key.** The template signs release with the *debug* key and leaves a
  `TODO`. Debug keys differ per machine and are regenerated when
  `~/.android/debug.keystore` expires, so the build installs fine today and an upgrade
  dies with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` months later. `key.properties` is
  gitignored and the keystore lives **outside the repo** at `~/.lotus-pocket/release.p12`
  — `git clean -fdx` is routine and would otherwise destroy the one artefact that cannot
  be replaced without consequence. **Back it up.** Losing it does not lose the app; it
  loses the ability to upgrade an installed one, and reinstalling takes the paired
  credential with it.
- **`--obfuscate --split-debug-info=build/symbols`.** Dart symbols are stripped from the
  binary and kept beside it. The second half is the one people forget, because the build
  succeeds either way — and without it a release stack trace is unreadable forever.
- **`--split-per-abi`.** A phone is arm64; a universal APK carries armeabi-v7a and
  x86_64 too. Measured here: 21.0 MB arm64 against a fat build that carries all three.
- **Verifying the artefact.** `apksigner` confirms the signer is the release key and not
  `CN=Android Debug`, because a build that fell back to the debug key looks perfect until
  it doesn't. The script fails on either.

`minSdk` is pinned to 23 rather than inherited from Flutter: that floor is a real
constraint from `flutter_secure_storage`, which every device token depends on (ADR-5),
and inheriting it would hide the reason behind a number that moves.

### R8, and what actually verifies it

Shrinking is on (`isMinifyEnabled` + `isShrinkResources`). Keep rules live in
`android/app/proguard-rules.pro` and are deliberately short — an over-broad
`-keep class **` turns shrinking off in all but name.

**A missing keep rule fails at runtime, not at build time**, so a green build proves
nothing. Two were settled by evidence rather than anticipation:

| Rule | How it was found |
|---|---|
| `-dontwarn com.google.android.play.core.**` | The build **failed**: Flutter's embedding carries a Play-Store `Application` variant for deferred components, and ADR-9 has no Play Core. `-dontwarn` rather than adding the dependency — the class is unreachable, since the manifest names `FlutterApplication`. |
| `androidx.security.crypto` / Tink | Verified by *running* the release APK: `FlutterSecureStorage: … EncryptedSharedPreferences … Android KeyStore` in logcat, plus the app reaching onboarding, which only happens after `Credentials.load()` succeeds. |

Confirmed on the release build (2026-08-07): `FirebaseApp initialization successful`,
`flags=0x0` with no `DEBUGGABLE`, `apkSigningVersion=2`, signer
`CN=Lotus Pocket, OU=Lotus, O=Serayu, C=ID`.

**Still unexercised in release:** the `local_auth` gate and `firebase_messaging.getToken`.
Both only run after a host is paired, so they need a live Lotus to reach. Their keep
rules are reasoned, not proven — treat the first release pairing as the test.

## Layout

Dependencies point one way only, and a test enforces it —
[`test/architecture/layering_test.dart`](test/architecture/layering_test.dart), because a
convention nobody checks rots.

```
lib/
├── models/    sealed classes + hand-written fromJson, tested against contract/fixtures/
├── core/      transport seams (socket, HTTP), HostApi, clock, keychain, biometrics
├── hosts/     connections, credentials, TTL, the failure taxonomy
├── data/      policy: the biometric gate, credential freshness, merging, ordering
├── features/  widgets only — render and copy, no policy (onboarding, home, agent,
│              settings, shared)
└── app/       composition root, routing, theme
```

```
models ◄─ core ◄─ hosts ◄─ data ◄─ features ◄─ app
                                      ▲           │
                          may not touch core/     └─ the only place that names a
                          or a transport package     concrete implementation
```

Two consequences worth stating, because they are what make the diagram more than decoration:

- **`features/` cannot open a socket or send a request.** Everything it needs arrives
  constructed, from `app/composition_root.dart`. So a reconnect bug is one file, not a search
  through the UI.
- **`data/` holds the policy, so a screen cannot skip it.** `AgentRepository.dispatch` runs the
  biometric gate (ADR-8) and the credential freshness check (ADR-12 no. 2) itself; there is no
  other path to a mutation. Its tests assert the stronger thing — that a refused gate leaves
  `http.sent` **empty**, not merely that it returned false.

Inherited rules, from `packages/host/CLAUDE.md`: **300 lines per file** (also enforced by the
layering test), TDD, dependency injection through constructors, no wild `dynamic` (enforced by
`strict-casts` / `strict-raw-types` / `strict-inference` in `analysis_options.yaml`), no bare
`print`.

### Launch

Three things sit between the OS launcher and the screen the operator wanted, and they are
described in [`design/onboarding-splash.html`](../../plans/lotus-pocket/design/onboarding-splash.html).

The **launch window** is `#121214` on both platforms and in both `values/` and
`values-night/`. The Flutter template shipped `@android:color/white` in the light variant and
a white `LaunchScreen.storyboard`, so a phone with dark mode *off* flashed a full white window
for as long as `main()` spent on Firebase and the Keystore. It is invisible to anyone testing
with dark mode on, which is how it survived — turn dark mode off before deciding this looks fine.

**The app icon is part of the launch screen, not a separate concern.** On API 31+ Android
draws the platform SplashScreen over the launch window, and this ROM (Transsion/XOS)
**ignores `windowSplashScreenBackground` and `windowSplashScreenAnimatedIcon`** — proved by
shipping a build whose background was magenta (`aapt2 dump resources` confirmed `#ffff00ff`
in the installed APK) and finding no magenta in a screen recording of a cold start. What it
draws is the launcher icon, so the stock Flutter logo appeared before Lotus's own splash. The
fix is `mipmap-anydpi-v26/ic_launcher.xml` — an adaptive icon whose foreground is the same
mark. `values-v31/styles.xml` stays for the devices that do honour it.

Two consequences worth keeping: the Dart splash draws its mark at **116 dp, the size the
platform icon is drawn at**, and **centred on the screen rather than in a column with the
wordmark** — sharing a column lifted it by half a line of type and the two marks cross-faded
past each other as a visible double exposure. Both are pinned by `splash_gate_test.dart`.

The **splash** (`features/splash/`, held by `app/splash_gate.dart`) takes **a duration and no
future**, and that is load-bearing rather than a simplification. `CompositionRoot.boot` awaits
`credentials.load()` and `seenMarks.load()` itself and `main()` awaits *that*, so every local
fact is known before the first frame; the only thing still outstanding is `root.start()`, which
`main()` pointedly does not await (R-11). A `Future ready` parameter here would have had exactly
one possible use — waiting on a socket, on the screen where doing so is least visible. There is
no such parameter.

The **intro** (`features/onboarding/intro_pages.dart`) shows once, on a phone with no
credential that has never seen it, and `app/launch_route.dart` holds the rule that decides:
**paired wins over intro-seen, always.** A phone that already holds a credential has an operator
who has used this app, whatever the stored bit says — re-showing an introduction after an update
is the thing that rule exists to forbid. Unpairing the last machine returns to the pairing form,
not to the intro.

`tool/preview_launch.dart` runs the whole sequence against an in-memory store, so unlike
`preview_home.dart` it can be pointed at a phone that is genuinely paired without touching that
pairing. Hot-restart replays the intro.

### Theme

Colours and type live in `AppTokens`, a `ThemeExtension`, read as `context.tokens`. Values are
the `:root` block of the locked mockup verbatim — which are themselves copied from
`apps/desktop/src/styles/canvas/theme.css`, so `--d-bg` and `--canvas-bg` are the same
`#07070d`. Change a colour in the mockup first; this follows it.

`buildAppTheme({tokens, brightness})` is the only place `ThemeData` is built. A second theme —
light, high-contrast, a per-test palette — is a second `AppTokens` constant handed to it, not a
second builder.

One rule the theme enforces on purpose: **`waiting` (amber) is not mapped to any `ColorScheme`
role.** `MVP.md` gives amber exactly one meaning — an agent needs you — so a default-styled
Material widget must not be able to pick it up as an accent. Reaching it is always a deliberate
`context.tokens.waiting`.

### Chat

Chat follows the socket. The host already broadcasts every hook event to every paired
device (`{type: "notification", …}` from `stream-hub.ts`), and that frame *is* one
transcript entry — [`LiveTranscript`](lib/data/live_transcript.dart) turns it into one.
Before that existed, Chat was a single REST fetch: it filled on open and then stood
still, so the way to see new output was to leave the page and come back. It costs
nothing extra on the wire, because unlike PTY output those frames arrive whether or not
anyone reads them.

Two things in it are easy to get wrong and have tests naming why. `watch()` runs
**before** the REST fetch and `seed()` merges rather than replaces, so events arriving
during the round trip are not erased by the snapshot that follows. And dedup uses a
composite key, not "newer than the last seed entry" — hook timestamps come from
`Date.now()`, so a burst of tool events shares a millisecond, and a `>` comparison
drops a real step while `>=` duplicates one.

**Chat draws parts, not hook events** (2026-08-27, `plans/pocket-chat-conversation-model`).
`LiveTranscript` still stores the entries the socket delivers, but nothing renders one
directly any more: [`conversation_builder.dart`](lib/data/conversation_builder.dart) turns
them into turns of typed parts — `user_message`, `assistant_text`, `tool_call{kind,status,
diff}`, `error`, `unknown` — and [`chat_transcript.dart`](lib/features/agent/chat_transcript.dart)
only decides which typeface each part gets. A tool's call and result are **one** line now;
they used to be two. The builder is a port of the host's `parts-from-entries.ts`, and
`test/data/conversation_builder_test.dart` pins it to the host's own output: the committed
`rest-transcript.json` must convert into exactly the committed `rest-conversation.json`. One
rule in two languages, held together by a fixture rather than by trust. What this app knows
about a runner by name — family, gate, display name — lives in one place too,
[`runner_family.dart`](lib/models/runner_family.dart).

**The agent writes markdown, so Chat renders it** — via `gpt_markdown`, chosen after
counting what 279 real replies actually contain (inline code 30%, bold 27%, fenced
blocks 25%, bullets 17%, headings 10%, nested lists and tables ~4% each). A hand-rolled
subset would cover the head of that list and mangle the tail. Every builder in
[`agent_prose.dart`](lib/features/agent/widgets/agent_prose.dart) exists to *remove*
something the renderer brings: blue links, Material's sans headings, a grey code panel.
This screen allows two colours and three typefaces, and a sans heading inside the
agent's own words is a fourth voice — which is exactly what showed up the first time it
ran on the emulator.

Chat sticks to the bottom until you scroll up, and offers a caret to come back. That is
also what puts a waiting permission card on screen: the card renders *after* the
transcript, so before this a long enough turn pushed the thing that woke the operator
below the fold.

### Diagnostics

The third screen (`PLAN.md` §4.2), reached from the last row of the switcher sheet. It exists
because of a tension the rest of the app creates on purpose: **every other surface hides what a
host does not advertise** — no Chat on a Standalone Host, no push registration where there is no
service account — and that is what keeps them calm, but it also makes an absent capability
indistinguishable from a broken one. This screen is where the difference is written down.

Per host it prints the origin *with its scheme* (`ws` against `wss` is decided by it), `hostCaps`
verbatim, the reachability failure as its **stable slug** rather than prose — `HostFailure.code`
documents itself as being for diagnostics, and `issues/06` still owns the operator-facing
wording — both credential clocks as time remaining, and which half of push is missing. It also
surfaces `Credentials.unreadable`, which had been collected since that class was written and
rendered nowhere.

Two things it deliberately does not do. It **never shows the FCM registration token**: that is the
capability to ring the phone, the host keeps it out of its own audit log, and `Diagnostics` reads
only whether one exists — asserted by rendering the real screen over a real token and sweeping
every string in the tree. And it does **not sort by health**: rows stay in pairing order, because a
list that floats the failing host to the top reorders itself under the reader's finger every time
a socket flaps.

The one control is **Unpair**, which revokes against the host first (`DELETE /m/devices/:deviceId`)
and then forgets locally. Best-effort by design — the commonest reason to unpair is a machine that
is gone, and an unpair that only worked while the host answered would be no way out at all. No
biometric gate: ADR-8 gates what reaches a machine, and gating this would be backwards, since the
credential most in need of clearing is a dead one.

## What is not built yet

| Missing | Why |
|---|---|
FCM plugin + Firebase project | Everything around it is built and tested; see [Finishing push](#finishing-push). The app ships `UnavailablePushTokens`, so it registers nothing and runs on its live socket exactly as before — deliberately, so the whole path could land before an account existed. |
QR pairing | **No producer exists.** ADR-5 sketched a QR carrying `{baseUrl, hostLabel, pairingCode}`, but the desktop as built (`MobileTab.tsx`) prints a `Listening on host:port` line and an 8-digit code grouped in fours *to be typed on a keypad*. Nothing renders a QR, so onboarding takes both by hand. A scanner would be a consumer with no producer. |
Staleness / unreachable UI | `map.md` still calls the thresholds fog, pending `issues/02`. Guessing them would put an unmeasured diagnosis on screen. |
iOS | ADR-9 defers it; this machine has no Xcode, so no simulator either. `NSFaceIDUsageDescription` is already in `Info.plist` for when it lands. |

## Finishing push

The host half is done (`packages/host/src/adapters/mobile/push/`), the app half is
wired, and both are tested. What is missing is a Firebase project — which only you can
create, because the key it produces authorises sending to every device in it.

The design decides two things before you start, and they are worth knowing so the
console choices make sense:

- **The wake-up says one fixed sentence:** *"An agent needs you"*. Android draws it
  without the app running; the app then fetches `/m/bootstrap` over the tailnet with its
  own bearer to find out *who*. The notification events behind it carry `tool_target` and
  `cwd`, and routing those through Google would contradict the posture that keeps the Rust
  API on localhost and provider keys on the host. Because the title is a constant and the
  sender receives only a registration token, there is nothing identifying in scope to
  leak — and no local-notification plugin is needed to display it.
- **No Play Store is needed.** FCM requires Google Play *Services* on the device, not
  store distribution, so a sideloaded APK works and ADR-9 stands.

### 1. Firebase project

1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**
2. **Add app → Android**, package name **`com.serayu.lotus_pocket`** (must match
   `applicationId` in `android/app/build.gradle.kts`)
3. Download **`google-services.json`** → `apps/pocket/android/app/google-services.json`
4. **Project settings → Service accounts → Generate new private key** → save it as
   **`~/.lotus-dev/fcm-service-account.json`** (or `~/.lotus/` for a release build) and
   `chmod 600` it

That path is not a convenience default. Lotus spawns the host runtime with an explicit
allow-list environment (`host_runtime/supervisor.rs::build_env`), and Lotus launched from
Finder has no shell environment — so `export LOTUS_FCM_SERVICE_ACCOUNT` in a terminal
reaches nothing and push would stay silently off. `LOTUS_STATE_DIR` *is* passed, and
`api-server.key` and `mobile-devices.json` already live there, so dropping the file
beside them is the whole configuration step. The env var remains an override for a VPS
running the host directly.

Those two files are different things and the difference matters: `google-services.json`
is client config and belongs in the app; the service account key **signs sends for the
whole project** and belongs nowhere near it. The repo's `.gitignore` refuses
`*service-account*.json` and `fcm-*.json` in case a `git add -A` ever tries.

The host warns on startup if that key is readable beyond its owner, logs
`mobile.push.enabled` with the project id when it loads, and `mobile.push.disabled` when
it is absent.

### 2. Plugin and one adapter

```yaml
# pubspec.yaml
firebase_core: ^<latest>
firebase_messaging: ^<latest>
```

Then the only Dart left to write: a `PushTokens` implementation backed by
`FirebaseMessaging` — `available` (Play Services present), `requestToken` (ask for the
Android 13+ grant, then `getToken()`), and `refreshed` (`onTokenRefresh`). It goes in
one file that nothing but `composition_root.dart` imports, exactly like
`DeviceBiometrics` and `KeychainStore`, and it is passed as `pushTokens:` to
`CompositionRoot.boot`. `POST_NOTIFICATIONS` is already declared in the manifest.

Nothing else changes: `PushRepository` already registers with every host that advertises
`push`, re-registers on rotation, skips hosts that cannot send, and withdraws on `stop()`.

### 3. What to check once it runs

- `hostCaps.features` contains `push` — if not, the host did not load the key, and the
  app is right not to register a token it would wait on forever
- `POST /m/devices/push-token` in the host log, then `push: true` for that device in
  **Mobile Access → Paired devices** on the desktop
- Background the app, make an agent ask for permission, and watch the phone wake

One limit stated rather than discovered later: only `status: "needs-input"` is pushed
today. `cell_stalled` is deliberately excluded, and `issues/04` owns whether that widens
— it is still blocked on `issues/02`.
