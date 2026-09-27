# gnome-winctl

`gnome-winctl` is a small, reusable window-placement service for native GNOME
Wayland sessions. A GNOME Shell extension performs compositor-owned operations;
the command-line client exposes them to scripts and session managers.

It deliberately manages placement only. Applications and higher-level tools
remain responsible for launching processes and restoring application state.

## Capabilities

- list normal windows, logical monitors, and workspaces;
- address an existing window by its session-local Shell ID, PID, exact title,
  or application ID, rejecting ambiguous selectors;
- request workspace, monitor, logical geometry, and window state, then verify completion;
- reserve placement for the next matching window before it is created;
- query or cancel an outstanding placement reservation;
- resolve workspace names and physical displays with EDID, connector, serial,
  model, index, and primary-monitor fallbacks;
- preserve each window's physical display through lock, wake, and monitor
  topology churn without fighting intentional window moves;
- emit JSON suitable for other tools.

Window IDs are intentionally session-local and must not be persisted.

## Monitor intent and recovery

The Shell extension is the single owner of both explicit placement and display
recovery. It obtains connector, model, and serial sets asynchronously from
Mutter DisplayConfig and uses logical geometry only when Mutter exposes no
physical identity. The CLI can additionally use the kernel EDID hash while
resolving a requested display.

GNOME's native `move-to-monitor-*` shortcuts remain available. Enhanced
interception is installed only when Mutter exposes a supported custom-handler
ownership getter; the installed GNOME 46 API does not. In that case winctl
does not replace unknown handlers or reset another extension's handler to null.
`monitor_policy.keybinding_compatibility` reports this limitation. Pointer and
keyboard grabs, Overview window drags, and D-Bus placement remain
authoritative. Outside a lock/topology recovery transaction, an otherwise
unexplained move becomes the new intent after a short topology-event grace;
Mutter does not expose enough provenance to distinguish it safely from a move
made by a tiling extension.

Locking freezes anchors. Unlock and `monitors-changed` start a debounced,
retry-bounded recovery transaction. Mutter does not reliably apply monitor
moves to unmapped windows on inactive workspaces, so those placements remain
durably pending and their anchors cannot be overwritten by late compositor
moves. After that workspace becomes active, bounded repeated checks cover the
entire mapping transition before the pending marker is cleared. This avoids
false success reports and forced workspace switches. Absent or ambiguous
displays are left alone until a later topology event makes the identity unique.
An explicit request for an unavailable or ambiguous physical display fails
without moving the window to an unrelated fallback. Recovery is move-bounded and retains a per-window
retry circuit breaker. `gnome-winctl state` reports the policy state under
`monitor_policy`.

## Install

```sh
make test
make install
gnome-extensions enable gnome-winctl-v3@sagecat.local
```

Log out and back in after the first installation or an extension update when
GNOME Shell has cached the previous module or extension metadata. Stay in the
native Wayland session.

During an in-place migration from the former wsctl Shell extension,
`gnome-winctl` can use that already-loaded service as a session bridge. The
bridge supports inspection and exact-title placement without restarting Shell;
next-window reservations and exact Shell IDs become available when the new
extension loads at the next normal login. `gnome-winctl status --json` reports
`"backend":"legacy-session-bridge"` and its reduced capability list while this
fallback is active. A no-op compatibility stub keeps the old UUID installed so
GNOME does not discard the already-loaded bridge; on subsequent logins the stub
does nothing and the standalone extension owns the current API.

Installation preserves a former real compatibility-extension directory in a
uniquely named backup before replacing it with the intended symlink. A failed
symlink installation restores that directory. Installation does not reload Shell.

The runtime has no third-party Python dependencies. Development checks require
Python 3.10 or newer and Node.js for JavaScript syntax validation.

## Usage

```sh
gnome-winctl status
gnome-winctl windows --json
gnome-winctl monitors --json
gnome-winctl workspaces --json

gnome-winctl place 42 \
  --workspace research \
  --monitor DP-1 \
  --geometry 30,40,1800,1000 \
  --state maximized

gnome-winctl expect \
  --app-id google-chrome \
  --workspace research \
  --monitor DP-1 \
  --geometry 30,40,1800,1000 \
  --state maximized \
  --wait
```

Geometry is monitor-relative by default, using GNOME logical coordinates.
`--global-coordinates` accepts current global desktop coordinates. Placement is
clamped to the selected workspace's work area unless `--no-clamp` is supplied.

For integration, every command accepts `--json`. `place` and `expect` also
accept `--selector-json` and `--target-json`, which are the stable machine
interface used by `wsctl`.

## D-Bus API

The extension owns `org.sagecat.GnomeWinCtl1` at
`/org/sagecat/GnomeWinCtl1`. The versioned XML contract is in
`dbus/org.sagecat.GnomeWinCtl1.xml`.

The `placement_lifecycle_v2` capability distinguishes `accepted`, `deferred`,
`applied`, `verified`, and `failed` placement outcomes. `placed` is true only
for `verified`. `PlaceWindow` returns a stable `token`; query it through
`ExpectationStatus`, or cancel it through `CancelExpectation`. `target` retains
physical monitor intent and monitor-relative geometry; `resolved_target` records
the compositor target for the latest application. Deferred replay resolves that
intent again after monitor hotplug/reordering and reports errors on the same token.

`place` exits successfully when a request is accepted, including deferred work;
this is not proof of final placement. `place --wait` and `expect --wait` require
verified completion and return nonzero on a wait timeout. Waiting never activates
another workspace. A matched window deferred on an inactive workspace retains its
intent until activation, explicit cancellation/supersession, or window destruction.
The reservation timeout limits waiting for a newly created window; an older
window's pending callback cannot consume a newer reservation. Verification after
application is bounded. Active requests are capped at 256; terminal status history
retains up to 256 entries for five minutes. Expired history returns `unknown`.

`GetCapabilities` and `GetState` report `build: {uuid, version, revision}` and a
unique `enable_epoch`. Release staging stamps `buildInfo.js`; a source checkout
reports revision `development`. This distinguishes installed files from the code
actually loaded in Shell without triggering a restart.

The project was independently implemented against Mutter's window APIs. The
Window Calls extension was used as a behavioral reference for the established
pattern of exposing GNOME Shell window operations over the session bus; none of
its GPL-licensed source is incorporated here.

## Checks and releases

```sh
make test
```

The [CI workflow](.github/workflows/ci.yml) verifies each change. Successful pushes
to the default branch publish a commit-addressed `build-<full-commit-SHA>` release
with a source archive, applicable extension bundles, and SHA-256 checksums.
See the [release process](https://github.com/Sage-Cat/workspace-state/blob/main/docs/publication.md) for artifact and verification details.

The local pre-commit privacy gate blocks private files before they enter a commit.
Enable it in a fresh clone with `git config core.hooksPath .githooks`.
CI repeats the privacy check before building or publishing.
