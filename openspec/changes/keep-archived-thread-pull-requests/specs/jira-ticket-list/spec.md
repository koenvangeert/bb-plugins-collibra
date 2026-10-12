## ADDED Requirements

### Requirement: Saved pull request per linked thread
The plugin SHALL save the last pull request it saw for each linked thread. When BB returns no pull request for the thread, the ticket row SHALL show the saved one.

#### Scenario: Archived thread keeps its PR
- **WHEN** the page saw PR #412 on a thread, and the thread is then archived
- **THEN** the row still shows `#412` next to that thread

#### Scenario: PR state changes
- **WHEN** BB returns a PR that differs from the saved one
- **THEN** the row shows the PR from BB, and the plugin saves it
