/**
 * Pack the built T3 server into a tarball that installs outside the monorepo,
 * for running this fork as a headless server on another machine.
 *
 * The fork is not published to npm, and `t3 service install` always installs
 * upstream's `t3@<version>` from the registry, so a fork build has to travel as
 * a tarball. See plans/sentinel-fork-backend.md.
 *
 * Build first:   vp run --filter t3 build
 * Pack:          node scripts/pack-server-tarball.ts [--out <dir>]
 *
 * The output directory holds two files, `t3-<version>.tgz` and `package.json`.
 * The manifest is the install root: it depends on the tarball and carries the
 * version pins npm only honours at the root. On the target machine, copy both
 * into one directory and run:
 *
 *   npm install --no-audit --no-fund
 *   npm approve-scripts node-pty msgpackr-extract   # npm 11+ only, then re-run install
 *   node node_modules/t3/dist/bin.mjs serve --host <addr> --port 3773
 */

// @effect-diagnostics nodeBuiltinImport:off - standalone `node scripts/...` utility, no Effect runtime
// @effect-diagnostics globalConsole:off - its output IS the user interface; Effect.log would need a runtime
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";

import {
  buildTarballManifest,
  npmRootOverrides,
  type ServerPackageJson,
} from "./lib/server-tarball.ts";

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodeWorkspaceConfig = Schema.decodeUnknownSync(fromYaml(WorkspaceConfig));

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const serverDir = NodePath.join(repoRoot, "apps", "server");

function parseOutDir(argv: ReadonlyArray<string>): string {
  const index = argv.indexOf("--out");
  if (index !== -1) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--out needs a directory");
    }
    return NodePath.resolve(value);
  }
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-tarball-"));
}

function requireBuildOutput(): void {
  for (const relative of ["dist/bin.mjs", "dist/client/index.html"]) {
    if (!NodeFS.existsSync(NodePath.join(serverDir, relative))) {
      throw new Error(`apps/server/${relative} is missing. Build first: vp run --filter t3 build`);
    }
  }
}

/**
 * Runs `npm pack` in `cwd` and returns the tarball's file name. A fixed command
 * string through the shell resolves `npm.cmd` on Windows and `npm` elsewhere,
 * with no arguments to escape. `--loglevel=warn` drops the per-file notice
 * listing (thousands of lines for the web client); `--json` reports the name.
 */
function npmPack(cwd: string): string {
  const output = NodeChildProcess.execSync("npm pack --json --loglevel=warn", {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const [packed] = JSON.parse(output) as ReadonlyArray<{ readonly filename?: string }>;
  if (packed?.filename === undefined) {
    throw new Error(`npm pack did not report a tarball:\n${output}`);
  }
  return packed.filename;
}

function main(): void {
  requireBuildOutput();
  const outDir = parseOutDir(process.argv.slice(2));
  NodeFS.mkdirSync(outDir, { recursive: true });

  const serverPackage = JSON.parse(
    NodeFS.readFileSync(NodePath.join(serverDir, "package.json"), "utf8"),
  ) as ServerPackageJson;
  const workspace = decodeWorkspaceConfig(
    NodeFS.readFileSync(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
  );
  const catalog = workspace.catalog ?? {};

  const staging = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-stage-"));
  try {
    NodeFS.cpSync(NodePath.join(serverDir, "dist"), NodePath.join(staging, "dist"), {
      recursive: true,
    });
    NodeFS.writeFileSync(
      NodePath.join(staging, "package.json"),
      `${JSON.stringify(buildTarballManifest(serverPackage, catalog), null, 2)}\n`,
    );
    const tarballName = npmPack(staging);
    NodeFS.renameSync(NodePath.join(staging, tarballName), NodePath.join(outDir, tarballName));

    const installRoot = {
      private: true,
      description: `Install root for a packed ${serverPackage.name}@${serverPackage.version} server.`,
      dependencies: { [serverPackage.name]: `file:./${tarballName}` },
      overrides: npmRootOverrides(workspace.overrides ?? {}, catalog),
    };
    NodeFS.writeFileSync(
      NodePath.join(outDir, "package.json"),
      `${JSON.stringify(installRoot, null, 2)}\n`,
    );

    const sizeMb = NodeFS.statSync(NodePath.join(outDir, tarballName)).size / 1024 / 1024;
    console.log(`Packed ${serverPackage.name}@${serverPackage.version} (${sizeMb.toFixed(1)} MB)`);
    console.log(`  ${NodePath.join(outDir, tarballName)}`);
    console.log(`  ${NodePath.join(outDir, "package.json")}  (install root with version pins)`);
    console.log("");
    console.log("On the target, copy both files into one directory, then:");
    console.log("  npm install --no-audit --no-fund");
    console.log(
      "  npm approve-scripts node-pty msgpackr-extract   # npm 11+ only, then re-run install",
    );
    console.log("  node node_modules/t3/dist/bin.mjs serve --host <addr> --port 3773");
  } finally {
    NodeFS.rmSync(staging, { recursive: true, force: true });
  }
}

main();
