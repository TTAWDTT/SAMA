import { BrowserWindow, app, nativeImage } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type CreateWindowOpts = {
  preloadPath: string;
  initialSize?: { width: number; height: number };
};

export const PET_WINDOW_DEFAULT_SIZE = { width: 420, height: 640 } as const;
export const PET_WINDOW_MIN_SIZE = { width: 260, height: 360 } as const;

function getRendererUrl(route: string) {
  // electron-vite sets `ELECTRON_RENDERER_URL` in dev; some templates use `VITE_DEV_SERVER_URL`.
  const devUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
  if (devUrl) return `${devUrl.replace(/\/$/, "")}/${route}`;
  return join(__dirname, `../renderer/${route}`);
}

export function createPetWindow(opts: CreateWindowOpts) {
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

  const rawW = opts.initialSize?.width ?? PET_WINDOW_DEFAULT_SIZE.width;
  const rawH = opts.initialSize?.height ?? PET_WINDOW_DEFAULT_SIZE.height;
  const w = Math.max(PET_WINDOW_MIN_SIZE.width, Math.round(Number(rawW)));
  const h = Math.max(PET_WINDOW_MIN_SIZE.height, Math.round(Number(rawH)));

  const win = new BrowserWindow({
    width: Number.isFinite(w) ? w : PET_WINDOW_DEFAULT_SIZE.width,
    height: Number.isFinite(h) ? h : PET_WINDOW_DEFAULT_SIZE.height,
    transparent: true,
    frame: false,
    resizable: true,
    thickFrame: true,
    minWidth: PET_WINDOW_MIN_SIZE.width,
    minHeight: PET_WINDOW_MIN_SIZE.height,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const isDev = !!(process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL);
  if (isDev) {
    void win.loadURL(getRendererUrl("pet/index.html"));
  } else {
    void win.loadFile(getRendererUrl("pet/index.html"));
  }

  return win;
}
