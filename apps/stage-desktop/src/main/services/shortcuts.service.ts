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
    const okClickThrough = globalShortcut.register("Control+Alt+P", () => this.#deps.toggleClickThrough());
    if (!okClickThrough) console.warn("[shortcuts] failed to register Control+Alt+P");

    // Quick send (minimal input window)
    const okQuick = globalShortcut.register("CommandOrControl+Shift+C", () => this.#deps.openChat());
    if (!okQuick) console.warn("[shortcuts] failed to register Ctrl+Shift+C (CommandOrControl+Shift+C)");

    // Back-compat: keep the old shortcut as an alias.
    const okOld = globalShortcut.register("Control+Alt+C", () => this.#deps.openChat());
    if (!okOld) console.warn("[shortcuts] failed to register Control+Alt+C");

    const okMain = globalShortcut.register("Control+Alt+O", () => this.#deps.openControls());
    if (!okMain) console.warn("[shortcuts] failed to register Control+Alt+O");
  }

  dispose() {
    globalShortcut.unregisterAll();
  }
}
