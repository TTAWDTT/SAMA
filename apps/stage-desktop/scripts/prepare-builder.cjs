const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function copyDir(src, dest) {
  await ensureDir(dest);
  await fs.cp(src, dest, { recursive: true, force: true });
}

async function main() {
  const appDir = path.resolve(__dirname, "..");
  const workspaceRoot = path.resolve(appDir, "..", "..");
  const workspaceShared = path.join(workspaceRoot, "packages", "shared");
  const nodeModulesShared = path.join(appDir, "node_modules", "@sama", "shared");

  if (fsSync.existsSync(nodeModulesShared)) {
    const stat = fsSync.lstatSync(nodeModulesShared);
    if (stat.isSymbolicLink()) {
      await fs.rm(nodeModulesShared, { recursive: true, force: true });
    }
  }

  if (!fsSync.existsSync(nodeModulesShared)) {
    await ensureDir(nodeModulesShared);
  }

  const sharedDist = path.join(workspaceShared, "dist");
  if (fsSync.existsSync(sharedDist)) {
    await copyDir(sharedDist, path.join(nodeModulesShared, "dist"));
  }

  const sharedPkg = path.join(workspaceShared, "package.json");
  if (fsSync.existsSync(sharedPkg)) {
    await fs.copyFile(sharedPkg, path.join(nodeModulesShared, "package.json"));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
