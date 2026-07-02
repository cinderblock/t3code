import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

// Pin Electron's userData dir to the same location the app resolves at runtime
// (DesktopEnvironment: <appData>/t3code, or t3code-dev in dev). An UNPACKAGED Electron
// otherwise defaults its app name to "Electron" and binds the Chromium os_crypt /
// safeStorage key under %APPDATA%\Electron *before* the app's setPath("userData") runs,
// so a source build can't decrypt the connection catalog / saved environments that the
// installed (packaged) app wrote. Passing --user-data-dir applies before any app code,
// so os_crypt binds to the correct dir and the real profile decrypts.
function resolveUserDataDir() {
  const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
  const name = isDevelopment ? "t3code-dev" : "t3code";
  const home = NodeOS.homedir();
  if (process.platform === "win32") {
    return NodePath.join(process.env.APPDATA ?? NodePath.join(home, "AppData", "Roaming"), name);
  }
  if (process.platform === "darwin") {
    return NodePath.join(home, "Library", "Application Support", name);
  }
  return NodePath.join(process.env.XDG_CONFIG_HOME ?? NodePath.join(home, ".config"), name);
}

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const electronCommand = resolveElectronLaunchCommand([
  `--user-data-dir=${resolveUserDataDir()}`,
  "dist-electron/main.cjs",
]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
