## ADDED Requirements

### Requirement: Child threads inherit the link
When a thread is created with a parent thread that is linked to a ticket, the plugin SHALL link the new thread to the same ticket, unless the new thread already has a ticket key.

#### Scenario: Agent starts a child thread
- **WHEN** a thread linked to `ABC-12` starts a child thread with no key
- **THEN** the child thread is linked to `ABC-12` and shows on the `ABC-12` row

#### Scenario: Child thread with its own key
- **WHEN** a child thread starts with key `ABC-40` and its parent is linked to `ABC-12`
- **THEN** the child thread stays linked to `ABC-40`
