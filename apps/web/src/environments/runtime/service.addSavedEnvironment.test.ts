import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveRemotePairingTarget = vi.fn();
const mockFetchRemoteEnvironmentDescriptor = vi.fn();
const mockBootstrapRemoteBearerSession = vi.fn();
const mockPersistSavedEnvironmentRecord = vi.fn();
const mockWriteSavedEnvironmentBearerToken = vi.fn();
const mockSetSavedEnvironmentRegistry = vi.fn();
const mockUpsert = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();

vi.mock("../remote/target", () => ({
  resolveRemotePairingTarget: mockResolveRemotePairingTarget,
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: mockBootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor: mockFetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState: vi.fn(),
  resolveRemoteWebSocketConnectionUrl: vi.fn(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      setSavedEnvironmentRegistry: mockSetSavedEnvironmentRegistry,
    },
  }),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: vi.fn(),
  hasSavedEnvironmentRegistryHydrated: vi.fn(),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: mockPersistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken: vi.fn(),
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    getState: () => ({
      upsert: mockUpsert,
      remove: vi.fn(),
      markConnected: vi.fn(),
    }),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: vi.fn(),
      clear: vi.fn(),
    }),
  },
  waitForSavedEnvironmentRegistryHydration: vi.fn(),
  writeSavedEnvironmentBearerToken: mockWriteSavedEnvironmentBearerToken,
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: vi.fn(() => ({
    environmentId: EnvironmentId.make("primary-environment"),
    label: "Primary",
    source: "manual",
    target: {
      httpBaseUrl: "https://primary.example.com/",
      wsBaseUrl: "wss://primary.example.com/",
    },
  })),
}));

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: vi.fn(),
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: mockCreateWsRpcClient,
}));

describe("addSavedEnvironment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockResolveRemotePairingTarget.mockReturnValue({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      credential: "pairing-code",
    });
    mockFetchRemoteEnvironmentDescriptor.mockResolvedValue({
      environmentId: EnvironmentId.make("environment-1"),
      label: "Remote environment",
    });
    mockBootstrapRemoteBearerSession.mockResolvedValue({
      sessionToken: "bearer-token",
      role: "owner",
    });
    mockPersistSavedEnvironmentRecord.mockResolvedValue(undefined);
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(false);
    mockSetSavedEnvironmentRegistry.mockResolvedValue(undefined);
    mockListSavedEnvironmentRecords.mockReturnValue([]);
    mockCreateEnvironmentConnection.mockImplementation(({ kind, knownEnvironment }) => ({
      kind,
      environmentId: knownEnvironment.environmentId,
      knownEnvironment,
      client: {
        dispose: vi.fn(),
      },
      ensureBootstrapped: vi.fn(),
      reconnect: vi.fn(),
      dispose: vi.fn(),
    }));
    mockCreateWsRpcClient.mockReturnValue({
      server: {
        subscribeLifecycle: vi.fn(() => vi.fn()),
        subscribeConfig: vi.fn(() => vi.fn()),
      },
      orchestration: {
        subscribeShell: vi.fn(() => vi.fn()),
        subscribeThread: vi.fn(() => vi.fn()),
      },
      terminal: {
        onEvent: vi.fn(() => vi.fn()),
      },
      reconnect: vi.fn(),
      dispose: vi.fn(),
    });
  });

  it("rolls back persisted metadata when bearer token persistence fails", async () => {
    const { addSavedEnvironment, resetEnvironmentServiceForTests } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).rejects.toThrow("Unable to persist saved environment credentials.");

    expect(mockPersistSavedEnvironmentRecord).toHaveBeenCalledTimes(1);
    expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      "bearer-token",
    );
    expect(mockSetSavedEnvironmentRegistry).toHaveBeenCalledWith([]);
    expect(mockUpsert).not.toHaveBeenCalled();

    await resetEnvironmentServiceForTests();
  });

  it("shows a specific error when pairing the already-active primary environment", async () => {
    mockFetchRemoteEnvironmentDescriptor.mockResolvedValue({
      environmentId: EnvironmentId.make("primary-environment"),
      label: "Primary environment",
    });

    const { addSavedEnvironment, getPrimaryEnvironmentConnection, resetEnvironmentServiceForTests } =
      await import("./service");

    getPrimaryEnvironmentConnection();

    await expect(
      addSavedEnvironment({
        label: "Firefly",
        pairingUrl: "https://my.server/pair#token=abc",
      }),
    ).rejects.toThrow(
      "This environment is already your current connection. You cannot add it as a separate saved environment.",
    );

    expect(mockBootstrapRemoteBearerSession).not.toHaveBeenCalled();
    await resetEnvironmentServiceForTests();
  });
});
