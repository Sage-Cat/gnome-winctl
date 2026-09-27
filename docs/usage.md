# Quick start and troubleshooting

[Overview](../README.md) · [Architecture](architecture.md)

## Inspect before changing placement

Use a native GNOME Wayland session. The extension currently declares support for
GNOME Shell 46. The Python client requires Python 3.10+, `gdbus`, and the matching
Shell extension; Node.js is required for development checks.

From a checkout:

```sh
make test
make install
gnome-extensions enable gnome-winctl-v3@sagecat.local
gnome-winctl status --json
```

A first installation or an updated Shell module may require a normal logout and
login before it becomes available. Installation does not restart Shell. The
standalone installer links the CLI to this checkout, so keep the checkout in
place. A higher-level release installer may instead install an immutable copy.

Inspect available targets without moving anything:

```sh
gnome-winctl windows --json
gnome-winctl monitors --json
gnome-winctl workspaces --json
```

These results can contain private window titles and monitor identities. Review
and redact them before publishing an issue or screenshot.

## Place an existing window

Choose an ID from the current `windows` result. This example uses illustrative
ID `42`, zero-based workspace `1`, and monitor `0`; substitute current values:

```sh
gnome-winctl place 42 --workspace 1 --monitor 0 \
  --geometry 30,40,1200,800 --state normal --wait --timeout 20
```

Geometry is relative to the chosen monitor in logical pixels. Work-area clamping
is enabled by default. Monitor `0` means index zero, not the primary monitor;
use `--monitor primary` when that is the intended behavior. Exact window IDs
expire with the Shell session: never use yesterday's ID to identify today's
window.

`--wait` requires verified placement. Without it, exit success can mean only that
the request was accepted. A window on an inactive workspace can remain deferred;
waiting does not switch workspaces for you. Read the returned token with:

```sh
gnome-winctl expectation TOKEN --json
```

Cancel a pending request with `gnome-winctl cancel TOKEN`. Cancellation does not
undo a placement already applied.

## Reserve placement for a new window

Before launching an application, register a reservation with `expect`. Use an
application identifier appropriate for the window you will launch:

```sh
gnome-winctl expect --app-id org.gnome.TextEditor \
  --workspace 1 --monitor primary --geometry 30,40,1200,800 \
  --state maximized --timeout 30
```

Launch the application separately and poll the returned token. Reservations match
new windows; they do not restore application content. Add `--wait` only when
another process will create the matching window while the command waits.
Selectors must identify one window; ambiguous titles or application matches are
rejected rather than choosing an arbitrary window.

## Troubleshooting

| Symptom | Check and action |
|---|---|
| Service unavailable | Confirm a Wayland GNOME session, extension enabled, and `gdbus` installed. After an extension update, use the next normal login. |
| `legacy-session-bridge` backend | A migration bridge is loaded. Its reduced capabilities are reported by `status`; the standalone extension loads at the next normal login. |
| Accepted or deferred, but no visible move | Query the token. An inactive workspace can delay application; activate it normally and check again. |
| Selector rejected | Refresh `windows`; use an exact current ID or a unique selector. |
| Display unavailable or ambiguous | Refresh `monitors` and check physical connections. The service refuses to substitute an unrelated display. |
| Wait timed out | Inspect the token's current state; the wait deadline does not prove that a deferred placement was cancelled. Cancel explicitly if no longer wanted. |
| Installed files differ from loaded behavior | Compare `status --json` build revision and enable epoch when the backend advertises `runtime_build`. Older backends may omit these fields; copying files does not reload the running Shell module. |

## Update documentation

`docs/architecture.puml` is the diagram source. Render its committed SVG with:

```sh
plantuml -tsvg docs/architecture.puml
```

The screenshot in the README is a current service-diagnostics capture. Refresh it
when the diagnostic contract changes; omit window inventories and private display
identities from public captures.

Reproduce the CLI screenshot with `python3 docs/capture-cli.py` from the repository
root. This requires Chrome or Chromium for an isolated headless render, plus a
running GNOME service. The capture allowlists capability fields; it is not an
unfiltered dump of the complete status response.


## Placement capture

The placement screenshot runs the actual extension and client against a disposable
headless GNOME Shell, three virtual monitors, and one synthetic GTK window. It
uses a private session bus without service activation, temporary XDG directories,
and software rendering. It does not change the running desktop or override HOME.
The capture injects a control method into only the temporary extension copy to
activate the disposable workspace; production extension files are unchanged.

Requirements: GNOME Shell 46 with headless support, `dbus-run-session`, `gdbus`,
`glib-compile-schemas`, Python with PyGObject/GTK 3, and Chrome or Chromium for the
final output rendering. From the repository root:

```sh
capture_dir=$(mktemp -d)
python3 docs/capture-placement.py --run --output "$capture_dir"
```

This updates `docs/screenshots/placement.png` only after real verified placement.
Private diagnostic logs and temporary results remain in `capture_dir`; remove
that directory after inspection. The published screenshot includes only selected
fields from synthetic data. Before activation, `placed` is false and status is
`deferred`; afterwards the same token reports `verified` and `placed` true.
The request geometry uses monitor-relative coordinates; the observed window
geometry uses global desktop coordinates.
