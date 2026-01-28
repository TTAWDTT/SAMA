import { BrowserWindow } from "electron";
import { join } from "node:path";

export type CreateCaptionWindowOpts = {
  preloadPath: string;
  width?: number;
  height?: number;
};

function getRendererUrl(route: string) {
  // electron-vite sets `ELECTRON_RENDERER_URL` in dev; some templates use `VITE_DEV_SERVER_URL`.
  const devUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
  if (devUrl) return `${devUrl.replace(/\/$/, "")}/${route}`;
  return join(__dirname, `../renderer/${route}`);
}

export function createCaptionWindow(opts: CreateCaptionWindowOpts) {
  const win = new BrowserWindow({
    width: opts.width ?? 420,
    height: opts.height ?? 220,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    focusable: false,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  const isDev = !!(process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL);
  if (isDev) {
    void win.loadURL(getRendererUrl("caption/index.html"));
  } else {
    void win.loadFile(getRendererUrl("caption/index.html"));
  }

  return win;
}
