# Claude Code

## Register (recommended)

```bash
claude mcp add clef-mcp -- clef-mcp
# without a global install:
claude mcp add clef-mcp -- npx -y clef-mcp
```

## Or via project config

Copy `mcp.json` from this directory to your project root as `.mcp.json` (project-scope servers).

## One-time setup

```bash
npx clef-mcp install
```

Verify inside Claude Code with `/mcp` — `clef-mcp` should list the `clef_decide` tool.
