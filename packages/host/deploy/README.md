# Deploying the Standalone Host to a VPS

Three files and one rule: **nothing here opens a port to the internet.** The host binds
a private address, and reaching it is the operator's existing private path (ADR-C in
`plans/pocket-without-laptop/PLAN.md`).

**On `devbox-vps` there are two such paths, not one,** and this file used to name only the
first — which cost most of an afternoon on 2026-09-11, because the one it named was the one
that was down:

| Path | What it is good for | What stops you |
|---|---|---|
| Cloudflare Access (`ssh devbox-vps`) | An `ssh` from anywhere, no VPN | The Access token expires and is renewed by a **browser** SSO round. `~/.cloudflared/` empty means you are about to be asked for one, and an agent or a CI job cannot answer it |
| Tailscale (`100.64.0.10`) | `ssh`, `scp`, and the phone's own `/m/*` traffic | Both ends must be on the tailnet |

The phone had been using the second the whole time — `LOTUS_MOBILE_BIND` on `devbox-vps` is
its tailnet address, which is why Pocket kept working while `ssh devbox-vps` did not. When
one path is dead, try the other before concluding the machine is unreachable:

```bash
ssh devbox-vps 'echo ok'                       # Cloudflare Access
ssh -i ~/.ssh/devbox-vps-alwi alwi@100.64.0.10 'echo ok'   # tailnet
```

| File | What it is |
|---|---|
| `install.sh` | Preflight that refuses, then installs and proves the host answers |
| `lotus-host.service` | systemd unit template; `install.sh` fills in the placeholders |
| `.env.vps.example` | Every environment variable the host actually reads, and why |

## The short version

```bash
sudo cp deploy/.env.vps.example /etc/lotus-host.env
sudo $EDITOR /etc/lotus-host.env          # at minimum: LOTUS_FCM_SERVICE_ACCOUNT, PROJECTS_ROOT
bash deploy/install.sh --preflight-only   # check the machine, change nothing
bash deploy/install.sh                    # install, start, and verify /admin/health
```

Then point the machine's existing private path at `LOTUS_MOBILE_BIND`, and pair a phone:

```bash
bash deploy/pair.sh                                   # QR + code, bound address
bash deploy/pair.sh --address https://pocket.example  # behind a tunnel: what the phone dials
```

`pair.sh` reads the admin secret from the env file and the admin port from the advert,
mints a code, and prints the same `lotus-pair://` invite the desktop's QR carries — as a
scannable QR when `qrencode` is installed (`sudo apt install qrencode`). It is also the
way back in when a phone's credential has lapsed: run it again over `ssh` and scan. A
façade bound to loopback is refused as an address, because the phone would dial its own
`127.0.0.1`; pass `--address`, or set `LOTUS_PAIR_ADDRESS` in the env file once.

## What the preflight refuses, and why

Every refusal names the consequence, because "codex: not found" tells an operator nothing
about the phone that will fail every spawn.

- **Agents left in tmux** (a warning, not a refusal) — a host from before 2026-11-17 kept its
  agents in tmux as `lotus-*`. The new host keeps them in `lotus-sessiond` and does not see
  the old ones: they run on, unreachable from the phone. Finish or stop them before deploying
  (`tmux ls | grep '^lotus-'`). Your own tmux sessions are not touched.
