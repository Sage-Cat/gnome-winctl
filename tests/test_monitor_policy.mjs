import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MonitorChangeAction,
    applyDisplayConfigIdentities,
    canRecoverBehindShield,
    captureMonitorAnchor,
    captureMonitorIntent,
    decideMonitorChange,
    displayConfigLogicalMonitors,
    monitorForAnchor,
    retainRecentRestores,
    shouldContinueRecovery,
    topologyFingerprint,
} from '../extension/gnome-winctl-v3@sagecat.local/monitorPolicy.js';

function monitor(index, overrides = {}) {
    return {
        index,
        x: index * 1920,
        y: 0,
        width: 1920,
        height: 1080,
        scale: 1,
        primary: index === 0,
        connector: `DP-${index + 1}`,
        vendor: 'DEL',
        product: 'Display',
        serial: `serial-${index}`,
        edid_checksum: `edid-${index}`,
        ...overrides,
    };
}

test('physical serial survives index, connector, and geometry changes', () => {
    const anchor = captureMonitorAnchor(monitor(1));
    const changed = monitor(0, {
        connector: 'HDMI-9',
        serial: 'serial-1',
        edid_checksum: 'replacement-checksum',
        x: -1920,
        primary: true,
    });
    assert.equal(monitorForAnchor(anchor, [changed]), changed);
});

test('unique EDID is used when serial is unavailable', () => {
    const anchor = captureMonitorAnchor(monitor(1, {serial: ''}));
    const target = monitor(0, {serial: '', edid_checksum: 'edid-1'});
    assert.equal(monitorForAnchor(anchor, [monitor(2), target]), target);
});

test('duplicate EDID is disambiguated by connector', () => {
    const anchor = captureMonitorAnchor(monitor(1, {serial: '', edid_checksum: 'same'}));
    const wrong = monitor(0, {serial: '', edid_checksum: 'same', connector: 'DP-1'});
    const target = monitor(2, {serial: '', edid_checksum: 'same', connector: 'DP-2'});
    assert.equal(monitorForAnchor(anchor, [wrong, target]), target);
});

test('ambiguous physical identity never chooses an arbitrary display', () => {
    const anchor = captureMonitorAnchor(monitor(1, {
        serial: '',
        edid_checksum: 'same',
        connector: 'missing',
    }));
    const monitors = [
        monitor(0, {serial: '', edid_checksum: 'same', connector: 'DP-1'}),
        monitor(2, {serial: '', edid_checksum: 'same', connector: 'DP-3'}),
    ];
    assert.equal(monitorForAnchor(anchor, monitors), null);
});

test('an absent physical display never falls back to matching geometry', () => {
    const anchor = captureMonitorAnchor(monitor(1));
    const replacement = monitor(9, {
        x: anchor.fallback.x,
        y: anchor.fallback.y,
        serial: 'different',
        edid_checksum: 'different',
        connector: 'different',
    });
    assert.equal(monitorForAnchor(anchor, [replacement]), null);
});

test('a replacement on the same connector cannot impersonate a missing serial', () => {
    const anchor = captureMonitorAnchor(monitor(1));
    const replacement = monitor(9, {
        connector: anchor.connector,
        serial: 'different',
        edid_checksum: 'different',
    });
    assert.equal(monitorForAnchor(anchor, [replacement]), null);
});

test('a CLI EDID hash can fall through to serial when Shell lacks the hash', () => {
    const intent = captureMonitorIntent({
        edid_hash: 'kernel-hash', serial: 'serial-1', connector: 'stale',
        vendor: 'DEL', product: 'Display',
    });
    const target = monitor(1);
    assert.equal(monitorForAnchor(intent, [target]), target);
});

test('an explicit absent-monitor intent has no logical fallback', () => {
    const intent = captureMonitorIntent({
        connector: 'DP-9', vendor: 'DEL', product: 'Display', serial: 'gone',
    });
    assert.equal(monitorForAnchor(intent, [monitor(0)]), null);
});

test('logical geometry is a last-resort identity', () => {
    const source = monitor(1, {
        connector: '', vendor: '', product: '', serial: '', edid_checksum: '',
    });
    const anchor = captureMonitorAnchor(source);
    const target = {...source, index: 7};
    assert.equal(monitorForAnchor(anchor, [monitor(0), target]), target);
});

test('topology fingerprint ignores enumeration order but sees layout changes', () => {
    const left = monitor(0);
    const right = monitor(1);
    assert.equal(topologyFingerprint([left, right]), topologyFingerprint([right, left]));
    assert.notEqual(
        topologyFingerprint([left, right]),
        topologyFingerprint([left, {...right, x: 3840}]),
    );
});

