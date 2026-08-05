import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BUS_NAME = 'org.sagecat.GnomeWinCtl1';
const OBJECT_PATH = '/org/sagecat/GnomeWinCtl1';
const INTERFACE_XML = `
<node>
  <interface name="org.sagecat.GnomeWinCtl1">
    <method name="GetCapabilities">
      <arg type="s" direction="out" name="capabilities"/>
    </method>
    <method name="GetState">
      <arg type="s" direction="out" name="state"/>
    </method>
    <method name="ListWindows">
      <arg type="s" direction="out" name="windows"/>
    </method>
    <method name="ListMonitors">
      <arg type="s" direction="out" name="monitors"/>
    </method>
    <method name="ListWorkspaces">
      <arg type="s" direction="out" name="workspaces"/>
    </method>
    <method name="PlaceWindow">
      <arg type="s" direction="in" name="selector"/>
      <arg type="s" direction="in" name="target"/>
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="ExpectWindow">
      <arg type="s" direction="in" name="selector"/>
      <arg type="s" direction="in" name="target"/>
      <arg type="u" direction="in" name="timeout_ms"/>
      <arg type="s" direction="out" name="token"/>
    </method>
    <method name="ExpectationStatus">
      <arg type="s" direction="in" name="token"/>
      <arg type="s" direction="out" name="result"/>
    </method>
    <method name="CancelExpectation">
      <arg type="s" direction="in" name="token"/>
      <arg type="b" direction="out" name="cancelled"/>
    </method>
  </interface>
</node>`;

const CAPABILITIES = [
    'list_windows',
    'list_monitors',
    'list_workspaces',
    'place_window',
    'expect_window',
    'window_state',
];

function normalWindows() {
    return global.get_window_actors()
        .map(actor => actor.meta_window)
        .filter(window => window && window.get_window_type() === Meta.WindowType.NORMAL);
}

function normalizeAppId(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized.endsWith('.desktop') ? normalized.slice(0, -8) : normalized;
}

function appIds(window) {
    const values = [
        window.get_gtk_application_id?.(),
        window.get_wm_class?.(),
        window.get_wm_class_instance?.(),
        window.get_sandboxed_app_id?.(),
    ];
    return [...new Set(values.filter(Boolean).map(normalizeAppId))];
}

function stateOf(window) {
    if (window.is_fullscreen())
        return 'fullscreen';
    if (window.minimized)
        return 'minimized';
    if (window.get_maximized() !== 0)
        return 'maximized';
    return 'normal';
}

