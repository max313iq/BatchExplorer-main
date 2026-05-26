/**
 * Project-wide jest setup. Polyfills and global mocks that every test file
 * needs. Loaded via `setupFilesAfterEach` in `jest.config.js`.
 */
// Polyfill `crypto.randomUUID` — the audit log + several agents use it.
// jsdom provides `crypto` but in older Node versions `randomUUID` may be missing.
if (typeof globalThis.crypto === "undefined") {
    // @ts-expect-error — extending the globalThis crypto for tests only
    globalThis.crypto = {};
}
if (typeof globalThis.crypto.randomUUID !== "function") {
    // Lightweight v4 UUID. Not cryptographically strong — fine for tests.
    globalThis.crypto.randomUUID = () => {
        const hex = (n) => Math.floor(Math.random() * Math.pow(16, n))
            .toString(16)
            .padStart(n, "0");
        return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
    };
}
// Quiet noisy `act()` warnings from a few legacy tests.
const origError = console.error;
console.error = (...args) => {
    const first = args[0];
    if (typeof first === "string" &&
        (first.includes("Warning: An update to") ||
            first.includes("not wrapped in act"))) {
        return;
    }
    origError(...args);
};
// localStorage / sessionStorage — jsdom provides these but a few tests run
// before jsdom mounts. Simple polyfill keyed off Map.
class MemoryStorage {
    constructor() {
        Object.defineProperty(this, "store", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
    }
    get length() {
        return this.store.size;
    }
    clear() {
        this.store.clear();
    }
    getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null;
    }
    key(index) {
        var _a;
        return (_a = Array.from(this.store.keys())[index]) !== null && _a !== void 0 ? _a : null;
    }
    removeItem(key) {
        this.store.delete(key);
    }
    setItem(key, value) {
        this.store.set(key, value);
    }
}
if (typeof globalThis.localStorage === "undefined") {
    Object.defineProperty(globalThis, "localStorage", {
        value: new MemoryStorage(),
        writable: false,
    });
}
if (typeof globalThis.sessionStorage === "undefined") {
    Object.defineProperty(globalThis, "sessionStorage", {
        value: new MemoryStorage(),
        writable: false,
    });
}
export {};
//# sourceMappingURL=setup-tests.js.map