import { Menu, Tray, nativeImage, app } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type TrayDeps = {
  toggleClickThrough: () => void;
  isClickThroughEnabled: () => boolean;
  togglePetVisible: () => void;
  isPetVisible: () => boolean;
  openControls: () => void;
  openChat: () => void;
  quit: () => void;
};

function createTrayIcon() {
  // Prefer a shipped tray icon (transparent, with outline for taskbar visibility).
  // Fall back to a tiny 16x16 PNG (white dot) to avoid startup failures if the asset is missing.
  try {
    const appPath = app.getAppPath();
    const candidates = [
      join(appPath, "assets/icons/tray.ico"),
      join(appPath, "assets/icons/tray.png"),
      join(process.cwd(), "apps/stage-desktop/assets/icons/tray.ico"),
      join(process.cwd(), "apps/stage-desktop/assets/icons/tray.png")
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  } catch {}

  const dataUrl =
    "data:image/png;base64," +
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAIUlEQVR42mP8z8Dwn4EIwDiqgYGB4T8GZQYqGgAAQf4E8pQ4uJQAAAAASUVORK5CYII=";
  return nativeImage.createFromDataURL(dataUrl);
}

export class TrayService {
  #tray: Tray | null = null;
  #deps: TrayDeps;

  constructor(deps: TrayDeps) {
    this.#deps = deps;
  }

  start() {
    const tray = new Tray(createTrayIcon());
    tray.setToolTip("SAMA");

    const rebuildMenu = () => {
      const clickThroughEnabled = this.#deps.isClickThroughEnabled();
      const petVisible = this.#deps.isPetVisible();

      tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: clickThroughEnabled ? "Disable Click-through" : "Enable Click-through",
            type: "normal",
            click: () => {
              this.#deps.toggleClickThrough();
              rebuildMenu();
            }
          },
          {
            label: "Open Chat",
            type: "normal",
            click: () => this.#deps.openChat()
          },
          {
            label: "Open Controls",
            type: "normal",
            click: () => this.#deps.openControls()
          },
          {
            label: petVisible ? "Hide Pet" : "Show Pet",
            type: "normal",
            click: () => {
              this.#deps.togglePetVisible();
              rebuildMenu();
            }
          },
          { type: "separator" },
          {
            label: "Quit",
            type: "normal",
            click: () => this.#deps.quit()
          }
        ])
      );
    };

    tray.on("click", () => this.#deps.togglePetVisible());
    rebuildMenu();
    this.#tray = tray;
  }

  dispose() {
    this.#tray?.destroy();
    this.#tray = null;
  }
}
