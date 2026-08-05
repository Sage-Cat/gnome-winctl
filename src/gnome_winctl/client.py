from __future__ import annotations

import ast
import hashlib
import json
import subprocess
import time
from pathlib import Path
from typing import Any, Iterable
from xml.etree import ElementTree

BUS = "org.sagecat.GnomeWinCtl1"
OBJECT = "/org/sagecat/GnomeWinCtl1"
INTERFACE = BUS
LEGACY_BUS = "org.sagecat.WorkspaceState"
LEGACY_OBJECT = "/org/sagecat/WorkspaceState"
LEGACY_INTERFACE = LEGACY_BUS


class WinCtlError(RuntimeError):
    """The placement service is unavailable or rejected an operation."""


def _run(args: Iterable[str], *, timeout: float = 10) -> str:
    command = list(args)
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    except FileNotFoundError as error:
        raise WinCtlError(f"required command is unavailable: {command[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise WinCtlError(f"{' '.join(command)} timed out") from error
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise WinCtlError(detail)
    return result.stdout.strip()


def _gdbus_value(output: str) -> Any:
    raw = output.strip().rstrip(",")
    if raw in {"(true,)", "(true)", "true"}:
        return True
    if raw in {"(false,)", "(false)", "false"}:
        return False
    try:
        value = ast.literal_eval(raw)
    except (SyntaxError, ValueError) as error:
        raise WinCtlError(f"invalid D-Bus response: {output!r}") from error
    return value[0] if isinstance(value, tuple) else value


def _call(method: str, *arguments: str, timeout: float = 10) -> Any:
    output = _run([
        "gdbus", "call", "--session", "--dest", BUS,
        "--object-path", OBJECT, "--method", f"{INTERFACE}.{method}",
        *arguments,
    ], timeout=timeout)
    return _gdbus_value(output)


def _legacy_call(method: str, *arguments: str, timeout: float = 10) -> Any:
    output = _run([
        "gdbus", "call", "--session", "--dest", LEGACY_BUS,
        "--object-path", LEGACY_OBJECT,
        "--method", f"{LEGACY_INTERFACE}.{method}",
        *arguments,
    ], timeout=timeout)
    return _gdbus_value(output)


def _json_call(method: str, *arguments: str, timeout: float = 10) -> Any:
    payload = _call(method, *arguments, timeout=timeout)
    try:
        return json.loads(str(payload))
    except (TypeError, json.JSONDecodeError) as error:
        raise WinCtlError(f"{method} returned invalid JSON") from error


def _legacy_json_call(method: str, *arguments: str, timeout: float = 10) -> Any:
    payload = _legacy_call(method, *arguments, timeout=timeout)
    try:
        return json.loads(str(payload))
    except (TypeError, json.JSONDecodeError) as error:
        raise WinCtlError(f"legacy {method} returned invalid JSON") from error


def _workspace_names() -> list[str]:
    try:
        raw = _run([
            "gsettings", "get", "org.gnome.desktop.wm.preferences",
            "workspace-names",
        ])
        value = ast.literal_eval(raw.removeprefix("@as "))
    except (OSError, SyntaxError, ValueError, WinCtlError):
        return []
    return [str(item) for item in value] if isinstance(value, list) else []


def _legacy_state() -> dict[str, Any]:
    state = _legacy_json_call("Capture")
    if not isinstance(state, dict):
        raise WinCtlError("legacy Capture did not return an object")

    names = _workspace_names()
    active = int(state.get("active_workspace", 0))
    highest = max(
        [active, *(int(item.get("workspace", 0)) for item in state.get("windows", []))],
        default=0,
    )
    count = max(len(names), highest + 1)
    state.update({
        "interface": LEGACY_BUS,
        "interface_version": 0,
        "backend": "legacy-session-bridge",
        "degraded": True,
        "capabilities": ["list_windows", "list_monitors", "list_workspaces", "place_window"],
        "workspaces": [
            {
                "index": index,
                "name": names[index] if index < len(names) and names[index]
                else f"Workspace {index + 1}",
                "active": index == active,
            }
            for index in range(count)
        ],
    })
    monitors = {
        int(item.get("index", -1)): item for item in state.get("monitors", [])
    }
    for window in state.get("windows", []):
        monitor = monitors.get(int(window.get("monitor", -1)))
        geometry = window.get("geometry") or {}
        if monitor and geometry:
            window["geometry_relative"] = {
                "x": int(geometry.get("x", 0)) - int(monitor.get("x", 0)),
                "y": int(geometry.get("y", 0)) - int(monitor.get("y", 0)),
                "width": int(geometry.get("width", 1)),
                "height": int(geometry.get("height", 1)),
            }
        window.setdefault(
            "state",
            "fullscreen" if window.get("fullscreen")
            else "maximized" if window.get("maximized")
            else "normal",
        )
        identifiers = [
            window.get("app_id"), window.get("wm_class"),
            window.get("wm_class_instance"), window.get("sandboxed_app_id"),
        ]
        window["app_ids"] = sorted({
            str(item).lower().removesuffix(".desktop")
            for item in identifiers if item
        })
    return state


def _edid_hashes() -> dict[str, str]:
    result: dict[str, str] = {}
    for path in Path("/sys/class/drm").glob("card*-*/edid"):
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        if not raw:
            continue
        entry = path.parent.name
        connector = entry.split("-", 1)[1] if "-" in entry else entry
        result[connector] = hashlib.sha256(raw).hexdigest()
    return result


def _monitor_xml_identities(monitors: list[dict[str, Any]]) -> dict[int, dict[str, str]]:
    path = Path.home() / ".config/monitors.xml"
    try:
        root = ElementTree.parse(path).getroot()
    except (OSError, ElementTree.ParseError):
        return {}

    by_rect = {
        (int(item["x"]), int(item["y"]), int(item["width"]), int(item["height"])): item
        for item in monitors
    }
    for configuration in root.findall("configuration"):
        matches: list[tuple[int, dict[str, str]]] = []
        for logical in configuration.findall("logicalmonitor"):
            monitor = logical.find("monitor")
            spec = monitor.find("monitorspec") if monitor is not None else None
            mode = monitor.find("mode") if monitor is not None else None
            if spec is None or mode is None:
                continue
            try:
                scale = float(logical.findtext("scale", "1"))
                rect = (
                    int(logical.findtext("x", "0")),
                    int(logical.findtext("y", "0")),
                    round(int(mode.findtext("width", "0")) / scale),
                    round(int(mode.findtext("height", "0")) / scale),
                )
            except (ValueError, ZeroDivisionError):
                continue
            shell_monitor = by_rect.get(rect)
            if shell_monitor is None:
                continue
            identity = {
                key: spec.findtext(key, "")
                for key in ("connector", "vendor", "product", "serial")
            }
            matches.append((int(shell_monitor["index"]), identity))
        if len(matches) == len(by_rect) and matches:
            return dict(matches)
    return {}


def add_monitor_identities(result: dict[str, Any]) -> dict[str, Any]:
    """Add connector and SHA-256 EDID identities when Mutter omits either."""
    monitors = result.get("monitors", [])
    xml_identities = _monitor_xml_identities(monitors)
    edid_hashes = _edid_hashes()
    for monitor in monitors:
        index = int(monitor.get("index", -1))
        identity = dict(xml_identities.get(index, {}))
        identity.update({
            key: str(monitor.get(key) or identity.get(key) or "")
            for key in ("connector", "vendor", "product", "serial")
        })
        connector = identity.get("connector", "")
        if connector in edid_hashes:
            identity["edid_hash"] = edid_hashes[connector]
        checksum = monitor.get("edid_checksum")
        if checksum:
            identity["edid_checksum"] = str(checksum)
        monitor["identity"] = identity

    by_index = {int(item["index"]): item for item in monitors}
    for window in result.get("windows", []):
        monitor = by_index.get(int(window.get("monitor", -1)))
        if monitor:
            window["monitor_identity"] = dict(monitor.get("identity") or {})
    return result


def get_state() -> dict[str, Any]:
    try:
        state = _json_call("GetState")
    except WinCtlError as primary_error:
        try:
            state = _legacy_state()
        except WinCtlError as legacy_error:
            raise WinCtlError(
                f"placement service unavailable: {primary_error}; "
                f"legacy session bridge unavailable: {legacy_error}",
            ) from primary_error
    if not isinstance(state, dict):
        raise WinCtlError("GetState did not return an object")
    return add_monitor_identities(state)


def get_capabilities() -> dict[str, Any]:
    try:
        value = _json_call("GetCapabilities")
    except WinCtlError as primary_error:
        try:
            state = _legacy_state()
        except WinCtlError as legacy_error:
            raise WinCtlError(
                f"placement service unavailable: {primary_error}; "
                f"legacy session bridge unavailable: {legacy_error}",
            ) from primary_error
        return {
            key: state[key]
            for key in ("interface", "interface_version", "backend", "degraded", "capabilities")
        }
    if not isinstance(value, dict):
        raise WinCtlError("GetCapabilities did not return an object")
    return value


def _workspace_index(spec: Any, state: dict[str, Any]) -> int:
    workspaces = state.get("workspaces", [])
    if isinstance(spec, dict):
        name = spec.get("name")
        fallback = spec.get("index", spec.get("fallback_index", 0))
    else:
        name = spec if isinstance(spec, str) and not spec.lstrip("-").isdigit() else None
        fallback = spec if name is None else 0
    if name is not None:
        match = next((item for item in workspaces if item.get("name") == name), None)
        if match is not None:
            return int(match["index"])
    try:
        index = int(fallback)
    except (TypeError, ValueError):
        index = 0
    return max(0, min(index, max(0, len(workspaces) - 1)))


def _monitor_matches(identity: dict[str, Any], monitor: dict[str, Any]) -> bool:
    current = monitor.get("identity") or {}
    edid_hash = identity.get("edid_hash")
    if edid_hash and current.get("edid_hash") == edid_hash:
        return True
    checksum = identity.get("edid_checksum")
    if checksum and current.get("edid_checksum") == checksum:
        return True
    serial = identity.get("serial")
    if serial and current.get("serial") == serial:
        return True
    connector = identity.get("connector")
    return bool(
        connector and current.get("connector") == connector
        and (not identity.get("vendor") or current.get("vendor") == identity.get("vendor"))
        and (not identity.get("product") or current.get("product") == identity.get("product"))
    )


def _monitor(spec: Any, state: dict[str, Any]) -> dict[str, Any]:
    monitors = state.get("monitors", [])
    if not monitors:
        raise WinCtlError("GNOME reports no active monitors")
    primary = next((item for item in monitors if item.get("primary")), monitors[0])
    if spec in (None, "primary"):
        return primary
    if isinstance(spec, int) or isinstance(spec, str) and spec.lstrip("-").isdigit():
        index = int(spec)
        return next((item for item in monitors if int(item["index"]) == index), primary)
    identity = dict(spec) if isinstance(spec, dict) else {"connector": str(spec)}
    return next((item for item in monitors if _monitor_matches(identity, item)), primary)


def normalize_target(target: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    monitor = _monitor(target.get("monitor_identity") or target.get("monitor"), state)
    workspace_spec: Any = target.get("workspace", 0)
    if target.get("workspace_name"):
        workspace_spec = {
            "name": target["workspace_name"],
            "index": target.get("workspace", 0),
        }
    workspace = _workspace_index(workspace_spec, state)
    geometry = dict(target.get("geometry") or {})
    if not geometry:
        geometry = {"x": 0, "y": 0, "width": 1000, "height": 700}
    coordinate_space = str(target.get("coordinate_space") or "")
    old_monitor = target.get("monitor_geometry") or {}
    if coordinate_space == "global" or not coordinate_space and old_monitor:
        origin = old_monitor or monitor
        geometry["x"] = int(geometry.get("x", 0)) - int(origin.get("x", 0))
        geometry["y"] = int(geometry.get("y", 0)) - int(origin.get("y", 0))
    return {
        "workspace": workspace,
        "monitor": int(monitor["index"]),
        "geometry": {
            "x": int(geometry.get("x", 0)),
            "y": int(geometry.get("y", 0)),
            "width": max(1, int(geometry.get("width", 1000))),
            "height": max(1, int(geometry.get("height", 700))),
        },
        "coordinate_space": "monitor",
        "state": str(target.get("state") or ("maximized" if target.get("maximized") else "normal")),
        "clamp": bool(target.get("clamp", True)),
    }


def place_window(selector: dict[str, Any], target: dict[str, Any]) -> dict[str, Any]:
    state = get_state()
    normalized = normalize_target(target, state)
    try:
        result = _json_call(
            "PlaceWindow",
            json.dumps(selector, separators=(",", ":")),
            json.dumps(normalized, separators=(",", ":")),
        )
    except WinCtlError:
        if state.get("backend") != "legacy-session-bridge":
            raise
        return _legacy_place_window(selector, normalized, state)
    if not isinstance(result, dict):
        raise WinCtlError("PlaceWindow did not return an object")
    return result


def _legacy_place_window(
    selector: dict[str, Any],
    target: dict[str, Any],
    state: dict[str, Any],
) -> dict[str, Any]:
    windows = state.get("windows", [])
    if selector.get("title") is not None:
        title = str(selector["title"])
    else:
        matches = []
        for window in windows:
            if selector.get("id") is not None and window.get("id") != selector["id"]:
                continue
            if selector.get("pid") is not None and int(window.get("pid", -1)) != int(selector["pid"]):
                continue
            if selector.get("app_id") is not None:
                app_id = str(selector["app_id"]).lower().removesuffix(".desktop")
                if app_id not in window.get("app_ids", []):
                    continue
            matches.append(window)
        if len(matches) != 1:
            raise WinCtlError(
                f"legacy session bridge selector matched {len(matches)} windows; use an exact title",
            )
        title = str(matches[0].get("title") or "")
    if not title:
        raise WinCtlError("legacy session bridge requires a non-empty exact title")

    monitor_index = int(target["monitor"])
    monitor = next(
        (item for item in state.get("monitors", []) if int(item.get("index", -1)) == monitor_index),
        None,
    )
    if monitor is None:
        raise WinCtlError(f"legacy session bridge cannot resolve monitor {monitor_index}")
    geometry = target["geometry"]
    placed = bool(_legacy_call(
        "PlaceByTitle",
        title,
        str(int(target["workspace"])),
        str(monitor_index),
        str(int(monitor.get("x", 0)) + int(geometry["x"])),
        str(int(monitor.get("y", 0)) + int(geometry["y"])),
        str(int(geometry["width"])),
        str(int(geometry["height"])),
        "1" if target.get("state") in {"maximized", "fullscreen"} else "0",
    ))
    return {
        "placed": placed,
        "backend": "legacy-session-bridge",
        "degraded": True,
        "window": {"title": title},
    }


def expect_window(
    selector: dict[str, Any],
    target: dict[str, Any],
    *,
    timeout: float = 20,
) -> str:
    normalized = normalize_target(target, get_state())
    token = _call(
        "ExpectWindow",
        json.dumps(selector, separators=(",", ":")),
        json.dumps(normalized, separators=(",", ":")),
        str(max(1, round(timeout * 1000))),
    )
    return str(token)


def expectation_status(token: str) -> dict[str, Any]:
    result = _json_call("ExpectationStatus", token)
    if not isinstance(result, dict):
        raise WinCtlError("ExpectationStatus did not return an object")
    return result


def cancel_expectation(token: str) -> bool:
    return bool(_call("CancelExpectation", token))


def wait_for_expectation(token: str, *, timeout: float = 20, interval: float = 0.05) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last = {"token": token, "status": "pending"}
    while time.monotonic() < deadline:
        last = expectation_status(token)
        if last.get("status") != "pending":
            return last
        time.sleep(interval)
    return last
