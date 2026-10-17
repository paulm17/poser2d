import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "./",
  publicDir: "scene-builder/public",
  build: {
    rollupOptions: {
      input: {
        studio: resolve(import.meta.dirname, "index.html"),
        mannequin2: resolve(import.meta.dirname, "scene-builder-mannequin-2/index.html"),
        mannequin: resolve(import.meta.dirname, "scene-builder-mannequin/index.html"),
        stage2: resolve(import.meta.dirname, "scene-builder-2/index.html"),
        stage: resolve(import.meta.dirname, "scene-builder/index.html"),
      },
    },
  },
});
