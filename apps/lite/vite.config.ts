import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { distributionNoticesPlugin } from "../../scripts/distribution/notices";

const root = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root,
  base: "./",
  publicDir: false,
  server: { host: "127.0.0.1", cors: false },
  plugins: [
    preact({ devToolsEnabled: false }),
    distributionNoticesPlugin(resolve(root, "../..")),
  ],
});
