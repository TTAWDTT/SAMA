import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

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
