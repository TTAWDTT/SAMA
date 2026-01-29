import type { StageDesktopAPI } from "../main/preload";

declare global {
  interface Window {
    stageDesktop: StageDesktopAPI;
  }
}

// Image module declarations
declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.jpg" {
  const src: string;
  export default src;
}

declare module "*.jpeg" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "*.gif" {
  const src: string;
  export default src;
}

export {};

