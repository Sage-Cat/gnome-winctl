from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from gnome_winctl.cli import _geometry, _selector, main
from gnome_winctl.client import _gdbus_value, normalize_target


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
