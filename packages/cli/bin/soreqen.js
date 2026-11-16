#!/usr/bin/env node

/**
 * SoreQen Code CLI Binary Entrypoint
 */

import { runCli } from "../dist/cli.js";

runCli().catch((err) => {
  console.error("Fatal CLI Error:", err);
  process.exit(1);
});
