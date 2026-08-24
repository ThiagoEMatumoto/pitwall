import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@main": resolve("electron/main"),
        "@shared": resolve("shared"),
      },
    },
    build: {
      outDir: "out/main",
      lib: {
        entry: resolve("electron/main/index.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@preload": resolve("electron/preload"),
        "@shared": resolve("shared"),
      },
    },
    build: {
      outDir: "out/preload",
      lib: {
        entry: resolve("electron/preload/index.ts"),
      },
    },
  },
  renderer: {
    root: "src",
    // publicDir default ('public' sob o root) → src/public servido em / no dev
    // e copiado pro out/renderer no build — é de onde o Excalidraw carrega as
    // fontes (window.EXCALIDRAW_ASSET_PATH em excalidraw-lazy.ts).
    // O define evita "process is not defined" no renderer (o bundle do
    // Excalidraw lê process.env.IS_PREACT).
    define: {
      "process.env.IS_PREACT": JSON.stringify("false"),
    },
    resolve: {
      alias: {
        "@": resolve("src"),
        "@shared": resolve("shared"),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve("src/index.html"),
      },
    },
  },
});
