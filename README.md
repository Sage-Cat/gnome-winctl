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
- atomically apply workspace, monitor, logical geometry, and window state;
- reserve placement for the next matching window before it is created;
- query or cancel an outstanding placement reservation;
- resolve workspace names and physical displays with EDID, connector, serial,
  model, index, and primary-monitor fallbacks;
- emit JSON suitable for other tools.

Window IDs are intentionally session-local and must not be persisted.

## Install

```sh
make test
make install
gnome-extensions enable gnome-winctl@sagecat.local
```

Log out and back in after the first installation or an extension update when
GNOME Shell has cached the previous module or extension metadata. Stay in the
native Wayland session.

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

The project was independently implemented against Mutter's window APIs. The
Window Calls extension was used as a behavioral reference for the established
pattern of exposing GNOME Shell window operations over the session bus; none of
its GPL-licensed source is incorporated here.
