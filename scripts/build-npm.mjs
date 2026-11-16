// Builds the npm package for SoreQen Code into npm/: what `npm install -g`
// installs, and nothing else.
//
//   pnpm build && pnpm build:npm      then, to publish:  cd npm && npm publish
//
// The CLI is bundled into one file with esbuild — the workspace packages are
// not published separately, so nobody installs six packages to get one
// command. Two dependencies stay real dependencies, because they are loaded
// from disk at run time and cannot be bundled: playwright (the browser tools)
// and node-pty (terminals for interactive commands; optional, and commands
// fall back to plain pipes without it).
//
// NPM_NAME is the name people install and `soreqen update` looks up.

import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NPM_NAME = process.env.SOREQEN_NPM_NAME ?? "soreqen-code";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "npm");
const cli = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8"));
const tools = JSON.parse(readFileSync(join(root, "packages", "tools", "package.json"), "utf8"));
const runner = JSON.parse(readFileSync(join(root, "packages", "sandbox-runner", "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "bin"), { recursive: true });

await build({
  entryPoints: {
    cli: join(root, "packages", "cli", "dist", "cli.js"),
    // process-manager starts the reaper from beside itself.
    reaper: join(root, "packages", "sandbox-runner", "dist", "reaper.js"),
  },
  outdir: join(out, "dist"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  external: ["playwright", "playwright-core", "node-pty", "@prisma/client", "@sqcode/sandbox-cloud", "bufferutil", "utf-8-validate"],
  banner: { js: "import { createRequire as __sqcRequire } from 'node:module'; const require = __sqcRequire(import.meta.url);" },
  legalComments: "linked",
  logLevel: "warning",
});

writeFileSync(
  join(out, "bin", "soreqen.js"),
  [
    "#!/usr/bin/env node",
    'import { runCli } from "../dist/cli.js";',
    "",
    "runCli().catch((err) => {",
    '  console.error("SoreQen Code stopped with an error:", err);',
    "  process.exit(1);",
    "});",
    "",
  ].join("\n"),
);

writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: NPM_NAME,
      version: cli.version,
      description: "SoreQen Code: an autonomous coding agent for your terminal. Sign in with SoreQen or bring your own API key.",
      license: "Apache-2.0",
      type: "module",
      bin: { soreqen: "bin/soreqen.js" },
      files: ["bin", "dist", "README.md", "LICENSE", "NOTICE"],
      engines: { node: ">=20" },
      keywords: ["ai", "coding-agent", "cli", "mcp", "soreqen"],
      dependencies: { playwright: tools.dependencies.playwright },
      optionalDependencies: { "node-pty": runner.optionalDependencies["node-pty"] },
      ...(cli.repository ? { repository: { ...cli.repository, directory: undefined } } : {}),
    },
    null,
    2,
  )}\n`,
);
for (const f of ["README.md", "LICENSE", "NOTICE"]) cpSync(join(root, f), join(out, f));

console.log(`npm package ${NPM_NAME}@${cli.version} built in ${out}. Check it with \`npm pack --dry-run\` there, then \`npm publish\`.`);
