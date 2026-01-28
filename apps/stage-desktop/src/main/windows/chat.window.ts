import { BrowserWindow } from "electron";
import { join } from "node:path";

export type CreateChatWindowOpts = {
  preloadPath: string;
};

function getRendererUrl(route: string) {
  // electron-vite sets `ELECTRON_RENDERER_URL` in dev; some templates use `VITE_DEV_SERVER_URL`.
  const devUrl = process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL;
  if (devUrl) return `${devUrl.replace(/\/$/, "")}/${route}`;
  return join(__dirname, `../renderer/${route}`);
}

export function createChatWindow(opts: CreateChatWindowOpts) {
  const win = new BrowserWindow({
    width: 420,
    height: 640,
    show: false,
    resizable: true,
    alwaysOnTop: false,
    backgroundColor: "#0b0f14",
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const isDev = !!(process.env.ELECTRON_RENDERER_URL || process.env.VITE_DEV_SERVER_URL);
  if (isDev) {
    void win.loadURL(getRendererUrl("chat/index.html"));
  } else {
    void win.loadFile(getRendererUrl("chat/index.html"));
  }

  win.once("ready-to-show", () => win.show());
  return win;
}
