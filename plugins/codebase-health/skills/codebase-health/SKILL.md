---
name: codebase-health
description: Explains the Codebase Health plugin's pull request figures (merged per day, reviewer comments, time to merge, BETTY share) and its repositories setting. Use when the user asks how a figure is counted, why a repository shows an error, or how to track another repository.
---

# Codebase Health

The plugin reads merged pull requests from GitHub with `gh` on the bb server. It shows them on the `Codebase health` sidebar page.

## Setting

| Command | Effect |
| --- | --- |
| `bb plugin config codebase-health set repositories "owner/a,owner/b"` | The repositories to track. A change starts a sync at once. |

## How figures are counted

- Only merged pull requests count.
- A BETTY pull request has the `betty-pr-factory-app` label.
- A reviewer comment is a conversation comment, a review with a summary, or an inline review comment by someone other than the author. Bots and `collibra-cicd` do not count.
- A team is a GitHub team named in the repository's CODEOWNERS. Its pull requests are the ones its current members wrote. Teams are read every 6 hours. The Team menu also has **Me**, the pull requests of the `gh` user. With a team picked, the tiles and trend charts compare it with all teams.
- Time to merge runs from opening to merge, without weekend hours. The tile shows the median.

## Why a figure looks wrong

- **"Reading history from GitHub".** The first sync reads 98 days, about 4 seconds per day per repository. Figures fill in while it runs.
- **"Cannot read <repo> from GitHub".** `gh` is not signed in, cannot see the repository, or hit a rate limit. Run `gh auth status` on the bb server. The next sync, within 30 minutes, tries the failed days again.
- **A BETTY pull request counts as "others".** It has no `betty-pr-factory-app` label.
