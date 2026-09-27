#!/usr/bin/env python3
"""Capture real CLI output with an isolated headless browser; no live UI changes."""
import html
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    return subprocess.check_output(args, text=True, timeout=15, **kwargs).strip()


def render(title, subtitle, content, destination):
    chrome = shutil.which('google-chrome') or shutil.which('chromium')
    if not chrome:
        raise SystemExit('Install Chrome or Chromium to render the documentation capture.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='documentation-browser-') as temporary:
        root = Path(temporary)
        page = root / 'capture.html'
        height = max(440, 220 + 24 * len(content.splitlines()))
        page.write_text('<!doctype html><meta charset="utf-8"><style>'
            'body{margin:0;background:#0c1420;color:#e2eaf2;font-family:monospace;padding:40px}'
            'h1{font:600 30px sans-serif;color:#69e0cf;margin:0 0 12px}'
            'p{font:16px sans-serif;color:#a8b6ca;margin-bottom:28px}'
            'pre{font:17px/24px monospace;white-space:pre-wrap;overflow-wrap:anywhere;'
            'padding:24px;background:#132234;border:1px solid #294157;border-radius:12px}'
            '</style><h1>' + html.escape(title) + '</h1><p>' + html.escape(subtitle)
            + '</p><pre>' + html.escape(content) + '</pre>')
        subprocess.run([chrome, '--headless', '--disable-gpu', '--disable-background-networking',
            '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
            '--user-data-dir=' + str(root / 'profile'), '--screenshot=' + str(destination),
            '--window-size=1200,' + str(height), '--timeout=10000', page.as_uri()],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    print(destination)


if __name__ == '__main__':
    data = json.loads(run([str(ROOT / 'bin/gnome-winctl'), 'status', '--json']))
    # Allowlist service fields; never publish desktop titles, names or display serials.
    data = {key: data[key] for key in ('available', 'ok', 'interface', 'interface_version', 'capabilities') if key in data}
    render('gnome-winctl · service capabilities',
        'Read-only CLI output capture · native GNOME Wayland service',
        '$ gnome-winctl status --json\n' + json.dumps(data, indent=2),
        ROOT / 'docs/screenshots/diagnostics.png')
