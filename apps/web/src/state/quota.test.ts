import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { groupUsageAccounts, orderUsageAccountsForSelection, usageWaitingDrivers } from "./quota";

const makeProvider = (driver: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-26T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const limits: NonNullable<ServerProvider["usageLimits"]> = {
  checkedAt: "2026-09-26T00:00:00.000Z",
  windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 10 }],
};

describe("usageWaitingDrivers", () => {
  it("names a ready usage-reporting provider whose limits have not arrived", () => {
    expect(usageWaitingDrivers([makeProvider("claudeAgent")])).toEqual(["claudeAgent"]);
  });

  it("is empty once any account has limits, since the meters then show", () => {
    expect(
      usageWaitingDrivers([
        makeProvider("claudeAgent", { usageLimits: limits }),
        makeProvider("codex"),
      ]),
    ).toEqual([]);
  });

  it("ignores providers that are disabled, missing, unavailable, or never report usage", () => {
    expect(
      usageWaitingDrivers([
        makeProvider("claudeAgent", { enabled: false }),
        makeProvider("codex", { installed: false }),
        makeProvider("cursor", { availability: "unavailable" }),
        makeProvider("antigravity"),
      ]),
    ).toEqual([]);
  });

  it("lists each waiting driver once across its instances", () => {
    expect(
      usageWaitingDrivers([
        makeProvider("codex", { instanceId: ProviderInstanceId.make("codex-work") }),
        makeProvider("codex", { instanceId: ProviderInstanceId.make("codex-home") }),
      ]),
    ).toEqual(["codex"]);
  });
});

describe("groupUsageAccounts", () => {
  it("collapses instances that share a signed-in address into one account", () => {
    const accounts = groupUsageAccounts([
      makeProvider("claudeAgent", {
        instanceId: ProviderInstanceId.make("a"),
        auth: { status: "authenticated", email: "Me@Example.com" },
        usageLimits: limits,
      }),
      makeProvider("claudeAgent", {
        instanceId: ProviderInstanceId.make("b"),
        auth: { status: "authenticated", email: "me@example.com" },
        usageLimits: { ...limits, checkedAt: "2026-09-26T01:00:00.000Z" },
      }),
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.instanceIds).toEqual(["a", "b"]);
    expect(accounts[0]?.limits.checkedAt).toBe("2026-09-26T01:00:00.000Z");
  });
});

describe("orderUsageAccountsForSelection", () => {
  const accounts = groupUsageAccounts([
    makeProvider("codex", { usageLimits: limits }),
    makeProvider("claudeAgent", {
      instanceId: ProviderInstanceId.make("work"),
      auth: { status: "authenticated", email: "work@example.com" },
      usageLimits: limits,
    }),
  ]);

  it("leads with the account behind the selected instance", () => {
    const ordered = orderUsageAccountsForSelection(accounts, ProviderInstanceId.make("work"));
    expect(ordered.map((account) => account.instanceId)).toEqual(["work", "codex"]);
  });

  it("keeps the grouped order with no selection or an unknown one", () => {
    expect(orderUsageAccountsForSelection(accounts, null)).toBe(accounts);
    expect(orderUsageAccountsForSelection(accounts, ProviderInstanceId.make("gone"))).toBe(
      accounts,
    );
  });
});
