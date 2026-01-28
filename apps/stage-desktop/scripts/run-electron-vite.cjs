const { spawn } = require("node:child_process");
const path = require("node:path");

function main() {
  const cmd = process.argv[2] || "dev";
  const extraArgs = process.argv.slice(3);

  const bin = path.resolve(__dirname, "../node_modules/electron-vite/bin/electron-vite.js");
  const args = [bin, cmd, ...extraArgs];

  // IMPORTANT:
  // Some environments set `ELECTRON_RUN_AS_NODE=1` globally (or in the terminal session).
  // If that env var is present, Electron will NOT start the GUI app, and `require('electron').app`
  // will be undefined, causing startup to fail.
  //
  // Clearing via `cmd set ELECTRON_RUN_AS_NODE=` does NOT fully remove the variable (it makes it empty),
  // so we explicitly delete it here for the child process environment.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env
  });

  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}

main();

