from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gnome_winctl.cli import _geometry, _selector, main
from gnome_winctl.client import (
    WinCtlError,
    _gdbus_value,
    add_monitor_identities,
    get_capabilities,
    get_state,
    normalize_target,
    place_window,
)


STATE = {
    "workspaces": [
        {"index": 0, "name": "main"},
        {"index": 1, "name": "research"},
    ],
    "monitors": [
        {
            "index": 0, "x": 0, "y": 0, "width": 1920, "height": 1080,
            "primary": True,
            "identity": {"connector": "HDMI-1", "edid_hash": "primary"},
        },
        {
            "index": 1, "x": 1920, "y": 0, "width": 2560, "height": 1440,
            "primary": False,
            "identity": {"connector": "DP-1", "edid_hash": "external"},
        },
    ],
}


class ClientTests(unittest.TestCase):
    def test_parses_gdbus_single_value_tuple(self):
        payload = json.dumps({"available": True})
        self.assertEqual(_gdbus_value(repr((payload,))), payload)

    def test_parses_gdbus_boolean(self):
        self.assertIs(_gdbus_value("(true,)"), True)
        self.assertIs(_gdbus_value("(false,)"), False)

    def test_resolves_named_workspace_and_edid_monitor(self):
        target = normalize_target({
            "workspace": {"name": "research", "index": 0},
            "monitor": {"connector": "stale", "edid_hash": "external"},
            "geometry": {"x": 20, "y": 30, "width": 1200, "height": 900},
            "coordinate_space": "monitor",
            "state": "maximized",
        }, STATE)
        self.assertEqual(target["workspace"], 1)
        self.assertEqual(target["monitor"], 1)
        self.assertEqual(target["geometry"]["x"], 20)

    def test_converts_legacy_global_geometry_to_monitor_relative(self):
        target = normalize_target({
            "workspace": 0,
            "monitor": {"connector": "DP-1"},
            "monitor_geometry": {"x": 1920, "y": 0},
            "geometry": {"x": 1950, "y": 40, "width": 1000, "height": 700},
        }, STATE)
        self.assertEqual(target["geometry"]["x"], 30)
        self.assertEqual(target["geometry"]["y"], 40)

    def test_prefers_persistent_workspace_and_monitor_identity(self):
        target = normalize_target({
            "workspace": 0,
            "workspace_name": "research",
            "monitor": 0,
            "monitor_identity": {"edid_hash": "external"},
            "geometry": {"x": 20, "y": 30, "width": 1000, "height": 700},
            "coordinate_space": "monitor",
        }, STATE)
        self.assertEqual(target["workspace"], 1)
        self.assertEqual(target["monitor"], 1)

    def test_enriches_shell_monitor_with_persistent_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / ".config").mkdir()
            (home / ".config/monitors.xml").write_text("""
<monitors version="2"><configuration><logicalmonitor>
<x>1920</x><y>0</y><scale>2</scale><monitor><monitorspec>
<connector>DP-1</connector><vendor>GSM</vendor>
<product>LG HDR 4K</product><serial>ABC</serial>
</monitorspec><mode><width>3840</width><height>2160</height></mode></monitor>
</logicalmonitor></configuration></monitors>
""")
            state = {
                "monitors": [{
                    "index": 0, "x": 1920, "y": 0,
                    "width": 1920, "height": 1080,
                }],
                "windows": [{"monitor": 0}],
            }
            with patch("gnome_winctl.client.Path.home", return_value=home), patch(
                "gnome_winctl.client._edid_hashes", return_value={"DP-1": "edid"},
            ):
                add_monitor_identities(state)
        self.assertEqual(state["monitors"][0]["identity"]["serial"], "ABC")
        self.assertEqual(state["monitors"][0]["identity"]["edid_hash"], "edid")
        self.assertEqual(state["windows"][0]["monitor_identity"]["product"], "LG HDR 4K")

    def test_falls_back_to_live_legacy_session_service(self):
        legacy = {
            "active_workspace": 1,
            "monitors": [dict(STATE["monitors"][0])],
            "windows": [{
                "pid": 42,
                "title": "Terminal",
                "wm_class": "Alacritty",
                "workspace": 1,
                "monitor": 0,
                "geometry": {"x": 10, "y": 20, "width": 800, "height": 600},
                "maximized": 0,
            }],
        }
        with patch(
            "gnome_winctl.client._json_call",
            side_effect=WinCtlError("new service is not loaded"),
        ), patch(
            "gnome_winctl.client._legacy_json_call", return_value=legacy,
        ), patch(
            "gnome_winctl.client._workspace_names", return_value=["main", "research"],
        ), patch(
            "gnome_winctl.client._edid_hashes", return_value={},
        ), patch(
            "gnome_winctl.client._monitor_xml_identities", return_value={},
        ):
            state = get_state()
            capabilities = get_capabilities()
        self.assertEqual(state["backend"], "legacy-session-bridge")
        self.assertEqual(state["workspaces"][1]["name"], "research")
        self.assertEqual(state["windows"][0]["geometry_relative"]["x"], 10)
        self.assertEqual(capabilities["capabilities"], [
            "list_windows", "list_monitors", "list_workspaces", "place_window",
        ])

    def test_legacy_placement_converts_monitor_relative_geometry(self):
        state = {
            **STATE,
            "backend": "legacy-session-bridge",
            "windows": [{"pid": 42, "title": "Terminal", "app_ids": ["alacritty"]}],
        }
        state["monitors"] = [dict(STATE["monitors"][1])]
        with patch("gnome_winctl.client.get_state", return_value=state), patch(
            "gnome_winctl.client._json_call",
            side_effect=WinCtlError("new service is not loaded"),
        ), patch("gnome_winctl.client._legacy_call", return_value=True) as legacy:
            result = place_window({"pid": 42}, {
                "workspace": "research",
                "monitor": "DP-1",
                "geometry": {"x": 30, "y": 40, "width": 1200, "height": 900},
                "coordinate_space": "monitor",
                "state": "maximized",
            })
        self.assertTrue(result["placed"])
        self.assertEqual(legacy.call_args.args, (
            "PlaceByTitle", "Terminal", "1", "1", "1950", "40", "1200", "900", "1",
        ))


class CliTests(unittest.TestCase):
    def test_geometry_requires_four_integers(self):
        self.assertEqual(_geometry("1,2,800,600")["width"], 800)
        with self.assertRaisesRegex(ValueError, "X,Y,WIDTH,HEIGHT"):
            _geometry("1,2,3")

    def test_json_selector_is_preserved(self):
        args = type("Args", (), {
            "selector_json": '{"app_id":"google-chrome"}',
            "window_id": None,
            "pid": None,
            "title": None,
            "app_id": None,
        })()
        self.assertEqual(_selector(args), {"app_id": "google-chrome"})

    def test_expectation_status_is_data_even_while_pending(self):
        with patch(
            "gnome_winctl.cli.expectation_status",
            return_value={"token": "one", "status": "pending", "placed": False},
        ), patch("gnome_winctl.cli._print"):
            self.assertEqual(main(["expectation", "one", "--json"]), 0)


if __name__ == "__main__":
    unittest.main()
