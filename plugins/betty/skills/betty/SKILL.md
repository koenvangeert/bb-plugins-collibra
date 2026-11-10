---
name: betty
description: How to start, link and follow a BETTY (PESTO) run from a bb thread with the betty_link_run, betty_status and betty_evidence tools. Use when the user asks to run a ticket with BETTY or PESTO, when a "BETTY run ... needs a decision / failed / finished" message arrives, or when the user asks about a run's status, pull requests, AC evidence or artifacts.
---

# BETTY

The BETTY plugin links one BETTY (PESTO) run to a bb thread. It shows the run in the thread header, the "BETTY run" tab and the "BETTY" page.

## Tools

| Tool | Input | Answer |
| --- | --- | --- |
| `betty_link_run` | `runId` | Links the run to this thread. Checks that the run exists first. |
| `betty_status` | `runId` (optional) | Status, steps done, spend, pull requests, and the steps that need a decision, failed or are running. |
| `betty_evidence` | `runId` (optional) | The acceptance criteria of each finished agent step that checked them: met or NOT MET, evidence, screenshot count, faked backend warning. |
| `betty_evidence` | `taskId` | The artifacts of that step, with their `artifactId`. |
| `betty_evidence` | `artifactId`, `offset` (optional) | One page (3000 chars) of that artifact. The answer gives the next `offset`. |

- Without `runId`, a tool reads the run linked to this thread.
- Each answer is under 4000 chars. It ends with the next call to make.
- These tools need no pesto MCP. They use the user's BETTY sign-in in bb.

## Start a run

1. Start the run with the pesto MCP tools: get the workflow template, show the user the DAG and the cost of each node, and submit only after the user agrees.
2. Right after `pesto_dag_submit` returns, call `betty_link_run` with its `run_id`. Do this again for every resubmit.
3. Stay in this thread. Do not start a new thread.

The "Run with BETTY" button in the thread header sends this request as a prompt.

## Follow a run

- Do not poll, sleep or start a watcher. The plugin checks each linked run every 30 seconds. When the run status changes to needs a decision, failed, cancelled or finished, it sends this thread one message.
- When that message arrives, call `betty_status`. For a failed browser check, call `betty_evidence`.
- Read a step's logs or review findings with `betty_evidence` and its `taskId`, then its `artifactId`.
- The user approves, denies or stops steps in the run detail. These tools only read.

## Errors

- "bb is not signed in to BETTY": the sign-in is missing or expired. Ask the user to sign in from the "BETTY" page or the "BETTY run" tab. The tools work right after, with no restart.
- "This thread has no linked BETTY run": pass `runId`, or call `betty_link_run` first.

## Limits

- A pull request whose base is not `main` can show green CI on a few checks only. The status answer says so.
- Evidence that mentions faked backend data gets a warning. Do not report those criteria as proven.
