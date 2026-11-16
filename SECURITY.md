# Security policy

## Reporting a vulnerability

Please email **security@zorqelisai.com**. Do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with
it. We will acknowledge your report within 3 working days, keep you updated
while we fix it, and credit you when the fix is released, if you would like.

## In scope

- This CLI and agent: anything that runs a command, writes a file or calls a
  network service the person did not approve.
- How keys and sign-in tokens are stored (`~/.soreqen/`) and sent.
- MCP server trust, and skills or project files that could make the agent act
  against the person running it.

## Supported versions

Security fixes go into the latest release. `soreqen update` installs it.
