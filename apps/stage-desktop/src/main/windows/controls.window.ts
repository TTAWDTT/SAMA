import { BrowserWindow, app, nativeImage } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type CreateControlsWindowOpts = {
  preloadPath: string;
};

function getRendererUrl(route: string) {
  // electron-vite sets `ELECTRON_RENDERER_URL` in dev; some templates use `VITE_DEV_SERVER_URL`.
  const devUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
  if (devUrl) return `${devUrl.replace(/\/$/, "")}/${route}`;
  return join(__dirname, `../renderer/${route}`);
}

export function createControlsWindow(opts: CreateControlsWindowOpts) {
  const icon = (() => {
    try {
      const appPath = app.getAppPath();
      const candidates = [
        join(appPath, "assets/icons/app.ico"),
        join(appPath, "assets/icons/logo.png"),
        join(process.cwd(), "apps/stage-desktop/assets/icons/app.ico"),
        join(process.cwd(), "apps/stage-desktop/assets/icons/logo.png")
      ];
      for (const p of candidates) {
        if (!existsSync(p)) continue;
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img;
      }
    } catch {}
    return undefined;
  })();

  const win = new BrowserWindow({
    width: 420,
    height: 720,
    show: false,
    resizable: true,
    alwaysOnTop: false,
    backgroundColor: "#0b0f14",
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const isDev = !!(process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL);
  if (isDev) {
    void win.loadURL(getRendererUrl("controls/index.html"));
  } else {
    void win.loadFile(getRendererUrl("controls/index.html"));
  }

  win.once("ready-to-show", () => win.show());
  return win;
}
