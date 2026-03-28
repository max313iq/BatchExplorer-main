export interface AuditEntry {
    id: string;
    timestamp: string; // ISO
    actor: string; // username/email from MSAL
    action: string; // e.g. "resize_pool", "delete_nodes", "login"
    target: string; // e.g. "pool:mypool1 @ account:batch001"
    details?: Record<string, unknown>;
    status: "success" | "failure";
    error?: string;
}

class AuditLog {
    private entries: AuditEntry[] = [];
    private maxEntries = 500;
    private listeners: Set<() => void> = new Set();

    record(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry {
        const full: AuditEntry = {
            ...entry,
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
        };
        this.entries.push(full);
        if (this.entries.length > this.maxEntries) {
            this.entries = this.entries.slice(-this.maxEntries);
        }
        this.notify();
        return full;
    }

    getEntries(limit?: number): AuditEntry[] {
        if (limit === undefined) {
            return [...this.entries];
        }
        return this.entries.slice(-limit);
    }

    getEntriesByAction(action: string): AuditEntry[] {
        return this.entries.filter((e) => e.action === action);
    }

    getEntriesByActor(actor: string): AuditEntry[] {
        return this.entries.filter((e) => e.actor === actor);
    }

    clear(): void {
        this.entries = [];
        this.notify();
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    toJSON(): AuditEntry[] {
        return [...this.entries];
    }

    private notify(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}

export const auditLog = new AuditLog();
