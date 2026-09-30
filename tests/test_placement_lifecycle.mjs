import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import * as monitorPolicy from '../extension/gnome-winctl-v3@sagecat.local/monitorPolicy.js';
import * as windowPlacement from '../extension/gnome-winctl-v3@sagecat.local/windowPlacement.js';
import * as requests from '../extension/gnome-winctl-v3@sagecat.local/placementRequests.js';

function fixture({Gio = {}, Main = {}, Meta = {}, display = {}} = {}) {
    let clock = 0;
    const timers = new Map();
    let next = 0;
    const workspaces = [0, 1].map(index => ({index: () => index,
        get_work_area_for_monitor: monitor => ({x: monitor * 1000, y: 30, width: 1000, height: 970})}));
    let active = workspaces[0];
    const manager = {n_workspaces: 2, get_workspace_by_index: index => workspaces[index], get_active_workspace: () => active};
    const GLib = {
        get_monotonic_time: () => clock, uuid_string_random: () => `token-${++next}`,
        timeout_add: (_priority, _ms, callback) => { const id = ++next; timers.set(id, callback); return id; },
        source_remove: id => timers.delete(id), SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
    };
    const source = readFileSync(new URL('../extension/gnome-winctl-v3@sagecat.local/extension.js', import.meta.url), 'utf8');
    const ExtensionClass = runInNewContext(source.replace(/^import[\s\S]*?;\n/gm, '').replace('export default class', 'class') + '\nGnomeWinCtlExtension;', {
        ...monitorPolicy, ...windowPlacement, ...requests, BUILD_REVISION: 'test-revision',
        Extension: class {}, GLib, Gio, Main, console, Meta: {GrabOp: {}, DisplayDirection: {}, WindowType: {NORMAL: 0}, ...Meta},
        global: {display, workspace_manager: manager, get_window_actors: () => []},
    });
    const extension = Object.create(ExtensionClass.prototype);
    extension._enableEpoch = 'epoch-one';
    extension._requests = new requests.PlacementRequests(GLib.get_monotonic_time);
    extension._expectations = [];
    extension._retrySources = new Set();
    extension._windowSequence = 0;
    extension._monitorRecords = new Map();
    extension._screenUnavailable = () => false;
    extension._trackWindow = () => true;
    extension._workspaceSettings = {get_strv: () => ['One', 'Two']};
    let monitors = [{index: 0, primary: true, x: 0, y: 0, width: 1000, height: 1000, serial: 'A'},
        {index: 1, x: 1000, y: 0, width: 1000, height: 1000, serial: 'B'}];
    extension._monitors = () => monitors;
    const window = {
        workspace: workspaces[0], monitor: 0, geometry: {x: 0, y: 0, width: 100, height: 100}, state: 'normal',
        get_workspace() { return this.workspace; }, change_workspace(value) { this.workspace = value; },
        get_stable_sequence: () => 42, get_window_type: () => 0,
    };
    extension._windowRecord = value => ({workspace: value.workspace.index(), monitor: value.monitor, geometry: value.geometry, state: value.state});
    extension._beginExplicitPlacement = value => {
        let record = extension._monitorRecords.get(value);
        if (!record) { record = {}; extension._monitorRecords.set(value, record); }
        record.deferredPlacement = null;
        return record;
    };
    extension._endExplicitPlacement = () => {};
    extension._applyResolvedPlacement = (value, target) => { value.monitor = target.monitor; value.geometry = target.geometry; value.state = target.state; };
    function tick() {
        for (const [id, callback] of [...timers]) {
            if (callback() === false) timers.delete(id);
        }
    }
    return {extension, window, timers, tick, manager,
        activate: index => { active = workspaces[index]; },
        setMonitors: value => { monitors = value; },
        advance: amount => { clock += amount; }};
}

const target = {workspace: 1, monitor: 1, geometry: {x: 20, y: 30, width: 200, height: 100}, clamp: false};

function coveredClient() {
    const focus = {id: 'other-application'};
    const display = {focus_window: focus};
    const f = fixture({display, Meta: {MaximizeFlags: {BOTH: 3}}});
    let exposed = false;
    let raises = 0;
    Object.assign(f.window, {
        unminimize() {}, is_fullscreen: () => false, unmaximize() {},
        get_frame_rect() { return {...this.geometry}; },
        move_to_monitor(monitor) { this.monitor = monitor; },
        raise() { exposed = true; raises++; },
        activate() { assert.fail('placement must not activate the client'); },
        move_resize_frame(_userOp, x, y, width, height) {
            // Reproduce a covered Wayland client withholding its new buffer.
            this.geometry = {...this.geometry, x, y};
            if (exposed)
                Object.assign(this.geometry, {width, height});
        },
    });
    f.extension._applyResolvedPlacement = Object.getPrototypeOf(f.extension)._applyResolvedPlacement;
    return {...f, display, focus, raises: () => raises};
}