- **No runner** (neither `claude` nor `codex` on the run user's **login** PATH) — the host
  would start, accept a phone, and fail every spawn. One of the two missing is a warning:
  without `codex` the host does not advertise `structured-spawn`, and the phone loses
  permission, transcript and Chat on it (`STRUCTURED_FEATURES` in `adapters/mobile/events.ts`).
- **`LOTUS_MOBILE_BIND` on `0.0.0.0`** — ADR-C. Device tokens are authorisation, not a
  substitute for not being on the internet.
- **`LOTUS_FCM_SERVICE_ACCOUNT` set but unreadable** — the config claims push works while
  it does not, which is the silent failure this product is least able to survive. Unset is
  a choice, so that is a warning instead.
- **No runtime** — neither a compiled host nor a `bun` to run the source with.

Detection uses the **login** PATH (`bash -lc`), not this script's. `bun`, `claude` and
`codex` install under `~/.bun/bin` and `~/.local/bin`; a non-login probe reported both
missing on a box that had them (`issues/04`, 2026-08-30).

## Runtime: a binary, or bun on the source tree

`install.sh` prefers a compiled single file (ADR-F) and falls back to bun. Build one from
any machine — bun cross-compiles:

```bash
# From the repo root. Builds lotus-sessiond for Linux in Docker (ADR-0067), then the host
# with the daemon embedded. `bun run build:vps` alone refuses until the daemon is built.
bun run host:build:vps     # packages/host/dist/lotus-remote-bin-linux-x64, ~100 MB
# A failed build leaves the OLD binary in dist/ (2026-11-20: a deploy shipped the 3-day-old one).
# Check the date, then compare `md5 -q` here with `md5sum` on the box before installing.
ls -l packages/host/dist/lotus-remote-bin-linux-x64

# Over Cloudflare Access. On devbox-vps the deploy/ folder lives at ~/lotus-deploy/.
scp packages/host/dist/lotus-remote-bin-linux-x64 devbox-vps:/tmp/
ssh devbox-vps 'bash ~/lotus-deploy/install.sh --binary /tmp/lotus-remote-bin-linux-x64'

# Or over the tailnet, when the Access token has expired:
scp -i ~/.ssh/devbox-vps-alwi \
    packages/host/dist/lotus-remote-bin-linux-x64 alwi@100.64.0.10:/tmp/
ssh -i ~/.ssh/devbox-vps-alwi alwi@100.64.0.10 \
    'bash ~/lotus-deploy/install.sh --binary /tmp/lotus-remote-bin-linux-x64'
```

Written out twice rather than as a `$VPS` variable on purpose: `ssh $VPS` with flags inside
the variable does not word-split under zsh, which is the login shell here — it passes the
whole string to `-i` and fails with `hostname contains invalid characters`. Measured
2026-09-11, while writing this paragraph.

The copy takes **90 seconds to 3½ minutes** over the tailnet for the ~100 MB binary
(90 s measured 2026-09-11, 3 m 28 s on 2026-09-18 — same link, same size); it is not hung.
The range is the point: this sentence exists so nobody kills a transfer at two minutes, and
a single number invites exactly that.

The binary carries no `node-pty`, so it needs no compiler, no Python and no Node on the
target. The PTYs belong to `lotus-sessiond` (ADR-0067), a static Linux binary embedded in
`lotus-host` and extracted to `~/.lotus/host-sessiond/bin/` on first start; the host spawns
it when none is listening. Nothing to install, tmux included.

## Verified, and not yet verified

Measured 2026-09-05 against a `bun --compile` build of this package, on a **clean HOME**
with no `~/.lotus` at all:

```
{"event":"host.start","adapter":"mobile","host":"127.0.0.1","port":8799}
GET /admin/health → {"ok":true,"hostId":"vps-smoke","mode":"standalone",
                     "mobile":{"host":"127.0.0.1","port":8799},"deviceCount":0}
```

**Verified on Linux, 2026-09-11.** The cross-compiled ELF x86-64 binary was installed on
`devbox-vps` over the tailnet and restarted under systemd:

```
build: 52e15e7f-dirty-2026-09-11   (was 7c5f6b5f-dirty-2026-09-11)
GET /admin/health → {"ok":true,"hostId":"vps","mode":"standalone",
                     "mobile":{"host":"100.64.0.10","port":8787},"deviceCount":4}
```

Then exercised from a real phone, which is the only check that covers the whole chain: a
repository cloned from Pocket through `POST /m/projects/clone` appeared as a project on the
index with no restart (`plans/pocket-vps-project-checkout`).

**Back up before you replace it — nothing does it for you.** `install.sh` runs a plain
`sudo install` over `/usr/local/bin/lotus-host`, so the running binary is gone the moment it
succeeds and there is no way back to it but a rebuild of the old commit.

This paragraph used to say the opposite — *"`install.sh` does; a hand-rolled `install` does
not"* — and it was never true: `grep -n backup deploy/install.sh` finds nothing, and every
`lotus-host.bak-*` on `devbox-vps` was made by a hand that had read this line and checked
anyway. Corrected 2026-09-18, after a deploy trusted it.

```bash
sudo cp /usr/local/bin/lotus-host "/usr/local/bin/lotus-host.bak-$(date +%Y%m%d-%H%M%S)"
```

## `/admin/health` is the check, `systemctl is-active` is not

`is-active` proves a process exists. `/admin/health` reports what a phone would find:

```json
{"ok":true,"build":"0ae0e1a6-2026-09-11","hostId":"vps","mode":"standalone","mobile":{"host":"127.0.0.1","port":8787},"deviceCount":0}
```

`"mobile":null` is the interesting failure — the host is up and **no phone can reach it**.
That distinction is why the field is nullable rather than absent.

## Is the VPS running what you just built?

`build` is `git describe` plus the commit date, baked in by `--define` at compile time — so it
cannot be set by a deploy script and cannot drift from the binary it names. From source it
reads `dev`, which is the truth rather than a guess.

Compare the two in one line, from the machine you built on:

```bash
diff <(ssh devbox-vps 'S=$(grep LOTUS_MOBILE_ADMIN_SECRET /etc/lotus-host.env | cut -d= -f2)
        curl -s -H "Authorization: Bearer $S" \
        http://127.0.0.1:$(jq -r .port ~/.lotus/mobile-admin.json)/admin/health \
        | jq -r .build') \
     <(echo "$(git describe --always --dirty --tags)-$(git log -1 --format=%cs)") \
  && echo "VPS is running this commit"
```

Swap `devbox-vps` for `-i ~/.ssh/devbox-vps-alwi alwi@100.64.0.10` when Access is down.

**The secret is read out of `/etc/lotus-host.env`, not out of the shell.** systemd hands it to
the unit; an interactive `ssh` gets no such thing, so the older form of this snippet sent an
empty bearer and answered `401` — which reads as *the host is broken* rather than *you did not
pass the secret*. Measured 2026-09-11.

**This exists because the absence of it cost a day.** On 2026-09-10 the VPS ran a binary four
days old. Nothing said so: `/health` carried a hardcoded `"0.1.0"` that never moved, and the
only signal that did move was `hostCaps.features` — which *implies* an age rather than stating
one. The drift was found by putting two hosts side by side and noticing a feature pair the
current code cannot produce apart. With one host, or without that memory, it stays invisible.

The admin surface is loopback-only and needs `LOTUS_MOBILE_ADMIN_SECRET`. Without that
secret the adapter starts with **no admin surface at all** rather than an unauthenticated
one, which also means no health check and no way to mint a pairing code. `install.sh`
generates one when the field is left blank.
