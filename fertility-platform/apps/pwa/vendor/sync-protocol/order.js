/**
 * Total order over events: (lamport, device_id, event_id). Ties on the Lamport
 * value are broken by identifiers (lowercase, code-point order) so every
 * replica resolves concurrent edits identically. This must match the SQL
 * ordering `lamport DESC, device_id DESC, event_id DESC` used by the server.
 */
export function compareEvents(a, b) {
    if (a.lamport !== b.lamport)
        return a.lamport < b.lamport ? -1 : 1;
    const d = cmp(a.device_id.toLowerCase(), b.device_id.toLowerCase());
    return d !== 0 ? d : cmp(a.event_id.toLowerCase(), b.event_id.toLowerCase());
}
/** Code-point comparison: identical to Postgres' bytewise uuid ordering. */
function cmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/**
 * Collapse an event log to its effective state: for each (kind, log_date) the
 * greatest event under `compareEvents` wins; a winning RETRACT removes the
 * entry. Input order is irrelevant and the input is not modified.
 */
export function effectiveEvents(events) {
    const winners = new Map();
    for (const ev of events) {
        const key = `${ev.kind}|${ev.log_date}`;
        const cur = winners.get(key);
        if (!cur || compareEvents(cur, ev) < 0)
            winners.set(key, ev);
    }
    return [...winners.values()]
        .filter((e) => e.op === 'SET')
        .sort((a, b) => (a.log_date === b.log_date ? (a.kind < b.kind ? -1 : 1) : a.log_date < b.log_date ? -1 : 1));
}
//# sourceMappingURL=order.js.map