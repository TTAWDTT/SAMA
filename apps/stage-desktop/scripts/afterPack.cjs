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

/**
 * electron-builder afterPack hook.
 *
 * Ensures the packaged app contains a real "@sama/shared" folder under
 * resources/app/node_modules (pnpm workspaces use symlinks that cannot be
 * relied on in a packaged app).
 */
exports.default = async function afterPack(context) {
  const appDir = path.resolve(__dirname, "..");
  const workspaceRoot = path.resolve(appDir, "..", "..");
  const sharedSrc = path.join(workspaceRoot, "packages", "shared");

  const sharedDist = path.join(sharedSrc, "dist");
  const sharedPkg = path.join(sharedSrc, "package.json");

  const appResourcesDir = path.join(context.appOutDir, "resources", "app");
  const sharedDest = path.join(appResourcesDir, "node_modules", "@sama", "shared");

  // If it already exists (from dependency copying), overwrite to avoid symlink/outside-root issues.
  await fs.rm(sharedDest, { recursive: true, force: true });
  await ensureDir(sharedDest);

  if (fsSync.existsSync(sharedPkg)) {
    await fs.copyFile(sharedPkg, path.join(sharedDest, "package.json"));
  }

  if (fsSync.existsSync(sharedDist)) {
    await copyDir(sharedDist, path.join(sharedDest, "dist"));
  }
};

