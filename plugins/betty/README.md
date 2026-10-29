# BETTY

A bb plugin that talks to BETTY (PESTO) over its MCP endpoint, so you can start and follow BETTY runs from bb.

## Setting

| Setting | Default | What it does |
| --- | --- | --- |
| `baseUrl` | `https://betty.collibra.dev` | The BETTY server. Must be `https`. The plugin calls `<baseUrl>/mcp`. |

Change it with `bb plugin config betty set baseUrl https://...`.

## Status

- The PESTO client reads the run list, one run's nodes, and artifacts.
- Sign-in is not there yet, so the plugin shows "Sign in to BETTY" and makes no calls.
- A thread panel tab "BETTY run" exists and shows a placeholder.

## Develop

```bash
bun install
bun run typecheck
bun run test
bun run build
```
