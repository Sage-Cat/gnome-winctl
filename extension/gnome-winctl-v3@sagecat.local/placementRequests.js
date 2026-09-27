// Pure request ownership and verification policy; no compositor side effects.
export const TERMINAL_PLACEMENT_STATES = new Set(['verified', 'failed', 'expired', 'cancelled']);

export class PlacementRequests {
    constructor(now, {maxTerminal = 256, terminalAge = 300000000, maxActive = 256} = {}) {
        this.now = now;
        this.maxTerminal = maxTerminal;
        this.terminalAge = terminalAge;
        this.maxActive = maxActive;
        this.records = new Map();
    }

    create(token, target, deadline) {
        this.prune();
        const active = [...this.records.values()].filter(item => !TERMINAL_PLACEMENT_STATES.has(item.status));
        if (active.length >= this.maxActive)
            throw new Error('too many active placement requests');
        this.records.set(token, {token, target, deadline, status: 'accepted', placed: false, updated_at: this.now()});
        return token;
    }

    update(token, status, details = {}) {
        const previous = this.records.get(token);
        if (!previous || TERMINAL_PLACEMENT_STATES.has(previous.status))
            return false;
        this.records.set(token, {...previous, ...details, token, status, placed: status === 'verified', updated_at: this.now()});
        this.prune();
        return true;
    }

    get(token) {
        this.expire();
        return this.records.get(token) ?? {token, status: 'unknown', placed: false};
    }

    expire() {
        const now = this.now();
        for (const [token, item] of this.records) {
            if (!TERMINAL_PLACEMENT_STATES.has(item.status) && item.deadline !== null && now >= item.deadline)
                this.update(token, 'expired', {message: 'placement deadline elapsed'});
        }
        this.prune();
    }

    prune() {
        const now = this.now();
        const terminal = [...this.records.values()].filter(item => TERMINAL_PLACEMENT_STATES.has(item.status));
        terminal.sort((a, b) => a.updated_at - b.updated_at);
        for (let index = 0; index < terminal.length; index++) {
            const item = terminal[index];
            if (index < terminal.length - this.maxTerminal || now - item.updated_at > this.terminalAge)
                this.records.delete(item.token);
        }
    }
}

export function placementVerified(window, target, tolerance = 3) {
    if (window.workspace !== target.workspace || window.monitor !== target.monitor || window.state !== target.state)
        return false;
    if (target.state === 'maximized' || target.state === 'fullscreen')
        return true;
    return ['x', 'y', 'width', 'height'].every(key =>
        Number.isFinite(window.geometry?.[key]) &&
        Math.abs(window.geometry[key] - target.geometry[key]) <= tolerance);
}