test('covered client finishes an explicit resize and inactive handoff without taking focus', () => {
    const f = coveredClient();
    const staged = f.extension._applyPlacement(f.window, {...target, workspace: 0});
    f.tick();
    assert.equal(JSON.parse(f.extension.ExpectationStatus(staged.token)).status, 'verified');
    assert.equal(f.raises(), 1);
    const final = f.extension._applyPlacement(f.window, target);
    f.tick();
    assert.equal(JSON.parse(f.extension.ExpectationStatus(final.token)).status, 'verified');
    assert.equal(f.raises(), 1, 'settled handoff must not restack the window again');
    assert.equal(f.display.focus_window, f.focus);
    assert.equal(f.manager.get_active_workspace().index(), 0);
});

test('position-only and already verified placement preserve stacking', () => {
    const f = coveredClient();
    const sameSize = {...target, workspace: 0, geometry: {...target.geometry, width: 100}};
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = f.extension._applyPlacement(f.window, sameSize);
        f.tick();
        assert.equal(JSON.parse(f.extension.ExpectationStatus(result.token)).status, 'verified');
    }
    assert.equal(f.raises(), 0);
    assert.equal(f.display.focus_window, f.focus);
});

test('inactive or locked placement cannot expose a covered client', () => {
    for (const locked of [false, true]) {
        const f = coveredClient();
        f.extension._screenUnavailable = () => locked;
        const result = f.extension._applyPlacement(f.window, {...target, workspace: locked ? 0 : 1});
        assert.equal(result.status, 'deferred');
        assert.equal(f.raises(), 0);
        assert.equal(f.display.focus_window, f.focus);
    }
});

test('deferred placement remains owned, resolves reordered physical monitor, and verifies after replay', () => {
    const f = fixture();
    const result = f.extension._applyPlacement(f.window, target);
    assert.equal(result.status, 'deferred');
    assert.equal(result.placed, false);
    assert.ok(result.token);
    f.setMonitors([{index: 0, primary: true, x: 0, y: 0, width: 1000, height: 1000, serial: 'B'},
        {index: 1, x: 1000, y: 0, width: 1000, height: 1000, serial: 'A'}]);
    f.activate(1);
    f.extension._applyDeferredPlacement(f.window, f.extension._monitorRecords.get(f.window), 'test');
    f.tick();
    const status = JSON.parse(f.extension.ExpectationStatus(result.token));
    assert.equal(status.status, 'verified');
    assert.equal(status.window.monitor, 0);
    assert.equal(status.window.geometry.x, 20);
});

test('deferred replay failure reaches original token and is not retried as success', () => {
    const f = fixture();
    const result = f.extension._applyPlacement(f.window, target);
    f.activate(1);
    f.extension._applyResolvedPlacement = () => { throw Error('compositor rejected geometry'); };
    f.extension._applyDeferredPlacement(f.window, f.extension._monitorRecords.get(f.window), 'test');
    const status = JSON.parse(f.extension.ExpectationStatus(result.token));
    assert.equal(status.status, 'failed');
    assert.match(status.message, /rejected/);
    assert.equal(f.extension._monitorRecords.get(f.window).deferredPlacement, null);
});

test('cancelled requests never replay, even when cancellation is repeated', () => {
    for (const repeat of [true, false]) {
        const f = fixture();
        const result = f.extension._applyPlacement(f.window, target);
        assert.equal(f.extension.CancelExpectation(result.token), true);
        if (repeat) assert.equal(f.extension.CancelExpectation(result.token), false);
        f.activate(1);
        let applied = false;
        f.extension._applyResolvedPlacement = () => { applied = true; };
        f.extension._applyDeferredPlacement(f.window, f.extension._monitorRecords.get(f.window), 'test');
        assert.equal(applied, false);
    }
});

test('deferred intent survives the caller wait deadline but missing monitor fails closed', () => {
    const f = fixture();
    const result = f.extension._applyPlacement(f.window, target);
    f.advance(600000000);
    assert.equal(JSON.parse(f.extension.ExpectationStatus(result.token)).status, 'deferred');
    f.setMonitors([{index: 0, primary: true, x: 0, y: 0, width: 1000, height: 1000, serial: 'A'}]);
    f.activate(1);
    f.extension._applyDeferredPlacement(f.window, f.extension._monitorRecords.get(f.window), 'test');
    assert.equal(JSON.parse(f.extension.ExpectationStatus(result.token)).status, 'failed');
    assert.equal(f.window.monitor, 0);
    assert.equal(f.window.geometry.width, 100);
});

