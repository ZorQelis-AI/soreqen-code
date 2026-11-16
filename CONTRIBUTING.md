# Contributing to SoreQen Code

Thank you for helping. SoreQen Code is the open-source CLI and agent made by
[ZorQelis AI](https://zorqelisai.com); issues and pull requests are welcome.

## Before you start

- **Bugs:** open an issue with what you ran, what you expected and what happened.
  Include `soreqen --version`, your OS and Node version. Remove any API keys from
  logs before pasting them.
- **Larger changes:** open an issue first, so we can agree on the approach before
  you spend time on it.
- **Security problems:** do not open an issue. See [SECURITY.md](SECURITY.md).

## Working on the code

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm soreqen          # run the CLI from source
```

Node.js 20 or newer and pnpm 10.

| Package | What it is |
| --- | --- |
| `packages/cli` | The terminal interface |
| `packages/orchestrator` | The agent loop, the context engine, skills, model providers |
| `packages/tools` | File, search, command, browser and web tools |
| `packages/sandbox-runner` | Runs commands and processes in the project folder |
| `packages/mcp` | The MCP client |
| `packages/shared` | Types and definitions shared by all of them |

## Pull requests

- One change per pull request, with a test that fails without it.
- `pnpm build && pnpm typecheck && pnpm test` must pass. CI runs the same.
- Tests never touch real files or real keys. Use a temporary `SOREQEN_HOME` and
  fake providers.
- Write comments that explain *why*, not what.
- By contributing, you agree that your contribution is licensed under the
  Apache-2.0 licence of this repository.
