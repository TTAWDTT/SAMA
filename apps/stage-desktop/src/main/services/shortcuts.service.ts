import { globalShortcut } from "electron";

export type ShortcutDeps = {
  toggleClickThrough: () => void;
  openChat: () => void;
  openControls: () => void;
};

export class ShortcutsService {
  #deps: ShortcutDeps;

  constructor(deps: ShortcutDeps) {
    this.#deps = deps;
  }

  start() {
    globalShortcut.register("Control+Alt+P", () => this.#deps.toggleClickThrough());
    globalShortcut.register("Control+Alt+C", () => this.#deps.openChat());
    globalShortcut.register("Control+Alt+O", () => this.#deps.openControls());
  }

  dispose() {
    globalShortcut.unregisterAll();
  }
}
