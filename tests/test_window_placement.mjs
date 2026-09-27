import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import * as monitorPolicy from '../extension/gnome-winctl-v3@sagecat.local/monitorPolicy.js';

import {
    deferredPlacementCanApply,
    pendingWorkspaceRecoveryAfterGlobalFinish,
    placementNeedsActiveWorkspace,
    protectMonitorAnchorDuringWorkspaceRecovery,
    windowIsOnActiveWorkspace,
    workspaceRecoveryStartsPending,
} from '../extension/gnome-winctl-v3@sagecat.local/windowPlacement.js';

function fakeWindow(workspace, {sticky = false} = {}) {
    return {
        get_workspace: () => workspace,
        is_on_all_workspaces: () => sticky,
    };
}

test('only windows on the active workspace are directly movable', () => {
    const active = {index: 1};
    const inactive = {index: 2};
    const manager = {get_active_workspace: () => active};

    assert.equal(windowIsOnActiveWorkspace(fakeWindow(active), manager), true);
    assert.equal(windowIsOnActiveWorkspace(fakeWindow(inactive), manager), false);
});

test('sticky windows are directly movable from every workspace', () => {
    const active = {index: 1};
    const manager = {get_active_workspace: () => active};

    assert.equal(
        windowIsOnActiveWorkspace(fakeWindow({index: 2}, {sticky: true}), manager),
        true,
    );
});

test('placement is deferred until its destination workspace is active', () => {
    const active = {index: 1};
    const inactive = {index: 2};
    const manager = {get_active_workspace: () => active};
    const window = fakeWindow(active);

    assert.equal(placementNeedsActiveWorkspace(window, manager, active), false);
    assert.equal(placementNeedsActiveWorkspace(window, manager, inactive), true);
});

test('sticky placement never needs a workspace activation', () => {
    const active = {index: 1};
    const manager = {get_active_workspace: () => active};
    const window = fakeWindow(active, {sticky: true});

    assert.equal(
        placementNeedsActiveWorkspace(window, manager, {index: 2}),
        false,
    );
});

test('pending inactive windows keep their monitor anchor until activation', () => {
    assert.equal(
        protectMonitorAnchorDuringWorkspaceRecovery(true, false),
        true,
    );
});

test('only pending recovery or deferred placement protects a monitor anchor', () => {
    assert.equal(
        protectMonitorAnchorDuringWorkspaceRecovery(false, true),
        true,
    );
    assert.equal(
        protectMonitorAnchorDuringWorkspaceRecovery(false, false),
        false,
    );
});

test('a deferred new window applies when settling finishes on the active workspace', () => {
    const active = {index: 1};
    const inactive = {index: 2};
    const manager = {get_active_workspace: () => active};

    assert.equal(
        deferredPlacementCanApply(fakeWindow(active), manager, false, {monitor: 1}),
        true,
    );
    assert.equal(
        deferredPlacementCanApply(fakeWindow(inactive), manager, false, {monitor: 1}),
        false,
    );
    assert.equal(
        deferredPlacementCanApply(fakeWindow(active), manager, true, {monitor: 1}),
        false,
    );
});

test('recovery start immediately marks inactive windows pending', () => {
    const active = {index: 1};
    const inactive = {index: 2};
    const manager = {get_active_workspace: () => active};

    assert.equal(workspaceRecoveryStartsPending(fakeWindow(inactive), manager), true);
    assert.equal(workspaceRecoveryStartsPending(fakeWindow(active), manager), false);
});

test('global recovery leaves activation-owned pending state intact', () => {
    assert.equal(pendingWorkspaceRecoveryAfterGlobalFinish(true, true), true);
    assert.equal(pendingWorkspaceRecoveryAfterGlobalFinish(true, false), false);
    assert.equal(pendingWorkspaceRecoveryAfterGlobalFinish(false, true), false);
});

function placementExtension(monitors) {
    const source = readFileSync(new URL('../extension/gnome-winctl-v3@sagecat.local/extension.js', import.meta.url), 'utf8');
    const ExtensionClass = runInNewContext(
        source.replace(/^import[\s\S]*?;\n/gm, '').replace('export default class', 'class') +
            '\nGnomeWinCtlExtension;', {
            ...monitorPolicy, Extension: class {}, Meta: {GrabOp: {}, DisplayDirection: {}},
            global: {workspace_manager: {n_workspaces: 1}},
        }
    );
    const extension = Object.create(ExtensionClass.prototype);
    extension._monitors = () => monitors;
    return extension;
}

test('placement revalidates physical monitor identity after client indices change', () => {
    const extension = placementExtension([
        {index: 0, primary: true, x: 0, y: 0, width: 1000, height: 1000, serial: 'A'},
        {index: 1, x: 1000, y: 0, width: 1000, height: 1000, serial: 'B'},
    ]);
    const target = extension._resolvedTarget({
        workspace: 0, monitor: 1, monitor_intent: {serial: 'A'}, monitor_intent_resolved: true,
        geometry: {x: 20, y: 30, width: 200, height: 100}, clamp: false,
    });
    assert.equal(target.monitor, 0);
    assert.equal(target.monitor_intent.serial, 'A');
    assert.equal(target.geometry.x, 20);
});

test('a client resolution cannot overwrite now absent or ambiguous physical intent', () => {
    for (const additional of [[], [{index: 1, serial: 'A'}, {index: 2, serial: 'A'}]]) {
        const extension = placementExtension([
            {index: 0, primary: true, x: 0, y: 0, width: 1000, height: 1000, serial: 'B'},
            ...additional,
        ]);
        const target = extension._resolvedTarget({
            workspace: 0, monitor: 0, monitor_intent: {serial: 'A'}, monitor_intent_resolved: true,
            clamp: false,
        });
        assert.equal(target.monitor, 0);
        assert.equal(target.monitor_intent.serial, 'A');
    }
});

test('numeric-only placement continues to record its selected live monitor', () => {
    const extension = placementExtension([
        {index: 0, primary: true, x: 0, y: 0, width: 1000, height: 1000, serial: 'A'},
        {index: 1, x: 1000, y: 0, width: 1000, height: 1000, serial: 'B'},
    ]);
    const target = extension._resolvedTarget({monitor: 1, clamp: false});
    assert.equal(target.monitor, 1);
    assert.equal(target.monitor_intent.serial, 'B');
});
