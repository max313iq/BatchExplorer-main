import { auditLog, bindAuditLogToStore, unbindAuditLogFromStore, } from "../audit-log";
class FakeStore {
    constructor() {
        Object.defineProperty(this, "entries", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: []
        });
        Object.defineProperty(this, "listeners", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Set()
        });
        Object.defineProperty(this, "addAuditEntry", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: jest.fn((entry) => {
                this.entries.push(entry);
                this.notify();
            })
        });
        Object.defineProperty(this, "getAuditEntries", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: jest.fn(() => {
                return [...this.entries];
            })
        });
        Object.defineProperty(this, "clearAuditEntries", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: jest.fn(() => {
                this.entries = [];
                this.notify();
            })
        });
        Object.defineProperty(this, "subscribeAuditLog", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: jest.fn((listener) => {
                this.listeners.add(listener);
                return () => {
                    this.listeners.delete(listener);
                };
            })
        });
    }
    listenerCount() {
        return this.listeners.size;
    }
    notify() {
        for (const listener of this.listeners) {
            listener();
        }
    }
}
const baseEntry = {
    actor: "alice@example.com",
    action: "resize_pool",
    target: "pool:p1 @ account:a1",
    status: "success",
};
describe("auditLog (singleton, local mode)", () => {
    afterEach(() => {
        unbindAuditLogFromStore();
        auditLog.clear();
    });
    it("record() adds entry with id + timestamp and returns full entry", () => {
        const before = Date.now();
        const entry = auditLog.record(baseEntry);
        const after = Date.now();
        expect(entry.id).toEqual(expect.any(String));
        expect(entry.id.length).toBeGreaterThan(0);
        expect(entry.actor).toBe(baseEntry.actor);
        expect(entry.action).toBe(baseEntry.action);
        expect(entry.target).toBe(baseEntry.target);
        expect(entry.status).toBe("success");
        const ts = Date.parse(entry.timestamp);
        expect(Number.isNaN(ts)).toBe(false);
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
    });
    it("getEntries() returns a copy (mutation does not leak)", () => {
        auditLog.record(baseEntry);
        const snap1 = auditLog.getEntries();
        snap1.length = 0;
        const snap2 = auditLog.getEntries();
        expect(snap2.length).toBe(1);
    });
    it("getEntries(limit) returns the most recent N entries", () => {
        for (let i = 0; i < 5; i++) {
            auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: `action_${i}` }));
        }
        const limited = auditLog.getEntries(2);
        expect(limited).toHaveLength(2);
        expect(limited[0].action).toBe("action_3");
        expect(limited[1].action).toBe("action_4");
    });
    it("getEntriesByAction filters by action", () => {
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: "delete_pool" }));
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: "resize_pool" }));
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: "delete_pool" }));
        const deletes = auditLog.getEntriesByAction("delete_pool");
        expect(deletes).toHaveLength(2);
        expect(deletes.every((e) => e.action === "delete_pool")).toBe(true);
    });
    it("getEntriesByActor filters by actor", () => {
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { actor: "bob@example.com" }));
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { actor: "alice@example.com" }));
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { actor: "bob@example.com" }));
        const bobs = auditLog.getEntriesByActor("bob@example.com");
        expect(bobs).toHaveLength(2);
        expect(bobs.every((e) => e.actor === "bob@example.com")).toBe(true);
    });
    it("clear() empties the buffer and notifies listeners", () => {
        auditLog.record(baseEntry);
        auditLog.record(baseEntry);
        expect(auditLog.getEntries()).toHaveLength(2);
        const listener = jest.fn();
        const unsub = auditLog.onChange(listener);
        auditLog.clear();
        unsub();
        expect(auditLog.getEntries()).toHaveLength(0);
        expect(listener).toHaveBeenCalled();
    });
    it("onChange() subscribes and unsubscribes correctly", () => {
        const listener = jest.fn();
        const unsubscribe = auditLog.onChange(listener);
        auditLog.record(baseEntry);
        expect(listener).toHaveBeenCalledTimes(1);
        auditLog.record(baseEntry);
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
        auditLog.record(baseEntry);
        expect(listener).toHaveBeenCalledTimes(2);
    });
    it("caps the buffer at 500 entries (drops oldest)", () => {
        for (let i = 0; i < 510; i++) {
            auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: `a_${i}` }));
        }
        const all = auditLog.getEntries();
        expect(all).toHaveLength(500);
        // Oldest 10 should be dropped; the first remaining is a_10.
        expect(all[0].action).toBe("a_10");
        expect(all[all.length - 1].action).toBe("a_509");
    });
    it("toJSON() returns the same data as getEntries()", () => {
        auditLog.record(baseEntry);
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: "delete_pool" }));
        expect(auditLog.toJSON()).toEqual(auditLog.getEntries());
    });
});
describe("auditLog (bound store mode)", () => {
    let store;
    beforeEach(() => {
        store = new FakeStore();
    });
    afterEach(() => {
        unbindAuditLogFromStore();
        auditLog.clear();
    });
    it("flushes locally buffered entries into the store on bind()", () => {
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: "pre_bind_1" }));
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: "pre_bind_2" }));
        bindAuditLogToStore(store);
        expect(store.addAuditEntry).toHaveBeenCalledTimes(2);
        expect(store.entries.map((e) => e.action)).toEqual([
            "pre_bind_1",
            "pre_bind_2",
        ]);
        // Local buffer should now read through the store.
        expect(auditLog.getEntries()).toHaveLength(2);
    });
    it("record() delegates to the store when bound", () => {
        bindAuditLogToStore(store);
        const entry = auditLog.record(baseEntry);
        expect(store.addAuditEntry).toHaveBeenCalledTimes(1);
        expect(store.addAuditEntry).toHaveBeenCalledWith(entry);
        expect(store.entries).toHaveLength(1);
        expect(store.entries[0]).toEqual(entry);
    });
    it("getEntries() reads from the store when bound", () => {
        bindAuditLogToStore(store);
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: "x1" }));
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: "x2" }));
        expect(store.getAuditEntries).toHaveBeenCalled();
        const all = auditLog.getEntries();
        expect(all.map((e) => e.action)).toEqual(["x1", "x2"]);
    });
    it("getEntries(limit) honors limit when reading from the store", () => {
        bindAuditLogToStore(store);
        for (let i = 0; i < 4; i++) {
            auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: `b_${i}` }));
        }
        const last2 = auditLog.getEntries(2);
        expect(last2.map((e) => e.action)).toEqual(["b_2", "b_3"]);
    });
    it("clear() delegates to the store when bound", () => {
        bindAuditLogToStore(store);
        auditLog.record(baseEntry);
        auditLog.clear();
        expect(store.clearAuditEntries).toHaveBeenCalledTimes(1);
        expect(auditLog.getEntries()).toHaveLength(0);
    });
    it("subscribes to the store and forwards change events to onChange listeners", () => {
        bindAuditLogToStore(store);
        const listener = jest.fn();
        const unsub = auditLog.onChange(listener);
        auditLog.record(baseEntry);
        // Record path emits store change → listener fires (at least once).
        expect(listener).toHaveBeenCalled();
        unsub();
    });
    it("unbind() returns to local mode and stops mirroring store changes", () => {
        bindAuditLogToStore(store);
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: "stored" }));
        expect(store.entries).toHaveLength(1);
        unbindAuditLogFromStore();
        // After unbind, fresh entries land in the local buffer, not the store.
        auditLog.record(Object.assign(Object.assign({}, baseEntry), { action: "local_again" }));
        expect(store.addAuditEntry).toHaveBeenCalledTimes(1); // unchanged
        const local = auditLog.getEntries();
        expect(local).toHaveLength(1);
        expect(local[0].action).toBe("local_again");
    });
    it("bind() is idempotent for the same store", () => {
        bindAuditLogToStore(store);
        const firstSubCalls = store.subscribeAuditLog.mock.calls.length;
        bindAuditLogToStore(store);
        expect(store.subscribeAuditLog.mock.calls.length).toBe(firstSubCalls);
    });
    it("bind() to a different store unbinds the previous one", () => {
        const otherStore = new FakeStore();
        bindAuditLogToStore(store);
        expect(store.listenerCount()).toBe(1);
        bindAuditLogToStore(otherStore);
        expect(store.listenerCount()).toBe(0);
        expect(otherStore.listenerCount()).toBe(1);
    });
    it("unbind() is safe to call when not bound", () => {
        expect(() => unbindAuditLogFromStore()).not.toThrow();
        expect(() => unbindAuditLogFromStore()).not.toThrow();
    });
});
//# sourceMappingURL=audit-log.test.js.map