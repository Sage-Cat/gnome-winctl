import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    MonitorChangeAction,
    anchorHasPhysicalIdentity,
    applyDisplayConfigIdentities,
    canRecoverBehindShield,
    captureMonitorAnchor,
    captureMonitorIntent,
    decideMonitorChange,
    displayConfigLogicalMonitors,
    monitorForAnchor,
    retainRecentRestores,
    shouldContinueRecovery,
} from './monitorPolicy.js';
import {
    deferredPlacementCanApply,
    pendingWorkspaceRecoveryAfterGlobalFinish,
    placementNeedsActiveWorkspace,
    protectMonitorAnchorDuringWorkspaceRecovery,
    windowIsOnActiveWorkspace,
    workspaceRecoveryStartsPending,
} from './windowPlacement.js';

import {PlacementRequests, TERMINAL_PLACEMENT_STATES, placementVerified} from './placementRequests.js';
import {BUILD_REVISION} from './buildInfo.js';

const BUS_NAME = 'org.sagecat.GnomeWinCtl1';
const OBJECT_PATH = '/org/sagecat/GnomeWinCtl1';
const DISPLAY_CONFIG_BUS = 'org.gnome.Mutter.DisplayConfig';
const DISPLAY_CONFIG_PATH = '/org/gnome/Mutter/DisplayConfig';
const DISPLAY_CONFIG_INTERFACE = 'org.gnome.Mutter.DisplayConfig';
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
    <method name="CloseWindow">
      <arg type="s" direction="in" name="identity"/>
      <arg type="s" direction="out" name="result"/>
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
    'close_window',
    'place_window',
    'expect_window',
    'expectation_status',
    'cancel_expectation',
    'window_state',
    'monitor_intent',
    'monitor_recovery',
    'placement_lifecycle_v2',
    'staged_placement_handoff',
    'runtime_build',
];

const NEW_WINDOW_SETTLE_MS = 3500;
const UNEXPECTED_MOVE_DELAY_MS = 150;
const EXPECTED_MOVE_VERIFY_MS = 300;
const EXPLICIT_PLACEMENT_GRACE_MS = 1000;
const TOPOLOGY_EVENT_GRACE_MS = 500;
const RESTORING_GRACE_MS = 500;
const RECOVERY_SETTLE_MS = 1500;
const RECOVERY_VERIFY_MS = 650;
const RECOVERY_MAX_PASSES = 3;
const DISPLAY_CONFIG_RETRY_MS = 600;
const DISPLAY_CONFIG_MAX_RETRIES = 2;
// Each verification pass may wait for a slow client to settle its normal frame
// and accept maximize; a loaded Electron guest took ~3.6 s just to settle. A
// staged handoff verifies its final workspace in a separate pass.
const VERIFY_POLL_MS = 100;
const VERIFY_BUDGET_US = 10 * 1000 * 1000;
const VERIFY_MAX_ATTEMPTS = VERIFY_BUDGET_US / (VERIFY_POLL_MS * 1000);
const ACTIVE_WORKSPACE_SETTLE_MS = 300;
const ACTIVE_WORKSPACE_RECOVERY_MS = 3000;
const RESTORE_RATE_WINDOW_US = 5 * 1000 * 1000;
const RESTORE_RATE_LIMIT = 3;
const RESTORE_SUSPEND_US = 30 * 1000 * 1000;
const UNCONSTRAINED_GRAB_FLAG = 1024;
const MOVE_GRABS = new Set([Meta.GrabOp.MOVING, Meta.GrabOp.KEYBOARD_MOVING]);
const MONITOR_MOVE_BINDINGS = new Map([
    ['move-to-monitor-up', Meta.DisplayDirection.UP],
    ['move-to-monitor-down', Meta.DisplayDirection.DOWN],
    ['move-to-monitor-left', Meta.DisplayDirection.LEFT],
    ['move-to-monitor-right', Meta.DisplayDirection.RIGHT],
]);

function normalWindows() {
    return global.get_window_actors()
        .map(actor => actor.meta_window)
        .filter(window => window && window.get_window_type() === Meta.WindowType.NORMAL);
}

const CLOSE_REFUSALS = {
    invalid_request: 'provide a valid ID, PID, workspace index and enable epoch',
    stale_epoch: 'window identity belongs to a different extension enable epoch',
    screen_unavailable: 'the screen is locked or shielded',
    missing_workspace: 'the requested workspace index does not exist',
    dynamic_workspaces: 'named close requires static workspaces',
    workspace_name_changed: 'the requested name is no longer unique at that workspace index',
    ambiguous_id: 'the window ID is ambiguous',
    workspace_changed: 'the window is no longer on the requested workspace',
    pid_changed: 'the window no longer has the requested PID',
    workspace_blocked: 'the workspace contains an unlisted window or dialog',
    unsupported_window: 'only normal managed windows can be closed',
    sticky: 'the window is visible on all workspaces',
    transient: 'the window is a transient or has a transient child',
    unsupported_client: 'the window is not a native Wayland client',
    not_closable: 'the compositor does not allow this window to be closed',
    invalid_pid: 'the compositor has no valid client PID',
};

function transientParents(windows) {
    return new Set(windows.map(window => window.get_transient_for()).filter(Boolean));
}

function closeBlocker(window, parents) {
    if (window.get_window_type() !== Meta.WindowType.NORMAL || window.is_override_redirect())
        return 'unsupported_window';
    if (window.is_on_all_workspaces())
        return 'sticky';
    if (window.get_transient_for() || parents.has(window))
        return 'transient';
    // Mutter's X11 delete can fall back to XKillClient when WM_DELETE_WINDOW is absent.
    if (window.get_client_type() !== Meta.WindowClientType.WAYLAND)
        return 'unsupported_client';
    if (!window.can_close())
        return 'not_closable';
    if (window.get_pid() <= 0)
        return 'invalid_pid';
    return null;
}

function closeRefused(reason) {
    return JSON.stringify({status: 'refused', reason, message: CLOSE_REFUSALS[reason]});
}

