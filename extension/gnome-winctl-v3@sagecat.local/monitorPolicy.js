export const MonitorChangeAction = Object.freeze({
    COMMIT: 'commit',
    COMMIT_AFTER_TOPOLOGY: 'commit-after-topology',
    KEEP: 'keep',
    DEFER: 'defer',
});

function string(value) {
    return value === null || value === undefined ? '' : String(value);
}

function identity(value = {}) {
    return {
        connector: string(value.connector),
        vendor: string(value.vendor),
        product: string(value.product),
        serial: string(value.serial),
        edid_checksum: string(value.edid_checksum),
        edid_hash: string(value.edid_hash),
    };
}

function identityHasPhysicalValue(value) {
    return Boolean(
        value.serial || value.edid_checksum || value.edid_hash || value.connector ||
        value.vendor || value.product
    );
}

function physicalIdentities(value = {}) {
    const members = Array.isArray(value.physical_identities)
        ? value.physical_identities.map(identity).filter(identityHasPhysicalValue)
        : [];
    if (members.length)
        return members;
    const member = identity(value);
    return identityHasPhysicalValue(member) ? [member] : [];
}

function fallback(value = {}) {
    const source = value.fallback ?? value;
    if (source === null)
        return null;
    return {
        index: Number(source.index ?? -1),
        x: Number(source.x ?? 0),
        y: Number(source.y ?? 0),
        width: Number(source.width ?? 0),
        height: Number(source.height ?? 0),
        scale: Number(source.scale ?? 1),
    };
}

function capture(value, includeFallback) {
    const members = physicalIdentities(value);
    const first = members[0] ?? identity(value);
    return {
        ...first,
        physical_identities: members,
        fallback: includeFallback ? fallback(value) : null,
    };
}

export function captureMonitorAnchor(monitor) {
    return capture(monitor, true);
}

export function captureMonitorIntent(value) {
    if (!value || typeof value !== 'object')
        return null;
    const result = capture(value, false);
    return anchorHasPhysicalIdentity(result) ? result : null;
}

export function anchorHasPhysicalIdentity(anchor) {
    return physicalIdentities(anchor).some(identityHasPhysicalValue);
}

function identityMatches(expected, actual) {
    if (expected.serial)
        return actual.serial === expected.serial;

    const expectedEdids = [expected.edid_checksum, expected.edid_hash].filter(Boolean);
    if (expectedEdids.length) {
        const actualEdids = [actual.edid_checksum, actual.edid_hash].filter(Boolean);
        return expectedEdids.some(value => actualEdids.includes(value));
    }

    if (!expected.connector)
        return false;
    return actual.connector === expected.connector &&
        (!expected.vendor || actual.vendor === expected.vendor) &&
        (!expected.product || actual.product === expected.product);
}

function monitorMatchesIdentities(expectedMembers, monitor) {
    const actualMembers = physicalIdentities(monitor);
    if (!actualMembers.length)
        return false;
    if (expectedMembers.length > 1) {
        return expectedMembers.every(expected =>
            actualMembers.some(actual => identityMatches(expected, actual))
        );
    }
    return actualMembers.some(actual => identityMatches(expectedMembers[0], actual));
}

function disambiguateByConnector(expectedMembers, monitors) {
    const connectors = expectedMembers.map(item => item.connector).filter(Boolean);
    if (!connectors.length)
        return monitors;
    return monitors.filter(monitor => {
        const actual = physicalIdentities(monitor);
        return connectors.every(connector =>
            actual.some(item => item.connector === connector)
        );
    });
}

function fallbackMatches(expected, monitor) {
    if (!expected)
        return false;
    return Number(monitor.x) === expected.x &&
        Number(monitor.y) === expected.y &&
        Number(monitor.width) === expected.width &&
        Number(monitor.height) === expected.height &&
        Number(monitor.scale ?? 1) === expected.scale;
}

