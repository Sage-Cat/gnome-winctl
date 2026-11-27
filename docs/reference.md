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

`GetState` and `ListWindows` include a window's physical `monitor_intent` while
workspace recovery owns its anchor. The window's `monitor`, `monitor_geometry`,
`geometry`, and `geometry_relative` describe the current compositor observation.
The CLI enriches that observation as `monitor_identity` and preserves the intent
for snapshot consumers.

An explicit frame change on the active workspace raises the window so covered
Wayland clients can finish pending moves and resizes. It does not take keyboard
focus. Already verified placements preserve stacking order; placement never
activates another workspace.

Maximizing waits for the normal frame to settle for 400 ms before applying the
maximized state. Final verification uses the current monitor work area. Each
verification pass, including the normal-frame settle and maximize, has a
ten-second limit; a staged handoff verifies its final workspace in a separate
pass with its own limit. If the window frame, monitor, workspace and state stay
unchanged for one second while the applied target is still unmet, the pass
reapplies that target once; the failure record reports `reapplied`. Repeating an identical in-flight
request reuses its token; a changed target or desktop topology starts a new one.

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

### Exact window close

The `close_window` capability adds `CloseWindow`, which accepts a JSON object
with integer `id`, `workspace` and `pid` fields and a string `epoch`. The epoch
must equal `GetState.enable_epoch` from the state that reported the window. Each
extension enable generates a new epoch, including after a Shell restart. The
optional `workspace_name` requires a unique configured name at that index in
static workspace mode.

The Shell finds the window by ID in its managed window list and checks the
epoch, workspace, PID and eligibility in the same callback as the close. The
operation sends the native Wayland close event to that window's surface. The
client decides how to handle it, including whether to present a save dialog.
Sibling windows in the same process can remain open. The service refuses
sticky windows, transients, parents with transient children, locked sessions,
and clients outside native Wayland. Mutter's XWayland close can fall back to
disconnecting a client that lacks `WM_DELETE_WINDOW`.

The JSON receipt contains `status` with one of `requested`, `absent`, or
`refused`. Refusals include a `reason` code and `message` for diagnostics.
`requested` acknowledges the event and callers can poll `GetState` for the
result. There is no close method on the legacy session bridge.

For preflight, `GetState` exposes `dynamic_workspaces` and `screen_unavailable`.
Each workspace reports `named` and `blocking_windows`. The count includes managed
windows missing from the normal window list, including dialogs, and excludes
desktop, dock, sticky and override-redirect surfaces. Named close rechecks this
count before sending the event. Listed windows report `sticky` and `close_blocker`,
whose value is a refusal code or null when the window itself is eligible.

The project was independently implemented against Mutter's window APIs. The
Window Calls extension was used as a behavioral reference for the established
pattern of exposing GNOME Shell window operations over the session bus; none of
its GPL-licensed source is incorporated here.
