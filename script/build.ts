import * as esbuild from "esbuild";
import { solidPlugin } from "esbuild-plugin-solid";

const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["node:*", "@opencode-ai/*", "@opentui/*", "solid-js"],
};

const tuiPlugin = solidPlugin({
  solid: { moduleName: "@opentui/solid", generate: "universal" },
});

await esbuild.build({
  ...common,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
});

await esbuild.build({
  ...common,
  entryPoints: ["src/tui.tsx"],
  outfile: "dist/tui.js",
  plugins: [tuiPlugin],
});