test('DisplayConfig identities map by logical origin despite scale representation', () => {
    const state = [53, [], [[
        1920, 0, 1.25, 0, true,
        [['DP-1', 'GSM', 'LG HDR 4K', 'serial-lg']],
        {},
    ]], {}];
    const config = displayConfigLogicalMonitors(state);
    const [enriched] = applyDisplayConfigIdentities([{
        index: 0, x: 1920, y: 0, width: 3072, height: 1728, scale: 1,
    }], config);
    assert.equal(enriched.connector, 'DP-1');
    assert.equal(enriched.serial, 'serial-lg');
});

test('mirrored physical members form one stable logical identity', () => {
    const state = [53, [], [[
        0, 0, 1, 0, true,
        [
            ['DP-1', 'DEL', 'Display', 'one'],
            ['HDMI-1', 'DEL', 'Display', 'two'],
        ],
        {},
    ]], {}];
    const config = displayConfigLogicalMonitors(state);
    const enriched = applyDisplayConfigIdentities([{
        index: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1,
    }], config);
    const anchor = captureMonitorAnchor(enriched[0]);
    assert.equal(anchor.physical_identities.length, 2);
    assert.equal(monitorForAnchor(anchor, enriched), enriched[0]);
    assert.equal(monitorForAnchor(anchor, [monitor(0)]), null);
    const secondMember = captureMonitorIntent({
        connector: 'HDMI-1', vendor: 'DEL', product: 'Display', serial: 'two',
    });
    assert.equal(monitorForAnchor(secondMember, enriched), enriched[0]);
});

test('explicit, grabbed, and overview moves are immediately authoritative', () => {
    for (const reason of ['explicit', 'grabActive', 'overview']) {
        assert.equal(
            decideMonitorChange({[reason]: true}),
            MonitorChangeAction.COMMIT,
        );
    }
});

test('new-window settling waits through the topology-event grace', () => {
    assert.equal(
        decideMonitorChange({settling: true}),
        MonitorChangeAction.COMMIT_AFTER_TOPOLOGY,
    );
});

test('recovery freezes a settling window unless the move is explicit', () => {
    assert.equal(
        decideMonitorChange({settling: true, recovery: true}),
        MonitorChangeAction.DEFER,
    );
    assert.equal(
        decideMonitorChange({settling: true, recovery: true, explicit: true}),
        MonitorChangeAction.COMMIT,
    );
});

test('screen unavailability freezes even an interrupted explicit interaction', () => {
    assert.equal(
        decideMonitorChange({screenUnavailable: true, grabActive: true}),
        MonitorChangeAction.DEFER,
    );
    assert.equal(
        decideMonitorChange({screenUnavailable: true, overview: true}),
        MonitorChangeAction.DEFER,
    );
});

test('matching anchors are kept without creating a restore loop', () => {
    assert.equal(
        decideMonitorChange({matchesAnchor: true}),
        MonitorChangeAction.KEEP,
    );
});

test('recovery, self-restores, and absent displays defer movement', () => {
    assert.equal(decideMonitorChange({recovery: true}), MonitorChangeAction.DEFER);
    assert.equal(decideMonitorChange({restoring: true}), MonitorChangeAction.DEFER);
    assert.equal(
        decideMonitorChange({anchorAvailable: false}),
        MonitorChangeAction.DEFER,
    );
});

test('an unexplained stable-topology move becomes the new intent', () => {
    assert.equal(
        decideMonitorChange(),
        MonitorChangeAction.COMMIT_AFTER_TOPOLOGY,
    );
});

test('restore limiter retains only the active time window', () => {
    assert.deepEqual(retainRecentRestores([1, 5, 9], 10, 5), [5, 9]);
});

test('recovery retries only while useful and below the bound', () => {
    assert.equal(shouldContinueRecovery(1, 1, 3), true);
    assert.equal(shouldContinueRecovery(0, 1, 3), false);
    assert.equal(shouldContinueRecovery(1, 3, 3), true);
    assert.equal(shouldContinueRecovery(1, 4, 3), false);
});

test('shielded recovery waits for wake and every anchored monitor', () => {
    const left = monitor(0);
    const right = monitor(1);
    const anchors = [captureMonitorAnchor(left), captureMonitorAnchor(right)];
    assert.equal(canRecoverBehindShield({
        wakeRequested: false,
        displayConfigValid: true,
        anchors,
        monitors: [left, right],
    }), false);
    assert.equal(canRecoverBehindShield({
        wakeRequested: true,
        displayConfigValid: false,
        anchors,
        monitors: [left, right],
    }), false);
    assert.equal(canRecoverBehindShield({
        wakeRequested: true,
        displayConfigValid: true,
        anchors,
        monitors: [left],
    }), false);
    assert.equal(canRecoverBehindShield({
        wakeRequested: true,
        displayConfigValid: true,
        anchors,
        monitors: [left, right],
    }), true);
});
