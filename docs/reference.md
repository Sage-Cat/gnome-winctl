# Placement and recovery reference

[Overview](../README.md) · [Usage](usage.md) · [Architecture](architecture.md)

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

An explicit resize on the active workspace raises the window before requesting
its new frame. This lets covered Wayland clients finish resizing without taking
keyboard focus. Position-only moves and already verified placements preserve
stacking order; placement never activates another workspace.

## D-Bus API

The extension owns `org.sagecat.GnomeWinCtl1` at
`/org/sagecat/GnomeWinCtl1`. The versioned XML contract is in
[`dbus/org.sagecat.GnomeWinCtl1.xml`](../dbus/org.sagecat.GnomeWinCtl1.xml).

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
