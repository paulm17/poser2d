import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  publicDir: "scene-builder/public",
  build: {
    rollupOptions: {
      input: {
        studio: resolve(import.meta.dirname, "index.html"),
        stage: resolve(import.meta.dirname, "scene-builder/index.html"),
      },
    },
  },
});