function workspaceBlockers(workspace, windows, listed) {
    return windows.filter(window => !listed.has(window) && !window.is_override_redirect() &&
        !window.is_on_all_workspaces() && window.get_workspace() === workspace &&
        ![Meta.WindowType.DESKTOP, Meta.WindowType.DOCK].includes(window.get_window_type())).length;
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
        this._enableEpoch = GLib.uuid_string_random();
        try {
            this._enable();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _timeout(priority, delay, callback) {
        const epoch = this._enableEpoch;
        return GLib.timeout_add(priority, delay, () =>
            this._enableEpoch === epoch ? callback() : GLib.SOURCE_REMOVE);
    }

    _enable() {
        this._expectations = [];
        this._requests = new PlacementRequests(() => GLib.get_monotonic_time());
        this._windowSequence = 0;
        this._retrySources = new Set();
        this._pendingTrackSources = new Set();
        this._activeWorkspaceRestoreSource = 0;
        this._activeWorkspaceRestoreUntil = 0;
        this._monitorRecords = new Map();
        this._screenShieldSignals = [];
        this._overviewSignals = [];
        this._monitorMoveBindings = [];
        this._displayConfigMonitors = [];
        this._displayConfigCacheValid = false;
        this._displayConfigGeneration = 0;
        this._displayConfigPending = 0;
        this._displayConfigRefreshing = false;
        this._displayConfigSignal = 0;
        this._displayConfigRetrySource = 0;
        this._displayConfigCancellable = new Gio.Cancellable();
        this._identityReady = false;
        this._recovery = {
            active: false,
            generation: 0,
            pass: 0,
            totalMoved: 0,
            reasons: new Set(),
            source: 0,
            wakeRequested: false,
        };
        this._workspaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._windowCreatedId = global.display.connect(
            'window-created',
            (_display, window) => {
                this._queueTrackWindow(window);
                this._windowCreated(window);
            },
        );
        this._grabBeginId = global.display.connect(
            'grab-op-begin',
            (_display, window, grabOp) => this._onGrabBegin(window, grabOp),
        );
        this._grabEndId = global.display.connect(
            'grab-op-end',
            (_display, window, grabOp) => this._onGrabEnd(window, grabOp),
        );
        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => this._onMonitorsChanged(),
        );
        this._activeWorkspaceChangedId = global.workspace_manager.connect(
            'active-workspace-changed',
            () => this._onActiveWorkspaceChanged(),
        );
        this._connectScreenShield();
        this._connectOverviewDrag();
        this._installMonitorMoveBindings();
        this._subscribeDisplayConfig();
        this._refreshDisplayConfig('enable');
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
        this._enableEpoch = null;
        const release = action => {
            try { action(); } catch (error) {
                console.error(`gnome-winctl: resource cleanup failed: ${error.message}`);
            }
        };
        // Stop externally callable resources before dismantling their state.
        release(() => this._exported?.unexport());
        this._exported = null;
        if (this._ownerId)
            release(() => Gio.bus_unown_name(this._ownerId));
        this._ownerId = 0;
        release(() => this._displayConfigCancellable?.cancel());
        this._displayConfigCancellable = null;
        if (this._displayConfigSignal)
            release(() => Gio.DBus.session.signal_unsubscribe(this._displayConfigSignal));
        this._displayConfigSignal = 0;
        release(() => this._restoreMonitorMoveBindings());
        for (const signal of this._overviewSignals ?? [])
            release(() => Main.overview.disconnect(signal));
        this._overviewSignals = [];
        for (const signal of this._screenShieldSignals ?? [])
            release(() => Main.screenShield?.disconnect(signal));
        this._screenShieldSignals = [];
        for (const [object, field] of [
            [global.workspace_manager, '_activeWorkspaceChangedId'],
            [Main.layoutManager, '_monitorsChangedId'],
            [global.display, '_grabEndId'], [global.display, '_grabBeginId'],
            [global.display, '_windowCreatedId'],
        ]) {
            if (this[field])
                release(() => object.disconnect(this[field]));
            this[field] = 0;
        }
        for (const source of [this._recovery?.source, this._displayConfigRetrySource,
            this._activeWorkspaceRestoreSource, ...this._retrySources ?? [], ...this._pendingTrackSources ?? []]) {
            if (source)
                release(() => GLib.source_remove(source));
        }
        this._retrySources?.clear();
        this._pendingTrackSources?.clear();
        this._activeWorkspaceRestoreSource = 0;
        this._activeWorkspaceRestoreUntil = 0;
        this._displayConfigRetrySource = 0;
        this._recovery = null;
        this._displayConfigMonitors = [];
        this._displayConfigCacheValid = false;
        this._displayConfigRefreshing = false;
        for (const window of this._monitorRecords?.keys() ?? [])
            release(() => this._untrackWindow(window));
        this._monitorRecords?.clear();
        this._monitorRecords = null;
        this._expectations = [];
        this._requests?.records.clear();
        this._workspaceSettings = null;
        this._mutterSettings = null;
    }

    _connectScreenShield() {
        const shield = Main.screenShield;
        if (!shield)
            return;
        for (const signal of ['active-changed', 'locked-changed', 'wake-up-screen']) {
            this._screenShieldSignals.push(shield.connect(
                signal,
                () => this._onScreenShieldChanged(signal),
            ));
        }
    }

    _subscribeDisplayConfig() {
        const epoch = this._enableEpoch;
        this._displayConfigSignal = Gio.DBus.session.signal_subscribe(
            DISPLAY_CONFIG_BUS,
            DISPLAY_CONFIG_INTERFACE,
            'MonitorsChanged',
            DISPLAY_CONFIG_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            () => {
                if (this._enableEpoch !== epoch)
                    return;
                this._beginRecovery('display-config-change');
                this._displayConfigCacheValid = false;
                this._refreshDisplayConfig('display-config-change');
            },
        );
    }

    _refreshDisplayConfig(reason, retry = 0) {
        if (!this._displayConfigCancellable)
            return false;
        if (retry === 0 && this._displayConfigRetrySource) {
            GLib.source_remove(this._displayConfigRetrySource);
            this._displayConfigRetrySource = 0;
        }
        const generation = ++this._displayConfigGeneration;
        const epoch = this._enableEpoch;
        const cancellable = this._displayConfigCancellable;
        this._displayConfigPending += 1;
        this._displayConfigRefreshing = true;
        Gio.DBus.session.call(
            DISPLAY_CONFIG_BUS,
            DISPLAY_CONFIG_PATH,
            DISPLAY_CONFIG_INTERFACE,
            'GetCurrentState',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            3000,
            cancellable,
            (connection, result) => {
                let state = null;
                let error = null;
                try {
                    state = connection.call_finish(result).deepUnpack();
                } catch (caught) {
                    error = caught;
                }
                if (this._enableEpoch !== epoch || this._displayConfigCancellable !== cancellable)
                    return;
                this._displayConfigPending = Math.max(0, this._displayConfigPending - 1);
                if (generation !== this._displayConfigGeneration)
                    return;
                this._displayConfigRefreshing = false;

                if (state) {
                    this._displayConfigMonitors = displayConfigLogicalMonitors(state);
                    this._displayConfigCacheValid = true;
                } else {
                    this._displayConfigMonitors = [];
                    this._displayConfigCacheValid = false;
                    console.warn(
                        `gnome-winctl: DisplayConfig refresh failed (${reason}): ` +
                        `${error?.message ?? 'unknown error'}`
                    );
                }

                const recoveryMayRun = !this._screenUnavailable() ||
                    Boolean(this._recovery?.wakeRequested);
                const shouldRetry = !state && retry < DISPLAY_CONFIG_MAX_RETRIES &&
                    recoveryMayRun;
                if (shouldRetry) {
                    this._displayConfigRetrySource = this._timeout(
                        GLib.PRIORITY_DEFAULT,
                        DISPLAY_CONFIG_RETRY_MS,
                        () => {
                            this._displayConfigRetrySource = 0;
                            this._refreshDisplayConfig(reason, retry + 1);
                            return GLib.SOURCE_REMOVE;
                        },
                    );
                }

                const firstRefresh = !this._identityReady;
                this._identityReady = true;
                if (firstRefresh) {
                    for (const actor of global.get_window_actors())
                        this._trackWindow(actor.meta_window, false, true);
                }
                if (!this._recovery?.active) {
                    this._upgradePendingMonitorIdentities();
                    this._recoverResolvedMonitorIntents(`display-config:${reason}`);
                } else if (this._recoveryCanRun() && !shouldRetry)
                    this._scheduleRecovery(RECOVERY_SETTLE_MS);
            },
        );
        return true;
    }

    _upgradePendingMonitorIdentities() {
        if (!this._displayConfigCacheValid)
            return;
        const monitors = this._monitors();
        for (const [window, record] of this._monitorRecords) {
            if (!record.identityPending)
                continue;
            const monitor = monitorForAnchor(record.anchor, monitors);
            if (!monitor || !anchorHasPhysicalIdentity(captureMonitorAnchor(monitor)))
                continue;
            this._setRecordAnchor(
                window,
                record,
                captureMonitorAnchor(monitor),
                false,
            );
        }
    }

    _recoverResolvedMonitorIntents(reason) {
        if (!this._displayConfigCacheValid || this._screenUnavailable() ||
            this._recovery?.active)
            return;
        const monitors = this._monitors();
        const needed = [...this._monitorRecords].some(([window, record]) => {
            if (!windowIsOnActiveWorkspace(window, global.workspace_manager))
                return false;
            if (record.explicitDepth > 0 || record.grabActive || record.overviewDrag ||
                record.pendingMove || record.restoring || record.settling ||
                record.commitSource)
                return false;
            const target = monitorForAnchor(record.anchor, monitors);
            return Boolean(target && window.get_monitor() !== target.index);
        });
        if (!needed)
            return;
        this._beginRecovery(reason);
        this._scheduleRecovery(RECOVERY_VERIFY_MS);
    }

    _connectOverviewDrag() {
        this._overviewSignals.push(Main.overview.connect(
            'window-drag-begin',
            (_overview, window) => this._onOverviewDragBegin(window),
        ));
        this._overviewSignals.push(Main.overview.connect(
            'window-drag-end',
            (_overview, window) => this._onOverviewDragEnd(window),
        ));
        this._overviewSignals.push(Main.overview.connect(
            'window-drag-cancelled',
            (_overview, window) => this._onOverviewDragCancelled(window),
        ));
    }

    _installMonitorMoveBindings() {
        // Mutter currently exposes a setter but no getter. In that case we
        // cannot establish ownership or restore another extension's handler.
        this._monitorBindingCompatibility = 'ownership API unavailable; native bindings retained';
        if (typeof Meta.keybindings_get_custom_handler !== 'function')
            return;
        this._monitorBindingCompatibility = 'owned handlers with previous-owner restoration';
        for (const [name] of MONITOR_MOVE_BINDINGS) {
            const previous = Meta.keybindings_get_custom_handler(name);
            const handler = this._handleMonitorMoveBinding.bind(this);
            if (Meta.keybindings_set_custom_handler(name, handler))
                this._monitorMoveBindings.push({name, handler, previous});
        }
    }

    _restoreMonitorMoveBindings() {
        for (const {name, handler, previous} of this._monitorMoveBindings ?? []) {
            try {
                if (Meta.keybindings_get_custom_handler?.(name) === handler)
                    Meta.keybindings_set_custom_handler(name, previous);
            } catch (error) {
                console.error(`gnome-winctl: cannot restore ${name}: ${error.message}`);
            }
        }
        this._monitorMoveBindings = [];
    }

    _handleMonitorMoveBinding(display, window, binding) {
        if (this._screenUnavailable())
            return;
        const name = binding?.get_name?.() ?? '';
        const direction = MONITOR_MOVE_BINDINGS.get(name);
        window ??= display.focus_window;
        if (direction === undefined || !window ||
            window.get_window_type() !== Meta.WindowType.NORMAL ||
            window.allows_move?.() === false)
            return;

        const targetIndex = display.get_monitor_neighbor_index(window.get_monitor(), direction);
        if (targetIndex < 0 || targetIndex === window.get_monitor())
            return;
        const monitors = this._monitors();
        const target = monitors.find(monitor => monitor.index === targetIndex);
        if (!target)
            return;

        this._trackWindow(window, false, true);
        const record = this._monitorRecords.get(window);
        display.clear_mouse_mode?.();
        if (!record) {
            window.move_to_monitor(targetIndex);
            return;
        }

        this._cancelStableMonitorCommit(window, record, true);
        this._cancelPlacementIntent(record);
        this._cancelSettling(record);
        this._cancelRecordSource(record, 'restoreSource');
        this._cancelPendingMove(window, record, true);
        const previousAnchor = record.anchor;
        const targetAnchor = captureMonitorAnchor(target);
        const generation = ++record.pendingGeneration;
        record.pendingMove = {generation, previousAnchor, targetAnchor, name};
        this._setRecordAnchor(window, record, targetAnchor, true);
        try {
            window.move_to_monitor(targetIndex);
        } catch (error) {
            record.pendingMove = null;
            this._setRecordAnchor(window, record, previousAnchor, false);
            console.error(`gnome-winctl: ${name} failed: ${error.message}`);
            return;
        }
        record.pendingSource = this._timeout(
            GLib.PRIORITY_DEFAULT,
            EXPECTED_MOVE_VERIFY_MS,
            () => {
                record.pendingSource = 0;
                if (!record.pendingMove || record.pendingMove.generation !== generation)
                    return GLib.SOURCE_REMOVE;
                if (this._screenUnavailable()) {
                    record.pendingMove = null;
                    return GLib.SOURCE_REMOVE;
                }
                const currentMonitors = this._monitors();
                const current = currentMonitors.find(
                    monitor => monitor.index === window.get_monitor()
                );
                const succeeded = monitorForAnchor(targetAnchor, currentMonitors)?.index === current?.index;
                record.pendingMove = null;
                if (succeeded)
                    this._rememberCurrentMonitor(window, record, true);
                else {
                    this._setRecordAnchor(window, record, previousAnchor, false);
                    this._queueUnexpectedRestore(window, record, `${name}-verification`);
                }
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _cancelRecordSource(record, field) {
        if (!record?.[field])
            return;
        GLib.source_remove(record[field]);
        record[field] = 0;
    }

    _cancelSettling(record) {
        this._cancelRecordSource(record, 'settleSource');
        record.settling = false;
    }

    _cancelPlacementIntent(record, retainRequest = false) {
        if (!retainRequest && record.requestToken)
            this._requests.update(record.requestToken, 'cancelled', {message: 'placement superseded by a user move'});
        this._cancelRecordSource(record, 'placementSource');
        record.explicitAnchor = null;
        record.placementIntent = null;
        record.deferredPlacement = null;
    }

    _cancelStableMonitorCommit(window, record, commitCurrent = false) {
        if (!record?.commitSource)
            return;
        this._cancelRecordSource(record, 'commitSource');
        if (commitCurrent)
            this._rememberCurrentMonitor(window, record, true);
    }

    _queueStableMonitorCommit(window, record) {
        this._cancelStableMonitorCommit(window, record, false);
        record.commitSource = this._timeout(
            GLib.PRIORITY_DEFAULT,
            TOPOLOGY_EVENT_GRACE_MS,
            () => {
                record.commitSource = 0;
                if (!this._monitorRecords?.has(window) || this._recovery?.active ||
                    this._screenUnavailable() || record.explicitDepth > 0 ||
                    record.grabActive || record.overviewDrag || record.pendingMove ||
                    record.placementIntent || record.deferredPlacement || record.restoring)
                    return GLib.SOURCE_REMOVE;
                this._rememberCurrentMonitor(window, record, true);
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _setRecordAnchor(window, record, anchor, authoritative) {
        if (!anchor)
            return;
        record.anchor = anchor;
        record.identityPending = !anchorHasPhysicalIdentity(anchor);
        if (authoritative) {
            record.workspaceRecoveryPending = false;
            record.restoreTimes = [];
            record.suspendedUntil = 0;
        }
    }

    _rememberCurrentMonitor(window, record, authoritative) {
        const monitors = this._monitors();
        const monitor = monitors.find(item => item.index === window.get_monitor());
        if (!monitor)
            return false;
        this._setRecordAnchor(
            window,
            record,
            captureMonitorAnchor(monitor),
            authoritative,
        );
        return true;
    }

    _cancelPendingMove(window, record, commitCurrent) {
        if (!record?.pendingMove && !record?.pendingSource)
            return;
        const previousAnchor = record.pendingMove?.previousAnchor ?? record.anchor;
        this._cancelRecordSource(record, 'pendingSource');
        record.pendingMove = null;
        record.pendingGeneration += 1;
        if (commitCurrent)
            this._rememberCurrentMonitor(window, record, true);
        else
            this._setRecordAnchor(window, record, previousAnchor, false);
    }

    _queueTrackWindow(window) {
        let attempts = 0;
        let source = 0;
        source = this._timeout(GLib.PRIORITY_DEFAULT, 100, () => {
            attempts += 1;
            let finished = false;
            try {
                finished = this._trackWindow(window, true);
            } catch {
                finished = true;
            }
            if (finished || attempts >= 30) {
                this._pendingTrackSources.delete(source);
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._pendingTrackSources.add(source);
    }

    _trackWindow(window, settle, allowFallback = false) {
        if (!window)
            return false;
        if (window.get_window_type() !== Meta.WindowType.NORMAL)
            return true;
        if (this._monitorRecords.has(window))
            return true;
        if (!this._identityReady && !allowFallback)
            return false;

        const monitors = this._monitors();
        const current = monitors.find(monitor => monitor.index === window.get_monitor());
        if (!current)
            return false;
        const anchor = captureMonitorAnchor(current);
        const record = {
            anchor,
            identityPending: !anchorHasPhysicalIdentity(anchor),
            settling: Boolean(settle),
            explicitDepth: 0,
            grabActive: false,
            overviewDrag: false,
            overviewCancelled: false,
            restoring: false,
            restoreTimes: [],
            suspendedUntil: 0,
            pendingGeneration: 0,
            pendingMove: null,
            monitorSignal: 0,
            unmanagedSignal: 0,
            settleSource: 0,
            restoreSource: 0,
            pendingSource: 0,
            restoringSource: 0,
            placementSource: 0,
            commitSource: 0,
            explicitAnchor: null,
            placementIntent: null,
            deferredPlacement: null,
            workspaceRecoveryPending: false,
            grabFrozen: false,
            overviewFrozen: false,
        };
        record.monitorSignal = window.connect(
            'monitor-changed',
            (_window, oldMonitor) => this._onWindowMonitorChanged(window, oldMonitor),
        );
        record.unmanagedSignal = window.connect(
            'unmanaged',
            () => this._untrackWindow(window),
        );
        this._monitorRecords.set(window, record);

        if (record.settling) {
            record.settleSource = this._timeout(
                GLib.PRIORITY_DEFAULT,
                NEW_WINDOW_SETTLE_MS,
                () => {
                    record.settleSource = 0;
                    record.settling = false;
                    if (deferredPlacementCanApply(
                        window,
                        global.workspace_manager,
                        this._screenUnavailable(),
                        record.deferredPlacement,
                    ))
                        this._applyDeferredPlacement(window, record, 'new-window-settled');
                    else if (!this._recovery?.active && !this._screenUnavailable() &&
                        record.explicitDepth === 0 && !record.grabActive &&
                        !record.overviewDrag && !record.placementIntent &&
                        !record.deferredPlacement)
                        this._rememberCurrentMonitor(window, record, true);
                    else if (this._recovery?.active && !this._screenUnavailable())
                        this._scheduleRecovery(RECOVERY_VERIFY_MS);
                    return GLib.SOURCE_REMOVE;
                },
            );
        }
        return true;
    }

    _untrackWindow(window) {
        const record = this._monitorRecords?.get(window);
        if (!record)
            return;
        if (record.requestToken)
            this._requests.update(record.requestToken, 'failed', {message: 'window was unmanaged before placement completed'});
        for (const field of [
            'settleSource', 'restoreSource', 'pendingSource', 'restoringSource',
            'placementSource', 'commitSource', 'initialFrameSource',
        ])
            this._cancelRecordSource(record, field);
        if (record.monitorSignal)
            window.disconnect(record.monitorSignal);
        if (record.unmanagedSignal)
            window.disconnect(record.unmanagedSignal);
        if (record.initialFrameSignal)
            window.disconnect(record.initialFrameSignal);
        this._monitorRecords.delete(window);
    }

    _onGrabBegin(window, grabOp) {
        const normalized = grabOp & ~UNCONSTRAINED_GRAB_FLAG;
        if (!window || !MOVE_GRABS.has(normalized))
            return;
        this._trackWindow(window, false, true);
        const record = this._monitorRecords.get(window);
        if (!record)
            return;
        record.grabActive = true;
        if (this._screenUnavailable()) {
            record.grabFrozen = true;
            return;
        }
        this._cancelStableMonitorCommit(window, record, true);
        this._cancelPlacementIntent(record);
        this._cancelSettling(record);
        this._cancelRecordSource(record, 'restoreSource');
        this._cancelPendingMove(window, record, true);
        record.grabFrozen = false;
    }

    _onGrabEnd(window, grabOp) {
        const normalized = grabOp & ~UNCONSTRAINED_GRAB_FLAG;
        const record = this._monitorRecords?.get(window);
        if (!record || !MOVE_GRABS.has(normalized))
            return;
        const frozen = record.grabFrozen;
        record.grabActive = false;
        record.grabFrozen = false;
        if (!frozen && !this._screenUnavailable())
            this._rememberCurrentMonitor(window, record, true);
        else if (frozen && !this._screenUnavailable()) {
            this._beginRecovery('interrupted-grab-end');
            this._scheduleRecovery(RECOVERY_VERIFY_MS);
        }
    }

    _onOverviewDragBegin(window) {
        this._trackWindow(window, false, true);
        const record = this._monitorRecords?.get(window);
        if (!record)
            return;
        record.overviewDrag = true;
        record.overviewCancelled = false;
        if (this._screenUnavailable()) {
            record.overviewFrozen = true;
            return;
        }
        this._cancelStableMonitorCommit(window, record, true);
        this._cancelPlacementIntent(record);
        this._cancelSettling(record);
        this._cancelRecordSource(record, 'restoreSource');
        this._cancelPendingMove(window, record, true);
        record.overviewFrozen = false;
    }

    _onOverviewDragEnd(window) {
        const record = this._monitorRecords?.get(window);
        if (!record || !record.overviewDrag && !record.overviewFrozen &&
            !record.overviewCancelled)
            return;
        const frozen = record.overviewFrozen || record.overviewCancelled;
        record.overviewDrag = false;
        record.overviewFrozen = false;
        record.overviewCancelled = false;
        if (!frozen && !this._screenUnavailable())
            this._rememberCurrentMonitor(window, record, true);
        else if (frozen && !this._screenUnavailable()) {
            this._beginRecovery('interrupted-overview-drag-end');
            this._scheduleRecovery(RECOVERY_VERIFY_MS);
        }
    }

    _onOverviewDragCancelled(window) {
        const record = this._monitorRecords?.get(window);
        if (!record || !record.overviewDrag)
            return;
        // Shell emits drag-end after the snapback animation. Preserve the
        // pre-drag anchor and ignore monitor signals until that final event.
        record.overviewCancelled = true;
        record.overviewFrozen = true;
    }

    _beginExplicitPlacement(window, intendedAnchor) {
        this._trackWindow(window, false, true);
        const record = this._monitorRecords.get(window) ?? null;
        if (this._awaitInitialFrame(window, record)) {
            // Keep the accepted target in the deferred request until it can
            // apply. A cancelled request must not leave a recovery anchor.
            this._cancelPlacementIntent(record, true);
            return record;
        }
        if (!record)
            return null;
        this._cancelStableMonitorCommit(window, record, true);
        this._cancelPlacementIntent(record, true);
        this._cancelSettling(record);
        this._cancelRecordSource(record, 'restoreSource');
        this._cancelPendingMove(window, record, true);
        record.explicitDepth += 1;
        record.explicitAnchor = intendedAnchor;
        if (intendedAnchor)
            this._setRecordAnchor(window, record, intendedAnchor, true);
        return record;
    }

    _endExplicitPlacement(window, record) {
        if (!record || !this._monitorRecords.has(window))
            return;
        record.explicitDepth = Math.max(0, record.explicitDepth - 1);
        if (record.explicitDepth !== 0)
            return;
        const intendedAnchor = record.explicitAnchor;
        record.explicitAnchor = null;
        if (!intendedAnchor) {
            this._rememberCurrentMonitor(window, record, true);
            return;
        }
        this._setRecordAnchor(window, record, intendedAnchor, true);
        record.placementIntent = intendedAnchor;
        record.placementSource = this._timeout(
            GLib.PRIORITY_DEFAULT,
            EXPLICIT_PLACEMENT_GRACE_MS,
            () => {
                record.placementSource = 0;
                if (record.placementIntent === intendedAnchor) {
                    record.placementIntent = null;
                    const target = monitorForAnchor(record.anchor, this._monitors());
                    if (target && (window.get_monitor() !== target.index ||
                        record.deferredPlacement?.target.stage_before_handoff) &&
                        !this._screenUnavailable() &&
                        windowIsOnActiveWorkspace(window, global.workspace_manager)) {
                        this._beginRecovery('post-placement-verification');
                        this._scheduleRecovery(RECOVERY_VERIFY_MS);
                    }
                }
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _onWindowMonitorChanged(window, oldMonitor) {
        const record = this._monitorRecords?.get(window);
        if (!record)
            return;
        if (this._screenUnavailable() || record.grabFrozen || record.overviewFrozen ||
            record.overviewCancelled)
            return;
        const monitors = this._monitors();
        const current = monitors.find(monitor => monitor.index === window.get_monitor());
        const anchored = monitorForAnchor(record.anchor, monitors);
        const pending = Boolean(record.pendingMove);
        const workspaceRecovery = protectMonitorAnchorDuringWorkspaceRecovery(
            record.workspaceRecoveryPending,
            record.deferredPlacement,
        );
        const action = decideMonitorChange({
            screenUnavailable: this._screenUnavailable(),
            explicit: record.explicitDepth > 0 || Boolean(record.placementIntent),
            grabActive: record.grabActive,
            overview: record.overviewDrag,
            settling: record.settling,
            restoring: record.restoring || pending,
            recovery: Boolean(this._recovery?.active) || this._screenUnavailable() ||
                workspaceRecovery,
            anchorAvailable: Boolean(anchored),
            matchesAnchor: Boolean(current && anchored && current.index === anchored.index),
        });

        if (action === MonitorChangeAction.COMMIT) {
            this._cancelPendingMove(window, record, false);
            const intendedAnchor = record.explicitAnchor ?? record.placementIntent;
            if (intendedAnchor)
                this._setRecordAnchor(window, record, intendedAnchor, true);
            else
                this._rememberCurrentMonitor(window, record, true);
            return;
        }
        if (action === MonitorChangeAction.COMMIT_AFTER_TOPOLOGY) {
            this._queueStableMonitorCommit(window, record);
            return;
        }
        if (action === MonitorChangeAction.KEEP) {
            this._cancelStableMonitorCommit(window, record, false);
            if (pending) {
                this._cancelRecordSource(record, 'pendingSource');
                record.pendingMove = null;
                record.pendingGeneration += 1;
                record.restoreTimes = [];
                record.suspendedUntil = 0;
            }
            return;
        }
        if (action === MonitorChangeAction.DEFER) {
            if (this._recovery?.active && !this._screenUnavailable())
                this._scheduleRecovery(RECOVERY_SETTLE_MS);
            return;
        }
        this._queueUnexpectedRestore(
            window,
            record,
            `monitor-changed:${oldMonitor}->${window.get_monitor()}`,
        );
    }

    _onActiveWorkspaceChanged() {
        this._cancelActiveWorkspaceRestore();
        if (this._screenUnavailable())
            return;
        const needed = [...this._monitorRecords].some(([window, record]) =>
            windowIsOnActiveWorkspace(window, global.workspace_manager) &&
            (record.workspaceRecoveryPending || record.deferredPlacement)
        );
        if (!needed)
            return;
        this._activeWorkspaceRestoreUntil = GLib.get_monotonic_time() +
            ACTIVE_WORKSPACE_RECOVERY_MS * 1000;
        this._activeWorkspaceRestoreSource = this._timeout(
            GLib.PRIORITY_DEFAULT,
            ACTIVE_WORKSPACE_SETTLE_MS,
            () => {
                if (this._screenUnavailable()) {
                    this._activeWorkspaceRestoreSource = 0;
                    this._activeWorkspaceRestoreUntil = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._restoreActiveWorkspace('workspace-activated');
                if (GLib.get_monotonic_time() < this._activeWorkspaceRestoreUntil)
                    return GLib.SOURCE_CONTINUE;
                this._clearActiveWorkspaceRecoveryPending();
                this._activeWorkspaceRestoreSource = 0;
                this._activeWorkspaceRestoreUntil = 0;
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _cancelActiveWorkspaceRestore() {
        if (this._activeWorkspaceRestoreSource)
            GLib.source_remove(this._activeWorkspaceRestoreSource);
        this._activeWorkspaceRestoreSource = 0;
        this._activeWorkspaceRestoreUntil = 0;
    }

    _clearActiveWorkspaceRecoveryPending() {
        for (const [window, record] of this._monitorRecords ?? []) {
            if (windowIsOnActiveWorkspace(window, global.workspace_manager))
                record.workspaceRecoveryPending = false;
        }
    }

    _restoreActiveWorkspace(reason) {
        if (this._screenUnavailable() || !this._monitorRecords)
            return;
        const monitors = this._monitors();
        let restored = 0;
        let missing = 0;
        let skipped = 0;
        for (const [window, record] of this._monitorRecords) {
            if (!windowIsOnActiveWorkspace(window, global.workspace_manager) &&
                !record.deferredPlacement?.target.stage_before_handoff)
                continue;
            if (!record.workspaceRecoveryPending && !record.deferredPlacement)
                continue;
            if (record.explicitDepth > 0 || record.grabActive || record.overviewDrag ||
                record.pendingMove || record.restoring || record.settling) {
                skipped += 1;
                continue;
            }
            if (record.deferredPlacement) {
                if (this._applyDeferredPlacement(window, record, reason))
                    restored += 1;
                else
                    skipped += 1;
                continue;
            }
            const target = monitorForAnchor(record.anchor, monitors);
            if (!target) {
                missing += 1;
                continue;
            }
            if (window.get_monitor() !== target.index &&
                this._moveWindowToAnchor(window, record, target, reason))
                restored += 1;
        }
        if (restored || missing || skipped) {
            console.log(
                `gnome-winctl: active workspace recovery reason=${reason} ` +
                `restored=${restored} missing=${missing} skipped=${skipped}`
            );
        }
    }

    _applyResolvedPlacement(window, resolved) {
        window.unminimize();
        if (window.is_fullscreen())
            window.unmake_fullscreen();
        window.unmaximize(Meta.MaximizeFlags.BOTH);
        window.move_to_monitor(resolved.monitor);
        const geometry = resolved.geometry;
        const frame = window.get_frame_rect();
        if (windowIsOnActiveWorkspace(window, global.workspace_manager) &&
            (['x', 'y', 'width', 'height'].some(key => frame[key] !== geometry[key]) ||
                resolved.state === 'maximized')) {
            // Covered clients may withhold a pending configure even when only
            // position differs now. Expose the explicit placement without
            // changing focus or activating another workspace.
            window.raise();
        }
        window.move_resize_frame(
            true,
            geometry.x,
            geometry.y,
            geometry.width,
            geometry.height,
        );
        // Unmaximize and maximize in one turn can leave a Wayland client on
        // its previous monitor's frame. The owned verifier completes this
        // transition after the normal frame has stopped changing.
        if (resolved.state === 'maximized')
            return true;
        if (resolved.state === 'fullscreen')
            window.make_fullscreen();
        else if (resolved.state === 'minimized')
            window.minimize();
        return false;
    }

    _applyDeferredPlacement(window, record, reason) {
        const deferred = record.deferredPlacement;
        if (!deferred || record.initialFramePending || this._screenUnavailable() ||
            (!windowIsOnActiveWorkspace(window, global.workspace_manager) &&
                !deferred.target.stage_before_handoff))
            return false;
        const request = this._requests.get(deferred.token);
        if (request.status !== 'deferred') {
            record.deferredPlacement = null;
            return false;
        }
        const result = this._applyPlacement(window, deferred.target, deferred.token);
        return result.status === 'applied' || result.status === 'verified';
    }

    _screenUnavailable() {
        return Boolean(Main.screenShield?.active || Main.screenShield?.locked);
    }

    _recoveryCanRun() {
        if (!this._screenUnavailable())
            return true;
        return canRecoverBehindShield({
            wakeRequested: Boolean(this._recovery?.wakeRequested),
            displayConfigValid: this._displayConfigCacheValid,
            anchors: [...this._monitorRecords.values()].map(record => record.anchor),
            monitors: this._monitors(),
        });
    }

    _onScreenShieldChanged(signal) {
        if (this._screenUnavailable()) {
            for (const [window, record] of this._monitorRecords ?? []) {
                const request = this._requests.get(record.requestToken);
                if (request.status === 'applied' && request.target?.stage_before_handoff) {
                    record.deferredPlacement = {token: request.token, target: request.target};
                    this._requests.update(request.token, 'deferred', {deferred: true});
                }
            }
        }
        this._beginRecovery(`screen:${signal}`);
        if (signal === 'wake-up-screen' && this._recovery)
            this._recovery.wakeRequested = true;
        if (this._screenUnavailable() && !this._recovery?.wakeRequested)
            return;
        this._displayConfigCacheValid = false;
        if (!this._refreshDisplayConfig(`screen:${signal}`))
            this._scheduleRecovery(RECOVERY_SETTLE_MS);
    }

    _onMonitorsChanged() {
        this._beginRecovery('topology-change');
        this._displayConfigCacheValid = false;
        if ((!this._screenUnavailable() || this._recovery?.wakeRequested) &&
            !this._refreshDisplayConfig('topology-change'))
            this._scheduleRecovery(RECOVERY_SETTLE_MS);
    }

    _beginRecovery(reason) {
        if (!this._recovery)
            return;
        const starting = !this._recovery.active;
        this._recovery.active = true;
        this._recovery.generation += 1;
        this._recovery.pass = 0;
        this._recovery.totalMoved = 0;
        this._recovery.reasons.add(reason);
        if (this._recovery.source) {
            GLib.source_remove(this._recovery.source);
            this._recovery.source = 0;
        }
        for (const [window, record] of this._monitorRecords) {
            if (workspaceRecoveryStartsPending(window, global.workspace_manager))
                record.workspaceRecoveryPending = true;
            this._cancelRecordSource(record, 'restoreSource');
            this._cancelRecordSource(record, 'commitSource');
            if (record.settling)
                this._cancelSettling(record);
            if (record.grabActive)
                record.grabFrozen = true;
            if (record.overviewDrag)
                record.overviewFrozen = true;
            if (starting) {
                record.restoreTimes = [];
                record.suspendedUntil = 0;
            }
        }
        if (starting)
            console.log(`gnome-winctl: monitor recovery started (${reason})`);
    }

    _scheduleRecovery(delayMs) {
        if (!this._recovery?.active || !this._recoveryCanRun() ||
            this._displayConfigRefreshing || this._displayConfigRetrySource)
            return;
        if (this._recovery.source)
            GLib.source_remove(this._recovery.source);
        const generation = this._recovery.generation;
        this._recovery.source = this._timeout(
            GLib.PRIORITY_DEFAULT,
            delayMs,
            () => {
                this._recovery.source = 0;
                this._runRecoveryPass(generation);
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _runRecoveryPass(generation) {
        if (!this._recovery?.active || generation !== this._recovery.generation)
            return;
        if (!this._recoveryCanRun() || this._displayConfigRefreshing ||
            this._displayConfigRetrySource)
            return;

        const monitors = this._monitors();
        const canMove = this._recovery.pass < RECOVERY_MAX_PASSES;
        let moved = 0;
        let missing = 0;
        let skipped = 0;
        let deferredInactive = 0;
        for (const [window, record] of this._monitorRecords) {
            if (!windowIsOnActiveWorkspace(window, global.workspace_manager) &&
                !record.deferredPlacement?.target.stage_before_handoff) {
                record.workspaceRecoveryPending = true;
                const inactiveTarget = monitorForAnchor(record.anchor, monitors);
                if (record.deferredPlacement || inactiveTarget)
                    deferredInactive += 1;
                continue;
            }
            if (record.explicitDepth > 0 || record.grabActive ||
                record.overviewDrag || record.pendingMove || record.placementIntent) {
                skipped += 1;
                continue;
            }
            if (record.deferredPlacement) {
                if (canMove && this._applyDeferredPlacement(
                    window,
                    record,
                    `recovery:${[...this._recovery.reasons].join(',')}`,
                ))
                    moved += 1;
                else
                    skipped += 1;
                continue;
            }
            const target = monitorForAnchor(record.anchor, monitors);
            if (!target) {
                missing += 1;
                continue;
            }
            if (window.get_monitor() === target.index)
                continue;
            if (canMove && this._moveWindowToAnchor(
                window,
                record,
                target,
                `recovery:${[...this._recovery.reasons].join(',')}`,
            ))
                moved += 1;
        }

        if (canMove)
            this._recovery.pass += 1;
        this._recovery.totalMoved += moved;
        if (shouldContinueRecovery(moved, this._recovery.pass, RECOVERY_MAX_PASSES)) {
            this._scheduleRecovery(RECOVERY_VERIFY_MS);
            return;
        }
        this._finishRecovery({moved, missing, skipped, deferredInactive, monitors});
    }

    _finishRecovery({moved, missing, skipped, deferredInactive, monitors}) {
        if (!this._recovery)
            return;
        const reasons = [...this._recovery.reasons].join(',');
        const activationRecoveryActive = Boolean(
            this._activeWorkspaceRestoreSource &&
            GLib.get_monotonic_time() < this._activeWorkspaceRestoreUntil
        );
        let unresolved = 0;
        for (const [window, record] of this._monitorRecords) {
            if (!windowIsOnActiveWorkspace(window, global.workspace_manager))
                continue;
            record.workspaceRecoveryPending = pendingWorkspaceRecoveryAfterGlobalFinish(
                record.workspaceRecoveryPending,
                activationRecoveryActive,
            );
            if (record.explicitDepth > 0 || record.grabActive ||
                record.overviewDrag || record.pendingMove || record.placementIntent)
                continue;
            const target = monitorForAnchor(record.anchor, monitors);
            if (target && window.get_monitor() !== target.index)
                unresolved += 1;
        }
        console.log(
            `gnome-winctl: monitor recovery finished reasons=${reasons || 'none'} ` +
            `passes=${this._recovery.pass} moved=${this._recovery.totalMoved} ` +
            `missing=${missing} ` +
            `skipped=${skipped} deferred_inactive=${deferredInactive} ` +
            `unresolved=${unresolved}`
        );
        this._recovery.active = false;
        this._recovery.pass = 0;
        this._recovery.totalMoved = 0;
        this._recovery.reasons.clear();
        this._recovery.wakeRequested = false;
        this._upgradePendingMonitorIdentities();
    }

    _queueUnexpectedRestore(window, record, reason) {
        if (record.restoreSource || this._recovery?.active || this._screenUnavailable())
            return;
        if (!windowIsOnActiveWorkspace(window, global.workspace_manager))
            return;
        const now = GLib.get_monotonic_time();
        if (now < record.suspendedUntil)
            return;
        record.restoreSource = this._timeout(
            GLib.PRIORITY_DEFAULT,
            UNEXPECTED_MOVE_DELAY_MS,
            () => {
                record.restoreSource = 0;
                if (this._recovery?.active || this._screenUnavailable() ||
                    record.explicitDepth > 0 || record.grabActive || record.overviewDrag ||
                    record.pendingMove ||
                    !windowIsOnActiveWorkspace(window, global.workspace_manager))
                    return GLib.SOURCE_REMOVE;
                const monitors = this._monitors();
                const target = monitorForAnchor(record.anchor, monitors);
                if (target && window.get_monitor() !== target.index)
                    this._moveWindowToAnchor(window, record, target, reason);
                return GLib.SOURCE_REMOVE;
            },
        );
    }

    _restoreAllowed(window, record) {
        const now = GLib.get_monotonic_time();
        if (record.suspendedUntil && now >= record.suspendedUntil) {
            record.suspendedUntil = 0;
            record.restoreTimes = [];
        }
        if (now < record.suspendedUntil)
            return false;
        record.restoreTimes = retainRecentRestores(
            record.restoreTimes,
            now,
            RESTORE_RATE_WINDOW_US,
        );
        if (record.restoreTimes.length < RESTORE_RATE_LIMIT)
            return true;
        record.suspendedUntil = now + RESTORE_SUSPEND_US;
        console.error(
            `gnome-winctl: suspended monitor enforcement for stable=${window.get_stable_sequence()} ` +
            `pid=${window.get_pid()} after ${RESTORE_RATE_LIMIT} rapid restorations`
        );
        return false;
    }

    _moveWindowToAnchor(window, record, target, reason) {
        if (record.restoring || window.get_monitor() === target.index ||
            !windowIsOnActiveWorkspace(window, global.workspace_manager) ||
            !this._restoreAllowed(window, record))
            return false;
        const from = window.get_monitor();
        record.restoring = true;
        this._cancelRecordSource(record, 'restoringSource');
        try {
            window.move_to_monitor(target.index);
        } catch (error) {
            record.restoring = false;
            console.error(`gnome-winctl: monitor restoration failed: ${error.message}`);
            return false;
        }
        record.restoreTimes.push(GLib.get_monotonic_time());
        console.warn(
            `gnome-winctl: restored stable=${window.get_stable_sequence()} ` +
            `pid=${window.get_pid()} from=${from} to=${target.index} reason=${reason}`
        );
        record.restoringSource = this._timeout(
            GLib.PRIORITY_DEFAULT,
            RESTORING_GRACE_MS,
            () => {
                record.restoringSource = 0;
                record.restoring = false;
                const monitors = this._monitors();
                const anchored = monitorForAnchor(record.anchor, monitors);
                if (anchored && window.get_monitor() !== anchored.index) {
                    if (this._recovery?.active && !this._screenUnavailable())
                        this._scheduleRecovery(RECOVERY_VERIFY_MS);
                    else
                        this._queueUnexpectedRestore(
                            window,
                            record,
                            'post-restore-verification',
                        );
                }
                return GLib.SOURCE_REMOVE;
            },
        );
        return true;
    }

    _monitorPolicyState() {
        return {
            enabled: true,
            tracked_windows: this._monitorRecords?.size ?? 0,
            recovery_active: Boolean(this._recovery?.active),
            recovery_pass: this._recovery?.pass ?? 0,
            recovery_reasons: [...(this._recovery?.reasons ?? [])],
            deferred_placements: [...(this._monitorRecords?.values() ?? [])]
                .filter(record => Boolean(record.deferredPlacement)).length,
            workspace_recovery_pending: [...(this._monitorRecords?.values() ?? [])]
                .filter(record => record.workspaceRecoveryPending).length,
            screen_unavailable: this._screenUnavailable(),
            display_identity_ready: this._identityReady,
            display_identity_cache_valid: this._displayConfigCacheValid,
            display_identity_refreshing: this._displayConfigRefreshing,
            display_identity_retry_pending: Boolean(this._displayConfigRetrySource),
            display_identity_requests: this._displayConfigPending,
            keybinding_compatibility: this._monitorBindingCompatibility,
            overridden_keybindings: (this._monitorMoveBindings ?? []).map(item => item.name),
        };
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
            physical_identities: [],
        }));
        return this._displayConfigCacheValid
            ? applyDisplayConfigIdentities(monitors, this._displayConfigMonitors)
            : monitors;
    }

    _workspaces(windows = global.display.list_all_windows(), listed = this._listedWindows(windows)) {
        const manager = global.workspace_manager;
        const names = this._workspaceSettings.get_strv('workspace-names');
        const result = [];
        for (let index = 0; index < manager.n_workspaces; index++) {
            const workspace = manager.get_workspace_by_index(index);
            result.push({
                index,
                name: names[index] || `Workspace ${index + 1}`,
                named: Boolean(names[index]),
                active: index === manager.get_active_workspace_index(),
                n_windows: workspace?.list_windows?.().filter(
                    window => window.get_window_type() === Meta.WindowType.NORMAL,
                ).length ?? 0,
                blocking_windows: workspaceBlockers(workspace, windows, listed),
            });
        }
        return result;
    }

    _windowRecord(window, monitors = this._monitors()) {
        const rect = window.get_frame_rect();
        const monitorIndex = window.get_monitor();
        const monitor = monitors.find(item => item.index === monitorIndex) ?? null;
        const area = window.get_workspace()?.get_work_area_for_monitor(monitorIndex);
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
            monitor_work_area: area
                ? {x: area.x, y: area.y, width: area.width, height: area.height}
                : null,
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

    _listedWindows(windows) {
        const managed = new Set(windows);
        return new Set(normalWindows().filter(window => managed.has(window)));
    }

    _windows(monitors, windows, listed) {
        const parents = transientParents(windows);
        return [...listed].map(window => {
            const record = this._monitorRecords?.get(window);
            const intent = record?.workspaceRecoveryPending ? captureMonitorIntent(record.anchor) : null;
            return {
                ...this._windowRecord(window, monitors),
                ...(intent ? {monitor_intent: intent} : {}),
                sticky: window.is_on_all_workspaces(),
                close_blocker: closeBlocker(window, parents),
            };
        });
    }

    GetCapabilities() {
        return JSON.stringify({
            interface: BUS_NAME,
            interface_version: 1,
            build: {uuid: this.uuid, version: this.metadata?.version ?? 1, revision: BUILD_REVISION},
            enable_epoch: this._enableEpoch,
            capabilities: CAPABILITIES,
        });
    }

    GetState() {
        const monitors = this._monitors();
        const windows = global.display.list_all_windows();
        const listed = this._listedWindows(windows);
        return JSON.stringify({
            interface: BUS_NAME,
            interface_version: 1,
            build: {uuid: this.uuid, version: this.metadata?.version ?? 1, revision: BUILD_REVISION},
            enable_epoch: this._enableEpoch,
            capabilities: CAPABILITIES,
            dynamic_workspaces: this._mutterSettings.get_boolean('dynamic-workspaces'),
            screen_unavailable: this._screenUnavailable(),
            active_workspace: global.workspace_manager.get_active_workspace().index(),
            monitors,
            workspaces: this._workspaces(windows, listed),
            windows: this._windows(monitors, windows, listed),
            monitor_policy: this._monitorPolicyState(),
        });
    }

    ListWindows() {
        const windows = global.display.list_all_windows();
        return JSON.stringify(this._windows(this._monitors(), windows, this._listedWindows(windows)));
    }

    ListMonitors() {
        return JSON.stringify(this._monitors());
    }

    ListWorkspaces() {
        return JSON.stringify(this._workspaces());
    }

    CloseWindow(identityJson) {
        let identity;
        try {
            identity = parseObject(identityJson, 'identity');
        } catch {
            return closeRefused('invalid_request');
        }
        const {id, workspace: index, pid, epoch, workspace_name: name} = identity;
        if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff ||
            !Number.isSafeInteger(index) || index < 0 || index > 0x7fffffff ||
            !Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff ||
            typeof epoch !== 'string' || !epoch ||
            (name !== undefined && (typeof name !== 'string' || !name)))
            return closeRefused('invalid_request');
        if (epoch !== this._enableEpoch)
            return closeRefused('stale_epoch');
        if (this._screenUnavailable())
            return closeRefused('screen_unavailable');

        const manager = global.workspace_manager;
        const workspace = manager.get_workspace_by_index(index);
        if (!workspace)
            return closeRefused('missing_workspace');
        if (name !== undefined) {
            if (this._mutterSettings.get_boolean('dynamic-workspaces'))
                return closeRefused('dynamic_workspaces');
            const names = this._workspaceSettings.get_strv('workspace-names').slice(0, manager.n_workspaces);
            if (names[index] !== name || names.indexOf(name) !== names.lastIndexOf(name))
                return closeRefused('workspace_name_changed');
        }

        // Resolve all checks and send the close to this Meta.Window in one Shell callback.
        const windows = global.display.list_all_windows();
        const matches = windows.filter(window => window.get_stable_sequence() === id);
        if (!matches.length)
            return JSON.stringify({status: 'absent'});
        if (matches.length !== 1)
            return closeRefused('ambiguous_id');
        const [window] = matches;
        const blocker = closeBlocker(window, transientParents(windows));
        if (blocker)
            return closeRefused(blocker);
        if (window.get_workspace() !== workspace)
            return closeRefused('workspace_changed');
        if (window.get_pid() !== pid)
            return closeRefused('pid_changed');
        if (name !== undefined && workspaceBlockers(workspace, windows, this._listedWindows(windows)))
            return closeRefused('workspace_blocked');
        window.delete(global.get_current_time());
        return JSON.stringify({status: 'requested'});
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
        return monitorForAnchor({
            edid_checksum: String(identity.edid_checksum ?? ''),
            serial: String(identity.serial ?? ''),
            connector: String(identity.connector ?? ''),
            vendor: String(identity.vendor ?? ''),
            product: String(identity.product ?? ''),
            fallback: null,
        }, monitors) ?? primary;
    }

    _resolvedTarget(target) {
        const monitors = this._monitors();
        if (!monitors.length)
            throw new Error('GNOME reports no active monitors');
        const workspaceIndex = this._resolveWorkspace(target.workspace);
        // Numeric indices and a client's prior resolution can become stale
        // between its state query and this call (or a window reservation).
        const requestedIntent = captureMonitorIntent(target.monitor_intent);
        const intentMonitor = requestedIntent ? monitorForAnchor(requestedIntent, monitors) : null;
        const monitor = intentMonitor ?? this._resolveMonitor(target.monitor, monitors);
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
        const verificationArea = state === 'maximized'
            ? global.workspace_manager.get_workspace_by_index(workspaceIndex).get_work_area_for_monitor(monitor.index)
            : state === 'fullscreen' ? monitor : null;
        const liveAnchor = captureMonitorAnchor(monitor);
        const intendedAnchor = requestedIntent
            ? intentMonitor && anchorHasPhysicalIdentity(liveAnchor)
                ? liveAnchor
                : requestedIntent
            : liveAnchor;
        return {
            workspace: workspaceIndex,
            monitor: monitor.index,
            monitor_intent: intendedAnchor,
            monitor_intent_resolved: !requestedIntent || Boolean(intentMonitor),
            geometry: {x, y, width, height},
            ...(verificationArea ? {verification_geometry: {
                x: verificationArea.x, y: verificationArea.y,
                width: verificationArea.width, height: verificationArea.height,
            }} : {}),
            state,
        };
    }

    _requestResult(token) {
        const {deadline, updated_at, ...result} = this._requests.get(token);
        return result;
    }

    _sameResolvedPlacement(left, right) {
        return left.monitor_intent_resolved && right.monitor_intent_resolved &&
            ['workspace', 'monitor', 'state'].every(key => left[key] === right[key]) &&
            ['geometry', 'verification_geometry'].every(field =>
                ['x', 'y', 'width', 'height'].every(key => left[field]?.[key] === right[field]?.[key]));
    }

    _handoffInFlight(exceptToken = null) {
        return [...this._requests.records.values()].some(request => request.token !== exceptToken &&
            request.status === 'applied' && request.target.stage_before_handoff);
    }

    _awaitInitialFrame(window, record) {
        if (record?.initialFramePending)
            return true;
        const frame = this._windowRecord(window).geometry;
        if (Number.isFinite(frame?.width) && frame.width > 0 &&
            Number.isFinite(frame?.height) && frame.height > 0)
            return false;
        if (!record)
            throw new Error('cannot retain placement before the initial window frame');
        record.initialFramePending = true;
        record.initialFrameSignal = window.connect('size-changed', () => {
            const current = this._windowRecord(window).geometry;
            if (!(current.width > 0 && current.height > 0) || record.initialFrameSource)
                return;
            // Let Mutter finish the initial configure/placement event before
            // moving the new window. A 0x0 surface has no frame to configure;
            // its first default placement would overwrite an earlier request.
            record.initialFrameSource = this._timeout(GLib.PRIORITY_DEFAULT, 0, () => {
                record.initialFrameSource = 0;
                if (this._monitorRecords.get(window) !== record)
                    return GLib.SOURCE_REMOVE;
                const ready = this._windowRecord(window).geometry;
                if (!(ready.width > 0 && ready.height > 0))
                    return GLib.SOURCE_REMOVE;
                record.initialFramePending = false;
                window.disconnect(record.initialFrameSignal);
                record.initialFrameSignal = 0;
                this._applyDeferredPlacement(window, record, 'initial-frame-ready');
                return GLib.SOURCE_REMOVE;
            });
        });
        return true;
    }

    _resumeStagedHandoff() {
        if (this._screenUnavailable() || this._handoffInFlight())
            return;
        for (const [window, record] of this._monitorRecords) {
            if (record.deferredPlacement?.target.stage_before_handoff &&
                !record.grabActive && !record.overviewDrag &&
                this._applyDeferredPlacement(window, record, 'previous-handoff-settled'))
                break;
        }
    }

    _verifyPlacement(window, token, resolved, settleNormal = false, handoff = null) {
        const epoch = this._enableEpoch;
        const began = GLib.get_monotonic_time();
        const deadline = began + VERIFY_BUDGET_US;
        let attempts = 0;
        let normalFrame = null;
        let normalSince = null;
        let positionCorrected = false;
        const source = this._timeout(GLib.PRIORITY_DEFAULT, VERIFY_POLL_MS, () => {
            const request = this._requests.get(token);
            if (request.status !== 'applied') {
                this._retrySources.delete(source);
                this._resumeStagedHandoff();
                return GLib.SOURCE_REMOVE;
            }
            try {
                // A staged request owns its final destination, including when
                // the screen locks between its configure and workspace handoff.
                // Retain that request without changing anything behind the lock.
                if (request.target.stage_before_handoff && this._screenUnavailable()) {
                    const record = this._monitorRecords.get(window);
                    if (record?.requestToken !== token)
                        throw new Error('staged placement lost its current ownership');
                    record.deferredPlacement = {token, target: request.target};
                    this._requests.update(token, 'deferred', {deferred: true});
                    this._retrySources.delete(source);
                    return GLib.SOURCE_REMOVE;
                }
                const record = this._monitorRecords.get(window);
                if (handoff) {
                    if (record?.requestToken !== token || record.grabActive || record.overviewDrag)
                        throw new Error('staged placement lost its current ownership');
                    if (!windowIsOnActiveWorkspace(window, global.workspace_manager)) {
                        // Application identification or the user can switch
                        // workspaces during a configure. Retain the final intent
                        // and rejoin the native queue on the newly active one.
                        record.deferredPlacement = {token, target: request.target};
                        this._requests.update(token, 'deferred', {deferred: true});
                        this._retrySources.delete(source);
                        this._resumeStagedHandoff();
                        return GLib.SOURCE_REMOVE;
                    }
                }
                if (GLib.get_monotonic_time() >= deadline)
                    throw new Error('placement verification deadline elapsed');
                const current = this._windowRecord(window);
                // A topology change between apply and verification cannot
                // turn an old numeric index into proof of the intended display.
                const fresh = this._resolvedTarget(handoff
                    ? {...request.target, workspace: resolved.workspace, state: resolved.state}
                    : request.target);
                const sameTarget = this._sameResolvedPlacement(fresh, resolved);
                if (settleNormal) {
                    if (!sameTarget || this._enableEpoch !== epoch || this._screenUnavailable() ||
                        !windowIsOnActiveWorkspace(window, global.workspace_manager) ||
                        this._monitorRecords.get(window)?.requestToken !== token)
                        throw new Error('maximize preparation lost its current placement ownership');
                    const frame = current.geometry;
                    const normal = current.state === 'normal' && current.workspace === resolved.workspace &&
                        current.monitor === resolved.monitor &&
                        ['x', 'y', 'width', 'height'].every(key => Number.isFinite(frame?.[key])) &&
                        frame.width > 0 && frame.height > 0;
                    if (!normal) {
                        normalFrame = null;
                        normalSince = null;
                    } else if (!normalFrame || ['x', 'y', 'width', 'height'].some(key => normalFrame[key] !== frame[key])) {
                        normalFrame = {...frame};
                        normalSince = GLib.get_monotonic_time();
                    } else if (GLib.get_monotonic_time() - normalSince >= 400000) {
                        // Normal windows may have size increments or limits.
                        // Observe their settled frame; only the final maximized
                        // frame must equal the current compositor work area.
                        window.maximize(Meta.MaximizeFlags.BOTH);
                        settleNormal = false;
                    }
                }
                if (handoff && resolved.state === 'normal') {
                    if (!sameTarget || this._enableEpoch !== epoch)
                        throw new Error('normal preparation lost its current placement ownership');
                    const frame = current.geometry;
                    const sizeAcknowledged = current.state === 'normal' &&
                        current.workspace === resolved.workspace && current.monitor === resolved.monitor &&
                        ['width', 'height'].every(key => Number.isFinite(frame?.[key]) &&
                            Math.abs(frame[key] - resolved.geometry[key]) <= 3);
                    const positionAcknowledged = ['x', 'y'].every(key => Number.isFinite(frame?.[key]) &&
                        Math.abs(frame[key] - resolved.geometry[key]) <= 3);
                    if (sizeAcknowledged && !positionAcknowledged && !positionCorrected) {
                        // The client can acknowledge the new size with a late
                        // initial/CSD position. Correct only position once;
                        // issuing another resize would restart that handshake.
                        window.move_frame(true, resolved.geometry.x, resolved.geometry.y);
                        positionCorrected = true;
                        normalFrame = null;
                        normalSince = null;
                        return GLib.SOURCE_CONTINUE;
                    }
                    if (!placementVerified(current, fresh)) {
                        normalFrame = null;
                        normalSince = null;
                    } else if (!normalFrame || ['x', 'y', 'width', 'height'].some(key => normalFrame[key] !== frame[key])) {
                        normalFrame = {...frame};
                        normalSince = GLib.get_monotonic_time();
                        return GLib.SOURCE_CONTINUE;
                    } else if (GLib.get_monotonic_time() - normalSince < 400000) {
                        return GLib.SOURCE_CONTINUE;
                    }
                }
                if (sameTarget && placementVerified(current, fresh)) {
                    if (handoff) {
                        // Minimize while mapped, then hand off the already
                        // acknowledged frame. Never activate a workspace.
                        if (handoff.state === 'minimized' && resolved.state !== 'minimized') {
                            const minimized = {...resolved, state: 'minimized'};
                            window.minimize();
                            this._verifyPlacement(window, token, minimized, false, handoff);
                        } else {
                            this._applyPlacement(window, handoff, token, false);
                        }
                        this._retrySources.delete(source);
                        return GLib.SOURCE_REMOVE;
                    }
                    this._requests.update(token, 'verified', {window: current, deferred: false});
                } else if (++attempts < VERIFY_MAX_ATTEMPTS && this._enableEpoch === epoch) {
                    return GLib.SOURCE_CONTINUE;
                } else {
                    throw new Error('placement did not verify against the current desktop');
                }
            } catch (error) {
                // Keep the failure-time observation, not the initial apply
                // snapshot, so a late native configure can be diagnosed.
                const now = GLib.get_monotonic_time();
                this._requests.update(token, 'failed', {
                    message: error.message,
                    window: this._windowRecord(window),
                    verification: {
                        elapsed_us: now - began, attempts,
                        staging_target: resolved, final_target: handoff,
                        normal_frame: normalFrame,
                        stable_us: normalSince === null ? 0 : now - normalSince,
                        position_corrected: positionCorrected,
                        active_workspace: global.workspace_manager.get_active_workspace().index(),
                    },
                });
            }
            this._retrySources.delete(source);
            this._resumeStagedHandoff();
            return GLib.SOURCE_REMOVE;
        });
        this._retrySources.add(source);
    }

    _applyPlacement(window, target, token = null, allowStaging = true) {
        const directRequest = token === null;
        if (token === null) {
            token = GLib.uuid_string_random();
            this._requests.create(token, target, null);
        }
        try {
            const request = this._requests.get(token);
            if (request.status === 'unknown' || TERMINAL_PLACEMENT_STATES.has(request.status))
                return this._requestResult(token);
            this._requests.update(token, request.status, {deadline: null});
            const resolved = this._resolvedTarget(target);
            if (!resolved.monitor_intent_resolved)
                throw new Error('requested physical monitor is unavailable or ambiguous');
            const workspace = global.workspace_manager.get_workspace_by_index(resolved.workspace);
            const screenUnavailable = this._screenUnavailable();
            const stagedHandoff = target.stage_before_handoff === true;
            if (screenUnavailable && window.get_workspace() !== workspace && !stagedHandoff)
                throw new Error('screen is locked and the window is on another workspace');
            // Freeze the physical intent and monitor-relative rectangle, not
            // the temporary monitor index or absolute desktop coordinates.
            const monitor = this._monitors().find(item => item.index === resolved.monitor);
            const intent = {...target, monitor_intent: resolved.monitor_intent,
                coordinate_space: 'monitor', geometry: {...resolved.geometry,
                    x: resolved.geometry.x - monitor.x, y: resolved.geometry.y - monitor.y}};
            const previous = this._monitorRecords.get(window)?.requestToken;
            if (directRequest && previous && previous !== token) {
                const owned = this._requests.get(previous);
                if ((owned.status === 'deferred' ||
                    owned.status === 'applied' && GLib.get_monotonic_time() - owned.updated_at < VERIFY_BUDGET_US) &&
                    (!stagedHandoff || owned.handoff_owned === true) &&
                    owned.resolved_target && this._sameResolvedPlacement(owned.resolved_target, resolved) &&
                    this._sameResolvedPlacement(this._resolvedTarget(owned.target), resolved)) {
                    this._requests.update(token, 'cancelled', {message: 'identical in-flight placement reused'});
                    return this._requestResult(previous);
                }
            }
            if (previous && previous !== token)
                this._requests.update(previous, 'cancelled', {message: 'superseded by a newer explicit placement'});
            const record = this._beginExplicitPlacement(window, resolved.monitor_intent);
            const waitingForFrame = record?.initialFramePending === true;
            let deferred = false;
            let settleNormal = false;
            let appliedTarget = resolved;
            let handoff = null;
            try {
                if (record)
                    record.requestToken = token;
                const finalAlreadyPlaced = placementVerified(this._windowRecord(window), resolved);
                const queued = stagedHandoff && allowStaging && this._handoffInFlight(token);
                if (stagedHandoff && allowStaging && !screenUnavailable && !queued && !waitingForFrame && !finalAlreadyPlaced) {
                    const active = global.workspace_manager.get_active_workspace();
                    appliedTarget = this._resolvedTarget({...intent, workspace: active.index(),
                        state: resolved.state === 'minimized' ? 'normal' : resolved.state});
                    handoff = intent;
                }
                const appliedWorkspace = global.workspace_manager.get_workspace_by_index(appliedTarget.workspace);
                // A direct request can assign its workspace before the first
                // frame. A staged handoff leaves the window where it can map.
                if (!screenUnavailable && !queued && (!stagedHandoff || !waitingForFrame) &&
                    window.get_workspace() !== appliedWorkspace)
                    window.change_workspace(appliedWorkspace);
                const alreadyPlaced = placementVerified(this._windowRecord(window), appliedTarget);
                deferred = screenUnavailable || queued || waitingForFrame || (
                    placementNeedsActiveWorkspace(window, global.workspace_manager, appliedWorkspace) && !alreadyPlaced);
                if (deferred) {
                    if (!record)
                        throw new Error('cannot defer placement for an untracked window');
                    record.deferredPlacement = {token, target: intent};
                } else if (!alreadyPlaced) {
                    settleNormal = this._applyResolvedPlacement(window, appliedTarget) === true;
                }
            } finally {
                if (!waitingForFrame)
                    this._endExplicitPlacement(window, record);
            }
            this._requests.update(token, deferred ? 'deferred' : 'applied', {
                deferred, target: intent, resolved_target: resolved, window: this._windowRecord(window),
                ...(stagedHandoff ? {handoff_owned: true} : {}),
            });
            if (!deferred)
                this._verifyPlacement(window, token, appliedTarget, settleNormal, handoff);
        } catch (error) {
            this._requests.update(token, 'failed', {message: error.message});
            const record = this._monitorRecords.get(window);
            if (record?.requestToken === token)
                record.deferredPlacement = null;
        }
        return this._requestResult(token);
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
        this._requests.expire();
        this._expectations = this._expectations.filter(
            expectation => this._requests.get(expectation.token).status === 'accepted');
    }

    _windowCreated(window) {
        const sequence = ++this._windowSequence;
        let availableAttempts = 0;
        const source = this._timeout(GLib.PRIORITY_DEFAULT, 50, () => {
            this._expireExpectations();
            this._trackWindow(window, true);
            if (!this._expectations.length) {
                this._retrySources.delete(source);
                return GLib.SOURCE_REMOVE;
            }
            if (this._screenUnavailable())
                return GLib.SOURCE_CONTINUE;
            availableAttempts += 1;
            if (window.get_window_type() !== Meta.WindowType.NORMAL) {
                if (availableAttempts < 120)
                    return GLib.SOURCE_CONTINUE;
                this._retrySources.delete(source);
                return GLib.SOURCE_REMOVE;
            }
            const index = this._expectations.findIndex(expectation => sequence >= expectation.minSequence && this._matches(window, expectation.selector));
            if (index < 0 && availableAttempts < 120)
                return GLib.SOURCE_CONTINUE;
            if (index < 0) {
                this._retrySources.delete(source);
                return GLib.SOURCE_REMOVE;
            }
            const [expectation] = this._expectations.splice(index, 1);
            this._applyPlacement(window, expectation.target, expectation.token);
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
        this._requests.create(token, target, GLib.get_monotonic_time() + lifetime);
        this._expectations.push({
            token,
            selector,
            target,
            minSequence: this._windowSequence + 1,
        });
        return token;
    }

    ExpectationStatus(token) {
        this._expireExpectations();
        return JSON.stringify(this._requestResult(token));
    }

    CancelExpectation(token) {
        this._expireExpectations();
        const request = this._requests.get(token);
        if (request.status === 'unknown' || TERMINAL_PLACEMENT_STATES.has(request.status))
            return false;
        this._expectations = this._expectations.filter(item => item.token !== token);
        return this._requests.update(token, 'cancelled', {message: 'request cancelled'});
    }
}
