import { describe, expect, it } from "vite-plus/test";

import { buildTarballManifest, npmRootOverrides } from "./server-tarball.ts";

const catalog = {
  effect: "4.0.0-rc.112",
  "@effect/platform-node": "4.0.0-rc.112",
  yaml: "^2.9.0",
};

describe("buildTarballManifest", () => {
  const serverPackage = {
    name: "t3",
    version: "0.0.40",
    bin: { t3: "./dist/bin.mjs" },
    type: "module",
    engines: { node: "^22.16 || ^23.11 || >=24.10" },
    files: ["dist"],
    dependencies: {
      effect: "catalog:",
      "@effect/platform-node": "catalog:",
      "node-pty": "^1.1.0",
    },
    devDependencies: { "@t3tools/shared": "workspace:*" },
    overrides: { "a>b": "-" },
  };

  it("resolves catalog specs and keeps only what an install needs", () => {
    expect(buildTarballManifest(serverPackage, catalog)).toEqual({
      name: "t3",
      version: "0.0.40",
      bin: { t3: "./dist/bin.mjs" },
      type: "module",
      engines: { node: "^22.16 || ^23.11 || >=24.10" },
      files: ["dist"],
      dependencies: {
        effect: "4.0.0-rc.112",
        "@effect/platform-node": "4.0.0-rc.112",
        "node-pty": "^1.1.0",
      },
    });
  });

  it("fails loudly when a catalog entry is missing", () => {
    expect(() =>
      buildTarballManifest(
        { name: "t3", version: "0.0.40", dependencies: { missing: "catalog:" } },
        catalog,
      ),
    ).toThrow(/missing/);
  });
});

describe("npmRootOverrides", () => {
  it("keeps plain pins and drops pnpm-only forms", () => {
    expect(
      npmRootOverrides(
        {
          effect: "4.0.0-rc.112",
          "@effect/platform-node-shared": "4.0.0-rc.112",
          yaml: "catalog:",
          "dbus-next>usocket": "-",
          "@clerk/clerk-js>@coinbase/wallet-sdk": "-",
          vite: "npm:@voidzero-dev/vite-plus-core@0.3.0",
        },
        catalog,
      ),
    ).toEqual({
      effect: "4.0.0-rc.112",
      "@effect/platform-node-shared": "4.0.0-rc.112",
      yaml: "^2.9.0",
    });
  });
});
