import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts")
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/preload.ts")
      }
    }
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    base: "./",
    resolve: {
      // Use workspace source for renderer builds so Vite doesn't load the CJS `dist/` entry.
      // (CJS files served as ESM cause "does not provide an export named ..." and a blank screen.)
      alias: {
        "@sama/shared": resolve(__dirname, "../../packages/shared/src/index.ts")
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          pet: resolve(__dirname, "src/renderer/pet/index.html"),
          controls: resolve(__dirname, "src/renderer/controls/index.html"),
          caption: resolve(__dirname, "src/renderer/caption/index.html"),
          chat: resolve(__dirname, "src/renderer/chat/index.html")
        }
      }
    }
  }
});