test('unmatched reservations expire without consuming a later new window', () => {
    const f = fixture();
    const token = f.extension.ExpectWindow('{"app_id":"app"}', JSON.stringify(target), 1000);
    f.advance(2000000);
    assert.equal(JSON.parse(f.extension.ExpectationStatus(token)).status, 'expired');
    assert.equal(f.extension._expectations.length, 0);
});

test('older window retry cannot consume a newly created expectation', () => {
    const f = fixture();
    f.extension._matches = () => true;
    f.extension._windowCreated(f.window);
    const token = f.extension.ExpectWindow('{"app_id":"app"}', JSON.stringify(target), 20000);
    f.tick();
    assert.equal(JSON.parse(f.extension.ExpectationStatus(token)).status, 'accepted');
});

test('terminal request history is count and age bounded; active requests remain owned', () => {
    let now = 0;
    const ledger = new requests.PlacementRequests(() => now, {maxTerminal: 2, terminalAge: 10});
    ledger.create('active', {}, 100);
    for (const id of ['one', 'two', 'three']) { ledger.create(id, {}, 100); ledger.update(id, 'failed'); now++; }
    assert.equal(ledger.get('one').status, 'unknown');
    assert.equal(ledger.get('active').status, 'accepted');
    now = 20;
    assert.equal(ledger.get('three').status, 'unknown');
    assert.equal(ledger.get('active').status, 'accepted');
});

test('a delayed timer cannot run in a newer enable epoch', () => {
    const f = fixture();
    let runs = 0;
    f.extension._timeout(0, 10, () => { runs++; return false; });
    f.extension._enableEpoch = 'epoch-two';
    f.tick();
    assert.equal(runs, 0);
});

test('old DisplayConfig reply cannot change new epoch cache or pending counters', () => {
    let callback;
    const f = fixture({Gio: {DBusCallFlags: {NONE: 0}, DBus: {session: {call: (...args) => { callback = args.at(-1); }}}}});
    const extension = f.extension;
    extension._displayConfigCancellable = {};
    extension._displayConfigGeneration = 0;
    extension._displayConfigPending = 0;
    extension._refreshDisplayConfig('test');
    extension._enableEpoch = 'epoch-two';
    extension._displayConfigCancellable = {};
    extension._displayConfigGeneration = 1; // Same numeric generation in a new enable.
    extension._displayConfigPending = 7;
    extension._displayConfigCacheValid = true;
    callback({call_finish: () => ({deepUnpack: () => []})}, {});
    assert.equal(extension._displayConfigPending, 7);
    assert.equal(extension._displayConfigCacheValid, true);
});

test('partial enable failure unwinds acquired signals, cancellable and exported object', () => {
    let next = 0;
    const acquired = new Set();
    const signals = {connect: () => { const id = ++next; acquired.add(id); return id; }, disconnect: id => acquired.delete(id)};
    let cancelled = false;
    let unexported = false;
    const f = fixture({
        Gio: {
            Cancellable: class { cancel() { cancelled = true; } },
            Settings: class {},
            DBus: {session: {}},
            DBusExportedObject: {wrapJSObject: () => ({export() { throw Error('export conflict'); }, unexport() { unexported = true; }})},
        },
        Main: {layoutManager: signals, overview: signals}, display: signals,
    });
    Object.assign(f.manager, signals);
    f.extension._subscribeDisplayConfig = () => {};
    f.extension._refreshDisplayConfig = () => {};
    assert.throws(() => f.extension.enable(), /export conflict/);
    assert.equal(acquired.size, 0);
    assert.equal(cancelled, true);
    assert.equal(unexported, true);
    assert.equal(f.extension._enableEpoch, null);
});

test('missing keybinding ownership API preserves native handlers', () => {
    let called = false;
    const f = fixture({Meta: {keybindings_set_custom_handler: () => { called = true; }}});
    f.extension._installMonitorMoveBindings();
    assert.equal(called, false);
    assert.match(f.extension._monitorBindingCompatibility, /native bindings retained/);
});

