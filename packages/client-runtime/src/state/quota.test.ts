import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { usageResetsForInstance } from "./quota.ts";

const makeProvider = (
  instanceId: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", email: "me@example.com" },
  checkedAt: "2026-10-27T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("usageResetsForInstance", () => {
  it("reads the account-wide session and weekly resets, not a model-scoped weekly", () => {
    const provider = makeProvider("claude", {
      usageLimits: {
        checkedAt: "2026-10-27T10:00:00.000Z",
        windows: [
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 50,
            resetsAt: "2026-10-29T00:00:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 40,
            resetsAt: "2026-10-30T00:00:00.000Z",
          },
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 20,
            resetsAt: "2026-10-27T13:00:00.000Z",
          },
        ],
      },
    });
    expect(usageResetsForInstance([provider], "claude")).toEqual({
      session: "2026-10-27T13:00:00.000Z",
      weekly: "2026-10-30T00:00:00.000Z",
    });
  });

  it("takes the freshest limits among instances on the same login", () => {
    const stale = makeProvider("claude", {
      usageLimits: {
        checkedAt: "2026-10-27T08:00:00.000Z",
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 90,
            resetsAt: "2026-10-27T09:00:00.000Z",
          },
        ],
      },
    });
    const fresh = makeProvider("claude-work", {
      usageLimits: {
        checkedAt: "2026-10-27T10:00:00.000Z",
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 5,
            resetsAt: "2026-10-27T15:00:00.000Z",
          },
        ],
      },
    });
    const otherLogin = makeProvider("claude-other", {
      auth: { status: "authenticated", email: "else@example.com" },
      usageLimits: {
        checkedAt: "2026-10-27T11:00:00.000Z",
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 5,
            resetsAt: "2026-10-27T16:00:00.000Z",
          },
        ],
      },
    });
    expect(usageResetsForInstance([stale, fresh, otherLogin], "claude").session).toBe(
      "2026-10-27T15:00:00.000Z",
    );
  });

  it("has no resets for an instance without published limits", () => {
    expect(usageResetsForInstance([makeProvider("codex")], "codex")).toEqual({});
    expect(usageResetsForInstance([], "claude")).toEqual({});
  });
});
