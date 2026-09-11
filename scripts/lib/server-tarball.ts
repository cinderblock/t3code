/**
 * Pure pieces of `scripts/pack-server-tarball.ts`: the manifest a local server
 * tarball ships with, and the overrides its install root needs.
 *
 * Mirrors what `apps/server/scripts/cli.ts publish` writes before `pnpm publish`,
 * minus the parts that only work for a pnpm publish. See
 * plans/sentinel-fork-backend.md for why each rule exists.
 */
import { resolveCatalogDependencies } from "./resolve-catalog.ts";

export interface ServerPackageJson {
  readonly name: string;
  readonly version: string;
  readonly repository?: unknown;
  readonly bin?: unknown;
  readonly type?: string;
  readonly engines?: Record<string, string>;
  readonly files?: ReadonlyArray<string>;
  readonly dependencies?: Record<string, string>;
}

/**
 * The manifest packed into the tarball: runtime dependencies only, with every
 * `catalog:` spec resolved. devDependencies are left out because their
 * `workspace:*` specs cannot be resolved outside the monorepo, and `overrides`
 * are left out because npm refuses to pack pnpm's `a>b` selectors and ignores a
 * dependency's overrides anyway.
 */
export function buildTarballManifest(
  serverPackage: ServerPackageJson,
  catalog: Record<string, string>,
): Record<string, unknown> {
  return {
    name: serverPackage.name,
    version: serverPackage.version,
    ...(serverPackage.repository !== undefined ? { repository: serverPackage.repository } : {}),
    ...(serverPackage.bin !== undefined ? { bin: serverPackage.bin } : {}),
    ...(serverPackage.type !== undefined ? { type: serverPackage.type } : {}),
    ...(serverPackage.engines !== undefined ? { engines: serverPackage.engines } : {}),
    ...(serverPackage.files !== undefined ? { files: serverPackage.files } : {}),
    dependencies: resolveCatalogDependencies(
      serverPackage.dependencies ?? {},
      catalog,
      "apps/server",
    ),
  };
}

/**
 * The workspace overrides npm can honour, for the `package.json` of the
 * directory the tarball is installed into. npm applies overrides only at the
 * install root, and the pins are what stop Effect's floating transitive
 * packages from forcing a newer `effect` than the pinned one. Without them npm
 * loops resolving `effect` indefinitely.
 *
 * pnpm-only forms are dropped: `a>b` parent selectors, `-` removals, and
 * `npm:` aliases (which only ever replace build tooling the server never loads).
 */
export function npmRootOverrides(
  workspaceOverrides: Record<string, string>,
  catalog: Record<string, string>,
): Record<string, string> {
  const plain = Object.fromEntries(
    Object.entries(workspaceOverrides).filter(
      ([name, spec]) =>
        !name.includes(">") && typeof spec === "string" && spec !== "-" && !spec.startsWith("npm:"),
    ),
  );
  return resolveCatalogDependencies(plain, catalog, "pnpm-workspace overrides");
}
