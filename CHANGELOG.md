# Changelog

## 0.1.1

- Stop (Ctrl-C) ends a turn at once, including while a sub-agent is working or
  the conversation is being checkpointed, and `/compact` stops on Ctrl-C too.
- The summary at the end of a turn lists browser actions and counts every tool,
  including those a sub-agent ran, so it no longer reports work as missing.
- `/context` and `/compact` use each hosted model's real context window; some
  showed 32k.
- If soreqen.com cannot be reached when SoreQen Code starts, your plan's models
  come back by themselves once it can, instead of being gone for the session.
- `soreqen update` says that sessions already open keep the old version until
  you restart them.

## 0.1.0: first public release

- An autonomous coding agent for the terminal: plans, edits files, runs commands
  and tests, checks its own work and reports what it did.
- Sign in with SoreQen: SoreQen credits for the hosted Flow models, SoreQen Auto,
  5-hour and weekly limits, Burst Day (`/burst`), and Flex (`soreqen flex`).
- Or bring your own key: OpenAI, Anthropic, OpenRouter, DeepSeek, OpenCode, or any
  OpenAI-compatible provider in `~/.soreqen/providers.json`.
- Modes from plan to bypass, checkpoints and `/rewind`, `/goal`, and memory between
  sessions.
- 24 built-in skills, plus your own in `~/.soreqen/skills/`.
- Full MCP: tools, resources, prompts, progress, roots and sampling.
