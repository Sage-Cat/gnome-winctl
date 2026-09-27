export function windowIsOnActiveWorkspace(window, workspaceManager) {
    if (window.is_on_all_workspaces?.() === true)
        return true;
    const windowWorkspace = window.get_workspace?.() ?? null;
    const activeWorkspace = workspaceManager.get_active_workspace?.() ?? null;
    return windowWorkspace !== null && windowWorkspace === activeWorkspace;
}

export function placementNeedsActiveWorkspace(
    window,
    workspaceManager,
    destinationWorkspace,
) {
    if (window.is_on_all_workspaces?.() === true)
        return false;
    const activeWorkspace = workspaceManager.get_active_workspace?.() ?? null;
    return destinationWorkspace === null || destinationWorkspace !== activeWorkspace;
}

export function protectMonitorAnchorDuringWorkspaceRecovery(
    pending,
    deferredPlacement,
) {
    return Boolean(pending || deferredPlacement);
}

export function deferredPlacementCanApply(
    window,
    workspaceManager,
    screenUnavailable,
    deferredPlacement,
) {
    return !screenUnavailable && Boolean(deferredPlacement) &&
        windowIsOnActiveWorkspace(window, workspaceManager);
}

export function workspaceRecoveryStartsPending(window, workspaceManager) {
    return !windowIsOnActiveWorkspace(window, workspaceManager);
}

export function pendingWorkspaceRecoveryAfterGlobalFinish(
    pending,
    activationRecoveryActive,
) {
    return Boolean(pending && activationRecoveryActive);
}