export function monitorForAnchor(anchor, monitors) {
    if (!anchor || !Array.isArray(monitors) || !monitors.length)
        return null;

    const expectedMembers = physicalIdentities(anchor);
    if (expectedMembers.length) {
        let matches = monitors.filter(monitor =>
            monitorMatchesIdentities(expectedMembers, monitor)
        );
        if (matches.length > 1) {
            const connectorMatches = disambiguateByConnector(expectedMembers, matches);
            if (connectorMatches.length)
                matches = connectorMatches;
        }
        return matches.length === 1 ? matches[0] : null;
    }

    const expectedFallback = fallback(anchor);
    const matches = expectedFallback
        ? monitors.filter(monitor => fallbackMatches(expectedFallback, monitor))
        : [];
    return matches.length === 1 ? matches[0] : null;
}

export function displayConfigLogicalMonitors(state) {
    const logicalMonitors = Array.isArray(state?.[2]) ? state[2] : [];
    return logicalMonitors.map(logical => {
        const [x, y, scale, transform, primary, members] = logical;
        return {
            x: Number(x),
            y: Number(y),
            scale: Number(scale),
            transform: Number(transform),
            primary: Boolean(primary),
            physical_identities: (Array.isArray(members) ? members : []).map(member =>
                identity({
                    connector: member?.[0],
                    vendor: member?.[1],
                    product: member?.[2],
                    serial: member?.[3],
                })
            ),
        };
    });
}

export function applyDisplayConfigIdentities(monitors, logicalMonitors) {
    return monitors.map(monitor => {
        const logical = logicalMonitors.find(item =>
            Number(item.x) === Number(monitor.x) &&
            Number(item.y) === Number(monitor.y)
        );
        if (!logical)
            return monitor;
        const members = logical.physical_identities.map(identity);
        const first = members[0] ?? identity();
        return {
            ...monitor,
            connector: first.connector,
            vendor: first.vendor,
            product: first.product,
            serial: first.serial,
            edid_checksum: first.edid_checksum,
            physical_identities: members,
        };
    });
}

export function topologyFingerprint(monitors) {
    const entries = monitors.map(monitor => ({
        geometry: [
            Number(monitor.x), Number(monitor.y), Number(monitor.width),
            Number(monitor.height), Number(monitor.scale ?? 1),
        ],
        identities: physicalIdentities(monitor)
            .map(item => [
                item.serial, item.edid_checksum, item.edid_hash,
                item.connector, item.vendor, item.product,
            ].join('|'))
            .sort(),
    }));
    entries.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return JSON.stringify(entries);
}

export function decideMonitorChange({
    screenUnavailable = false,
    explicit = false,
    grabActive = false,
    overview = false,
    settling = false,
    restoring = false,
    recovery = false,
    anchorAvailable = true,
    matchesAnchor = false,
} = {}) {
    if (screenUnavailable)
        return MonitorChangeAction.DEFER;
    if (explicit || grabActive || overview)
        return MonitorChangeAction.COMMIT;
    if (recovery || restoring || !anchorAvailable)
        return MonitorChangeAction.DEFER;
    if (matchesAnchor)
        return MonitorChangeAction.KEEP;
    if (settling)
        return MonitorChangeAction.COMMIT_AFTER_TOPOLOGY;
    return MonitorChangeAction.COMMIT_AFTER_TOPOLOGY;
}

export function retainRecentRestores(restores, now, windowSize) {
    const cutoff = now - windowSize;
    return restores.filter(value => value >= cutoff);
}

export function shouldContinueRecovery(moved, pass, maximumPasses) {
    return moved > 0 && pass <= maximumPasses;
}

export function canRecoverBehindShield({
    wakeRequested,
    displayConfigValid,
    anchors,
    monitors,
}) {
    return Boolean(wakeRequested && displayConfigValid &&
        anchors.every(anchor => monitorForAnchor(anchor, monitors) !== null));
}
