# gnome-winctl

Move and inspect windows in a native GNOME Wayland session from the command line.
A GNOME Shell extension performs the window operations; a Python client exposes them to scripts.

- List windows, monitors and workspaces.
- Place an existing window or reserve placement for a new one.
- Verify placement and track requests deferred on inactive workspaces.
- Recover a window's intended display after lock, wake or monitor changes.

It manages placement. Your application or session manager must launch programs
and restore their contents. Window IDs are valid only for the current Shell session.

![A placement request changes from deferred to verified](docs/screenshots/placement.png)

This capture uses a real disposable GNOME session and a synthetic window.
Placement becomes verified after its workspace is activated. Request coordinates
are monitor-relative; the resulting window geometry uses global coordinates.

## Install

Requires GNOME Shell 46 on Wayland, Python 3.10+, `gdbus`, and
`gnome-extensions`. Development checks also require Node.js.

```sh
make test
make install
gnome-extensions enable gnome-winctl-v3@sagecat.local
```

Log out and back in if Shell has cached the previous extension. The standalone
installer links the CLI to this checkout, so keep the checkout in place.

## Usage

```sh
gnome-winctl status --json
gnome-winctl windows --json
gnome-winctl monitors --json
gnome-winctl workspaces --json

# Replace 42 with an ID from the current window list.
gnome-winctl place 42 --workspace 1 --monitor 0 \
  --geometry 30,40,1200,800 --state normal --wait
```

Workspace and monitor indices start at zero. Without `--wait`, success can mean
accepted rather than verified. Deferred placement does not switch workspaces.
Window inventories may contain private titles; review them before sharing.

## Documentation

- [Usage, request lifecycle, troubleshooting and capture reproduction](docs/usage.md)
- [Architecture and source map](docs/architecture.md) · [PlantUML source](docs/architecture.puml)
- [Placement and recovery reference](docs/reference.md) · [D-Bus contract](dbus/org.sagecat.GnomeWinCtl1.xml)
- [Releases](https://github.com/Sage-Cat/gnome-winctl/releases) · [Publication process](https://github.com/Sage-Cat/workspace-state/blob/main/docs/publication.md)
