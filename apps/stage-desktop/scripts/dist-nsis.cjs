const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: "inherit"
    });
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`Command terminated by signal: ${signal}`));
      if (code !== 0) return reject(new Error(`Command failed: ${cmd} ${args.join(" ")} (exit ${code})`));
      resolve();
    });
  });
}

async function listExeFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) continue;
    if (e.name.toLowerCase().endsWith(".exe")) out.push(p);
  }
  return out;
}

async function main() {
  const appDir = path.resolve(__dirname, "..");

  // Make a fresh output dir each run so electron-builder doesn't need to delete the previous win-unpacked.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const builderOutDir = path.join(appDir, "dist", "_builder", stamp);
  await fs.mkdir(builderOutDir, { recursive: true });

  const node = process.execPath;
  const prepare = path.join(__dirname, "prepare-builder.cjs");
  const electronViteBin = path.join(appDir, "node_modules", "electron-vite", "bin", "electron-vite.js");
  const electronBuilderCli = path.join(appDir, "node_modules", "electron-builder", "out", "cli", "cli.js");

  await run(node, [prepare], { cwd: appDir });
  await run(node, [electronViteBin, "build"], { cwd: appDir });

  await run(
    node,
    [electronBuilderCli, "--win", "nsis", `--config.directories.output=${builderOutDir}`],
    { cwd: appDir }
  );

  // Copy the installer exe to a stable path for convenience.
  const exeFiles = await listExeFiles(builderOutDir);
  const installer = exeFiles.find((p) => !p.toLowerCase().includes("win-unpacked"));
  if (!installer) {
    throw new Error(`No installer .exe found in ${builderOutDir}`);
  }

  const latest = path.join(appDir, "dist", "sama-Setup-latest.exe");
  await fs.copyFile(installer, latest);

  // Print a friendly hint for humans.
  // eslint-disable-next-line no-console
  console.log(`\nOK: ${latest}\n`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

