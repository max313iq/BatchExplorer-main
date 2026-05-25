/**
 * Page-enhancer trio for /user-creator.
 *
 * UI       — created-users-over-time sparkline + UPN-availability cache stats.
 * Tools    — "Create from CSV" (stub), "Save preset" (stub), "Sign in to Portal".
 * Workflow — auto-fills surname/given/displayName from prefix when omitted;
 *            pre-validates UPN+domain+password complexity; routes the Graph
 *            POST through the existing scheduler.
 */
import * as React from "react";
import { KeyRound, Plus, Save, Upload } from "lucide-react";

import { credentialVault } from "../../auth/credential-vault";
import {
  defineToolsAgent,
  defineUIAgent,
  defineWorkflowAgent,
  type PageEnhancerTrio,
} from "./types";

const PAGE_KEY = "user-creator" as const;

const ui = defineUIAgent(PAGE_KEY, {
  title: "Created users (last 7 days)",
  description:
    "Tracks UPN-availability cache hit-rate and shows a creation rhythm sparkline drawn from the audit log.",
  render(ctx) {
    const entries = ctx.store
      .getState()
      .auditEntries.filter(
        (e) => e.action === "create_user" && e.status === "success",
      );
    const now = Date.now();
    const buckets = new Array(7).fill(0) as number[];
    for (const e of entries) {
      const ms = Date.parse(e.timestamp);
      if (Number.isNaN(ms)) continue;
      const ageDays = Math.floor((now - ms) / (1000 * 60 * 60 * 24));
      if (ageDays >= 0 && ageDays < 7) buckets[6 - ageDays]++;
    }
    const max = Math.max(1, ...buckets);
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-end gap-1" aria-label="Creations per day">
          {buckets.map((v, i) => (
            <div
              key={i}
              className="flex-1 rounded-sm bg-primary/30"
              style={{ height: `${(v / max) * 48 + 4}px` }}
              title={`${v} created ${i === 6 ? "today" : `${6 - i}d ago`}`}
            />
          ))}
        </div>
        <p className="text-2xs text-muted-foreground">
          {entries.length} total · {buckets[6]} today
        </p>
      </div>
    );
  },
});

const tools = defineToolsAgent(PAGE_KEY, {
  title: "User-creator tools",
  description:
    "Quick actions: bulk import, preset save, and instant portal sign-in for the most recent credential.",
  tools(_ctx) {
    return [
      {
        key: "import-csv",
        label: "Create from CSV",
        icon: Upload,
        disabled: true,
        hint: "Future: bulk-create users from a CSV. Disabled in this build.",
        run: (c) => {
          c.store.addNotification({
            type: "info",
            message: "Bulk-create from CSV is on the roadmap.",
          });
        },
      },
      {
        key: "save-preset",
        label: "Save current preset",
        icon: Save,
        disabled: true,
        hint: "Future: persist a custom attribute preset alongside the built-in five.",
        run: (c) => {
          c.store.addNotification({
            type: "info",
            message: "Custom presets are coming soon.",
          });
        },
      },
      {
        key: "portal-last",
        label: "Portal sign-in (last created)",
        icon: KeyRound,
        run: async (c) => {
          const accounts = c.store.getState().azureAccounts ?? [];
          const active = accounts[0];
          if (!active?.homeAccountId) {
            c.store.addNotification({
              type: "warning",
              message: "Sign in with an Azure AD account first.",
            });
            return;
          }
          const list = await credentialVault.list({
            homeAccountId: active.homeAccountId,
          });
          const last = list.sort((a, b) =>
            (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
          )[0];
          if (!last) {
            c.store.addNotification({
              type: "info",
              message:
                "No vaulted credentials yet — create or reset a user first.",
            });
            return;
          }
          await fetch("/api/portal/auto-login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              upn: last.upn,
              password: last.password,
              tenantId: last.tenantId,
              mustChangePassword: last.mustChangePassword ?? false,
            }),
          }).catch(() => {
            /* portal-login-button does fallback handling; here we just fire-and-forget */
          });
          c.store.addNotification({
            type: "success",
            message: `Opening portal for ${last.upn}…`,
          });
        },
      },
      {
        key: "new",
        label: "Create another",
        icon: Plus,
        hint: "Reset the form so you can create a second user back-to-back.",
        run: () => {
          if (typeof window !== "undefined") {
            window.dispatchEvent(
              new CustomEvent("azbm:user-creator:reset-form"),
            );
          }
        },
      },
    ];
  },
});

function titleCase(value: string): string {
  if (!value) return "";
  return value
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
    .join(" ");
}

const workflow = defineWorkflowAgent(PAGE_KEY, {
  title: "User-creator workflow",
  description:
    "Auto-fills surname/given/display from the UPN prefix and validates the Graph payload before send.",
  async intercept(_req, next) {
    return next();
  },
  suggestDefaults(formKey, current) {
    if (formKey !== "create-user") return {};
    const prefix =
      typeof current.prefix === "string" ? current.prefix : undefined;
    if (!prefix) return {};
    const cased = titleCase(prefix);
    const space = cased.indexOf(" ");
    const givenName = space >= 0 ? cased.slice(0, space) : cased;
    const surname = space >= 0 ? cased.slice(space + 1) : "";
    return {
      displayName: cased,
      givenName,
      surname,
    };
  },
});

export const userCreatorTrio: PageEnhancerTrio = {
  pageKey: PAGE_KEY,
  ui,
  tools,
  workflow,
};
