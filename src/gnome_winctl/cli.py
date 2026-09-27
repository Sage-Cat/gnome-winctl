from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from . import __version__
from .client import (
    WinCtlError,
    cancel_expectation,
    expect_window,
    expectation_status,
    get_capabilities,
    get_state,
    place_window,
    wait_for_expectation,
)


def _json_object(value: str, label: str) -> dict[str, Any]:
    try:
        result = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} is not valid JSON: {error.msg}") from error
    if not isinstance(result, dict):
        raise ValueError(f"{label} must be a JSON object")
    return result


def _geometry(value: str) -> dict[str, int]:
    try:
        x, y, width, height = (int(item.strip()) for item in value.split(","))
    except ValueError as error:
        raise ValueError("geometry must be X,Y,WIDTH,HEIGHT") from error
    if width < 1 or height < 1:
        raise ValueError("geometry width and height must be positive")
    return {"x": x, "y": y, "width": width, "height": height}


def _selector(args: argparse.Namespace, *, expectation: bool = False) -> dict[str, Any]:
    if args.selector_json:
        return _json_object(args.selector_json, "selector")
    values = [args.window_id is not None, args.pid is not None, bool(args.title), bool(args.app_id)]
    if sum(values) != 1:
        purpose = "an app ID" if expectation else "exactly one window selector"
        raise ValueError(f"provide {purpose}")
    if args.window_id is not None:
        return {"id": args.window_id}
    if args.pid is not None:
        return {"pid": args.pid}
    if args.title:
        return {"title": args.title}
    return {"app_id": args.app_id}


def _target(args: argparse.Namespace) -> dict[str, Any]:
    if args.target_json:
        return _json_object(args.target_json, "target")
    if args.workspace is None or args.geometry is None:
        raise ValueError("workspace and geometry are required without --target-json")
    monitor: Any = args.monitor
    if monitor is not None and monitor.lstrip("-").isdigit():
        monitor = int(monitor)
    return {
        "workspace": args.workspace,
        "monitor": "primary" if monitor is None else monitor,
        "geometry": _geometry(args.geometry),
        "coordinate_space": "global" if args.global_coordinates else "monitor",
        "state": args.state,
        "clamp": not args.no_clamp,
    }


def _add_selector(parser: argparse.ArgumentParser, *, expectation: bool = False) -> None:
    parser.add_argument("window_id", nargs="?", type=int)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--title")
    parser.add_argument("--app-id", required=False)
    parser.add_argument("--selector-json", metavar="JSON")
    if expectation:
        parser.set_defaults(window_id=None, pid=None, title=None)


def _add_target(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--workspace", help="workspace name or zero-based index")
    parser.add_argument("--monitor", default="primary", help="connector, index, or primary")
    parser.add_argument("--geometry", metavar="X,Y,WIDTH,HEIGHT")
    parser.add_argument("--state", choices=("normal", "maximized", "fullscreen", "minimized"), default="normal")
    parser.add_argument("--global-coordinates", action="store_true")
    parser.add_argument("--no-clamp", action="store_true")
    parser.add_argument("--target-json", metavar="JSON")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="gnome-winctl", description="Control GNOME windows on native Wayland")
    root.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="check the Shell placement service")
    commands.add_parser("state", help="show the complete desktop window state")
    commands.add_parser("windows", help="list controllable windows")
    commands.add_parser("monitors", help="list logical monitors")
    commands.add_parser("workspaces", help="list GNOME workspaces")

    place = commands.add_parser("place", help="place one existing window")
    _add_selector(place)
    _add_target(place)
    place.add_argument("--wait", action="store_true", help="wait for verified placement; never activates its workspace")
    place.add_argument("--timeout", type=float, default=20)

    expect = commands.add_parser("expect", help="place the next matching window")
    _add_selector(expect, expectation=True)
    _add_target(expect)
    expect.add_argument("--timeout", type=float, default=20)
    expect.add_argument("--wait", action="store_true")

    expectation = commands.add_parser("expectation", help="show an expectation result")
    expectation.add_argument("token")
    cancel = commands.add_parser("cancel", help="cancel a pending expectation")
    cancel.add_argument("token")
    return root


def _print(value: Any, *, as_json: bool) -> None:
    if as_json or isinstance(value, (dict, list)):
        print(json.dumps(value, indent=None if as_json else 2, sort_keys=True))
    else:
        print(value)


def main(argv: list[str] | None = None) -> int:
    values = list(sys.argv[1:] if argv is None else argv)
    as_json = "--json" in values
    values = [item for item in values if item != "--json"]
    args = parser().parse_args(values)
    try:
        if args.command == "status":
            capabilities = get_capabilities()
            result = {"available": True, **capabilities}
        elif args.command == "state":
            result = get_state()
        elif args.command in {"windows", "monitors", "workspaces"}:
            result = get_state().get(args.command, [])
        elif args.command == "place":
            result = place_window(_selector(args), _target(args))
            if args.wait and result.get("token"):
                result = wait_for_expectation(result["token"], timeout=args.timeout)
        elif args.command == "expect":
            token = expect_window(_selector(args, expectation=True), _target(args), timeout=args.timeout)
            result = wait_for_expectation(token, timeout=args.timeout) if args.wait else {"token": token, "status": "pending"}
        elif args.command == "expectation":
            result = expectation_status(args.token)
        elif args.command == "cancel":
            result = {"token": args.token, "cancelled": cancel_expectation(args.token)}
        else:
            raise ValueError(f"unknown command: {args.command}")
    except (ValueError, WinCtlError) as error:
        if as_json:
            _print({"ok": False, "error": str(error)}, as_json=True)
        else:
            print(f"gnome-winctl: {error}", file=sys.stderr)
        return 2

    if isinstance(result, dict):
        result.setdefault("ok", True)
    _print(result, as_json=as_json)
    if args.command == "place" and isinstance(result, dict) and not result.get("placed"):
        if args.wait or result.get("status") not in {"accepted", "deferred", "applied"}:
            return 1
    if args.command == "expect" and args.wait and isinstance(result, dict) and not result.get("placed"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