test('handler restoration preserves an owner installed after this extension', () => {
    const previous = () => {};
    let current = previous;
    const f = fixture({Meta: {
        keybindings_get_custom_handler: () => current,
        keybindings_set_custom_handler: (_name, handler) => { current = handler; return true; },
    }});
    f.extension._monitorMoveBindings = [{name: 'test', handler: current, previous}];
    const later = () => {};
    current = later;
    f.extension._restoreMonitorMoveBindings();
    assert.equal(current, later);
});

test('runtime capabilities identify exact loaded build and enable epoch', () => {
    const f = fixture();
    f.extension.uuid = 'test-uuid';
    f.extension.metadata = {version: 3};
    const result = JSON.parse(f.extension.GetCapabilities());
    assert.equal(result.build.revision, 'test-revision');
    assert.equal(result.enable_epoch, 'epoch-one');
    assert.ok(result.capabilities.includes('placement_lifecycle_v2'));
});

test('a matching new window retains its original reservation token through deferred replay', () => {
    const f = fixture();
    f.extension._matches = () => true;
    const token = f.extension.ExpectWindow('{"app_id":"app"}', JSON.stringify(target), 20000);
    f.extension._windowCreated(f.window);
    f.tick();
    assert.equal(JSON.parse(f.extension.ExpectationStatus(token)).status, 'deferred');
    f.activate(1);
    f.extension._applyDeferredPlacement(f.window, f.extension._monitorRecords.get(f.window), 'test');
    f.tick();
    assert.equal(JSON.parse(f.extension.ExpectationStatus(token)).status, 'verified');
});

test('a compositor that accepts calls without applying geometry never produces verified success', () => {
    const f = fixture();
    f.extension._applyResolvedPlacement = () => {};
    const result = f.extension._applyPlacement(f.window, {...target, workspace: 0});
    assert.equal(result.status, 'applied');
    assert.equal(result.placed, false);
    for (let attempt = 0; attempt < 20; attempt++) f.tick();
    assert.equal(JSON.parse(f.extension.ExpectationStatus(result.token)).status, 'failed');
});

test('maximized and fullscreen verification uses current area rather than obsolete normal geometry', () => {
    for (const state of ['maximized', 'fullscreen']) {
        const area = {x: 0, y: 0, width: 900, height: 900};
        const target = {workspace: 1, monitor: 0, state,
            geometry: {x: 20, y: 30, width: 100, height: 100}, verification_geometry: area};
        assert.equal(requests.placementVerified(
            {workspace: 1, monitor: 0, state, geometry: area}, target), true);
        assert.equal(requests.placementVerified(
            {workspace: 1, monitor: 0, state, geometry: {...area, width: 3840, height: 2030}}, target), false);
    }
});

test('a settled off-workspace handoff verifies without another compositor resize or activation', () => {
    const f = fixture();
    f.window.monitor = 1;
    f.window.state = 'maximized';
    f.window.geometry = {x: 1000, y: 30, width: 1000, height: 970};
    let resized = false;
    f.extension._applyResolvedPlacement = () => { resized = true; };
    const result = f.extension._applyPlacement(f.window, {...target, state: 'maximized'});
    assert.equal(result.status, 'applied');
    assert.equal(result.deferred, false);
    assert.equal(resized, false);
    assert.equal(f.extension._monitorRecords.get(f.window).deferredPlacement, null);
    f.tick();
    assert.equal(JSON.parse(f.extension.ExpectationStatus(result.token)).status, 'verified');
    assert.equal(f.manager.get_active_workspace().index(), 0);
});

test('an inactive maximized window with its previous monitor size stays deferred', () => {
    const f = fixture();
    f.window.monitor = 1;
    f.window.state = 'maximized';
    f.window.geometry = {x: 1000, y: 30, width: 2000, height: 1970};
    const result = f.extension._applyPlacement(f.window, {...target, state: 'maximized'});
    assert.equal(result.status, 'deferred');
    assert.equal(result.placed, false);
    assert.equal(f.manager.get_active_workspace().index(), 0);
});

test('work area and fullscreen frame are resolved independently from saved normal geometry', () => {
    const f = fixture();
    const maximized = f.extension._resolvedTarget({...target, state: 'maximized'});
    const fullscreen = f.extension._resolvedTarget({...target, state: 'fullscreen'});
    assert.equal(JSON.stringify(maximized.verification_geometry), JSON.stringify({x: 1000, y: 30, width: 1000, height: 970}));
    assert.equal(JSON.stringify(fullscreen.verification_geometry), JSON.stringify({x: 1000, y: 0, width: 1000, height: 1000}));
    assert.equal(maximized.geometry.width, 200);
});
