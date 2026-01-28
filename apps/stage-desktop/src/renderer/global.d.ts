import type { StageDesktopAPI } from "../main/preload";

declare global {
  interface Window {
    stageDesktop: StageDesktopAPI;
  }
}

export {};