function parseObject(value, label) {
    let result;
    try {
        result = JSON.parse(value);
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${error.message}`);
    }
    if (!result || Array.isArray(result) || typeof result !== 'object')
        throw new Error(`${label} must be a JSON object`);
    return result;
}

function integer(value, fallback = 0) {
    const result = Number.parseInt(value, 10);
    return Number.isFinite(result) ? result : fallback;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(value, maximum));
}

export default class GnomeWinCtlExtension extends Extension {
    enable() {
        this._expectations = [];
        this._statuses = new Map();
        this._retrySources = new Set();
        this._workspaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._windowCreatedId = global.display.connect(
            'window-created',
            (_display, window) => this._windowCreated(window),
        );
        this._exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this._exported.export(Gio.DBus.session, OBJECT_PATH);
        this._ownerId = Gio.bus_own_name_on_connection(
            Gio.DBus.session,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            null,
            null,
        );
    }

    disable() {
        if (this._windowCreatedId)
            global.display.disconnect(this._windowCreatedId);
        this._windowCreatedId = 0;
        for (const source of this._retrySources)
            GLib.source_remove(source);
        this._retrySources.clear();
        this._expectations = [];
        this._statuses.clear();
        this._workspaceSettings = null;
        if (this._ownerId)
            Gio.bus_unown_name(this._ownerId);
        this._ownerId = 0;
        this._exported?.unexport();
        this._exported = null;
    }

    _monitorManager() {
        return global.backend.get_monitor_manager?.() ?? Meta.MonitorManager.get?.();
    }

    _monitors() {
        const monitors = Main.layoutManager.monitors.map(monitor => ({
            index: monitor.index,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            scale: global.display.get_monitor_scale(monitor.index),
            primary: monitor.index === Main.layoutManager.primaryIndex,
            connector: '',
            vendor: '',
            product: '',
            serial: '',
            edid_checksum: '',
        }));
        const manager = this._monitorManager();
        try {
            for (const physical of manager?.get_monitors?.() ?? []) {
                const connector = physical.get_connector?.() ?? '';
                const index = manager.get_monitor_for_connector?.(connector) ?? -1;
                const logical = monitors.find(item => item.index === index);
                if (!logical)
                    continue;
                logical.connector = connector;
                logical.vendor = physical.get_vendor?.() ?? '';
                logical.product = physical.get_product?.() ?? '';
                logical.serial = physical.get_serial?.() ?? '';
                logical.edid_checksum = physical.get_edid_checksum_md5?.() ?? '';
            }
        } catch (error) {
            console.warn(`gnome-winctl: physical monitor identity unavailable: ${error.message}`);
        }
        return monitors;
    }

    _workspaces() {
        const manager = global.workspace_manager;
        const names = this._workspaceSettings.get_strv('workspace-names');
        const result = [];
        for (let index = 0; index < manager.n_workspaces; index++) {
            const workspace = manager.get_workspace_by_index(index);
            result.push({
                index,
                name: names[index] || `Workspace ${index + 1}`,
                active: index === manager.get_active_workspace_index(),
                n_windows: workspace?.list_windows?.().filter(
                    window => window.get_window_type() === Meta.WindowType.NORMAL,
                ).length ?? 0,
            });
        }
        return result;
    }

    _windowRecord(window, monitors = this._monitors()) {
        const rect = window.get_frame_rect();
        const monitorIndex = window.get_monitor();
        const monitor = monitors.find(item => item.index === monitorIndex) ?? null;
        return {
            id: window.get_stable_sequence(),
            pid: window.get_pid(),
            title: window.get_title() ?? '',
            app_id: window.get_gtk_application_id?.() ?? '',
            app_ids: appIds(window),
            wm_class: window.get_wm_class?.() ?? '',
            wm_class_instance: window.get_wm_class_instance?.() ?? '',
            workspace: window.get_workspace()?.index() ?? 0,
            monitor: monitorIndex,
            monitor_geometry: monitor,
            geometry: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
            geometry_relative: {
                x: rect.x - (monitor?.x ?? 0),
                y: rect.y - (monitor?.y ?? 0),
                width: rect.width,
                height: rect.height,
            },
            state: stateOf(window),
            active: window.has_focus(),
        };
    }

    _windows(monitors = this._monitors()) {
        return normalWindows().map(window => this._windowRecord(window, monitors));
    }

    GetCapabilities() {
        return JSON.stringify({
            interface: BUS_NAME,
            interface_version: 1,
            capabilities: CAPABILITIES,
        });
    }

    GetState() {
        const monitors = this._monitors();
        return JSON.stringify({
            interface: BUS_NAME,
            interface_version: 1,
            capabilities: CAPABILITIES,
            active_workspace: global.workspace_manager.get_active_workspace_index(),
            monitors,
            workspaces: this._workspaces(),
            windows: this._windows(monitors),
        });
    }

    ListWindows() {
        return JSON.stringify(this._windows());
    }

    ListMonitors() {
        return JSON.stringify(this._monitors());
    }

    ListWorkspaces() {
        return JSON.stringify(this._workspaces());
    }

    _matches(window, selector) {
        if (selector.id !== undefined && window.get_stable_sequence() !== integer(selector.id, -1))
            return false;
        if (selector.pid !== undefined && window.get_pid() !== integer(selector.pid, -1))
            return false;
        if (selector.title !== undefined && (window.get_title() ?? '') !== String(selector.title))
            return false;
        if (selector.app_id !== undefined && !appIds(window).includes(normalizeAppId(selector.app_id)))
            return false;
        return Object.keys(selector).some(key => ['id', 'pid', 'title', 'app_id'].includes(key));
    }

    _resolveWorkspace(value) {
        const manager = global.workspace_manager;
        let index = 0;
        if (value && typeof value === 'object') {
            const name = value.name;
            const names = this._workspaceSettings.get_strv('workspace-names');
            index = name && names.includes(name)
                ? names.indexOf(name)
                : integer(value.index ?? value.fallback_index, 0);
        } else if (typeof value === 'string' && !/^-?\d+$/.test(value)) {
            const names = this._workspaceSettings.get_strv('workspace-names');
            index = names.includes(value) ? names.indexOf(value) : 0;
        } else {
            index = integer(value, 0);
        }
        return clamp(index, 0, Math.max(0, manager.n_workspaces - 1));
    }

    _resolveMonitor(value, monitors) {
        const primary = monitors.find(item => item.primary) ?? monitors[0];
        if (value === undefined || value === null || value === 'primary')
            return primary;
        if (typeof value === 'number' || typeof value === 'string' && /^-?\d+$/.test(value)) {
            const index = integer(value, primary.index);
            return monitors.find(item => item.index === index) ?? primary;
        }
        const identity = typeof value === 'string' ? {connector: value} : value;
        return monitors.find(item =>
            identity.edid_checksum && item.edid_checksum === identity.edid_checksum ||
            identity.serial && item.serial === identity.serial ||
            identity.connector && item.connector === identity.connector &&
                (!identity.vendor || item.vendor === identity.vendor) &&
                (!identity.product || item.product === identity.product)
        ) ?? primary;
    }

    _resolvedTarget(target) {
        const monitors = this._monitors();
        if (!monitors.length)
            throw new Error('GNOME reports no active monitors');
        const workspaceIndex = this._resolveWorkspace(target.workspace);
        const monitor = this._resolveMonitor(target.monitor, monitors);
        const geometry = target.geometry ?? {};
        let x = integer(geometry.x, 0);
        let y = integer(geometry.y, 0);
        let width = Math.max(1, integer(geometry.width, 1000));
        let height = Math.max(1, integer(geometry.height, 700));
        if (target.coordinate_space !== 'global') {
            x += monitor.x;
            y += monitor.y;
        }
        if (target.clamp !== false) {
            const workspace = global.workspace_manager.get_workspace_by_index(workspaceIndex);
            const area = workspace.get_work_area_for_monitor(monitor.index);
            width = Math.min(width, area.width);
            height = Math.min(height, area.height);
            x = clamp(x, area.x, area.x + area.width - width);
            y = clamp(y, area.y, area.y + area.height - height);
        }
        const state = ['normal', 'maximized', 'fullscreen', 'minimized'].includes(target.state)
            ? target.state
            : 'normal';
        return {
            workspace: workspaceIndex,
            monitor: monitor.index,
            geometry: {x, y, width, height},
            state,
        };
    }

    _applyPlacement(window, target) {
        const resolved = this._resolvedTarget(target);
        const workspace = global.workspace_manager.get_workspace_by_index(resolved.workspace);
        window.unminimize();
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        window.unmaximize(Meta.MaximizeFlags.BOTH);
        window.change_workspace(workspace);
        window.move_to_monitor(resolved.monitor);
        const geometry = resolved.geometry;
        window.move_resize_frame(true, geometry.x, geometry.y, geometry.width, geometry.height);
        if (resolved.state === 'maximized')
            window.maximize(Meta.MaximizeFlags.BOTH);
        else if (resolved.state === 'fullscreen')
            window.make_fullscreen();
        else if (resolved.state === 'minimized')
            window.minimize();
        return {
            placed: true,
            status: 'placed',
            resolved_target: resolved,
            window: this._windowRecord(window),
        };
    }

    PlaceWindow(selectorJson, targetJson) {
        try {
            const selector = parseObject(selectorJson, 'selector');
            const target = parseObject(targetJson, 'target');
            const matches = normalWindows().filter(window => this._matches(window, selector));
            if (!matches.length)
                return JSON.stringify({placed: false, status: 'not_found', message: 'no window matches selector'});
            if (matches.length > 1)
                return JSON.stringify({placed: false, status: 'ambiguous', message: `${matches.length} windows match selector`});
            return JSON.stringify(this._applyPlacement(matches[0], target));
        } catch (error) {
            return JSON.stringify({placed: false, status: 'failed', message: error.message});
        }
    }

    _expireExpectations() {
        const now = GLib.get_monotonic_time();
        for (const expectation of this._expectations) {
            if (now >= expectation.deadline) {
                this._statuses.set(expectation.token, {
                    token: expectation.token,
                    status: 'expired',
                    placed: false,
                });
            }
        }
        this._expectations = this._expectations.filter(
            expectation => this._statuses.get(expectation.token)?.status === 'pending',
        );
    }

    _windowCreated(window) {
        let attempts = 0;
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            attempts += 1;
            this._expireExpectations();
            if (!this._expectations.length || window.get_window_type() !== Meta.WindowType.NORMAL) {
                this._retrySources.delete(source);
                return GLib.SOURCE_REMOVE;
            }
            const index = this._expectations.findIndex(expectation => this._matches(window, expectation.selector));
            if (index < 0 && attempts < 120)
                return GLib.SOURCE_CONTINUE;
            if (index < 0) {
                this._retrySources.delete(source);
                return GLib.SOURCE_REMOVE;
            }
            const [expectation] = this._expectations.splice(index, 1);
            try {
                const result = this._applyPlacement(window, expectation.target);
                this._statuses.set(expectation.token, {token: expectation.token, ...result});
            } catch (error) {
                this._statuses.set(expectation.token, {
                    token: expectation.token,
                    status: 'failed',
                    placed: false,
                    message: error.message,
                });
            }
            this._retrySources.delete(source);
            return GLib.SOURCE_REMOVE;
        });
        this._retrySources.add(source);
    }

    ExpectWindow(selectorJson, targetJson, timeoutMs) {
        this._expireExpectations();
        const selector = parseObject(selectorJson, 'selector');
        const target = parseObject(targetJson, 'target');
        if (!Object.keys(selector).some(key => ['id', 'pid', 'title', 'app_id'].includes(key)))
            throw new Error('selector has no supported window identity');
        const token = GLib.uuid_string_random();
        const lifetime = clamp(integer(timeoutMs, 20000), 1000, 120000) * 1000;
        this._expectations.push({
            token,
            selector,
            target,
            deadline: GLib.get_monotonic_time() + lifetime,
        });
        this._statuses.set(token, {token, status: 'pending', placed: false});
        return token;
    }

    ExpectationStatus(token) {
        this._expireExpectations();
        return JSON.stringify(this._statuses.get(token) ?? {
            token,
            status: 'unknown',
            placed: false,
        });
    }

    CancelExpectation(token) {
        const index = this._expectations.findIndex(expectation => expectation.token === token);
        if (index < 0)
            return false;
        this._expectations.splice(index, 1);
        this._statuses.set(token, {token, status: 'cancelled', placed: false});
        return true;
    }
}

