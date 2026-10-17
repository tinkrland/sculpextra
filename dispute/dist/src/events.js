"use strict";
// append-only event logs, mirroring the ticketing discipline: every
// state change is an event, there is no update and no delete, and
// events are deep-frozen so nobody can rewrite history.
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventLog = void 0;
exports.deepFreeze = deepFreeze;
class EventLog {
    byRef = new Map();
    append(ref, make) {
        const existing = this.byRef.get(ref) ?? [];
        const seq = existing.length === 0 ? 1 : existing[existing.length - 1].seq + 1;
        const event = deepFreeze(make(seq));
        existing.push(event);
        this.byRef.set(ref, existing);
        return event;
    }
    list(ref) {
        return Object.freeze([...(this.byRef.get(ref) ?? [])]);
    }
    refs() {
        return Object.freeze([...this.byRef.keys()]);
    }
}
exports.EventLog = EventLog;
function deepFreeze(value) {
    if (value && typeof value === "object") {
        for (const k of Object.keys(value)) {
            deepFreeze(value[k]);
        }
        Object.freeze(value);
    }
    return value;
}
