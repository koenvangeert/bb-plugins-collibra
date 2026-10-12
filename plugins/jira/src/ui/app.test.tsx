// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot, type CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Filter } from "../filterFields";
import type { ThreadLinkResult, TicketList, TicketTab } from "../rpc";
import { TICKET_LIMIT } from "../tickets";


const ticket = (key: string, summary: string, status: string, threads: TicketTab["tickets"][number]["threads"] = []) => ({
  key,
  summary,
  status,
  statusCategory: "indeterminate",
  issueType: "Story",
  url: `https://example.atlassian.net/browse/${key}`,
  threads,
});

const tab = (overrides: Partial<TicketTab> = {}): TicketTab => ({
  id: 1,
  name: "My tickets",
  jql: "assignee = currentUser()",
  filters: [],
  tickets: [
    ticket("ABC-12", "Fix login", "In Progress", [
      { threadId: "thr_1", title: "Fix login thread", archived: false, pullRequest: null },
      { threadId: "thr_2", title: "Old attempt", archived: true, pullRequest: null },
    ]),
    ticket("ABC-40", "Add export", "To Do"),
  ],
  refreshedAt: Date.now() - 120_000,
  error: null,
  limitReached: false,
  fieldValues: {
    status: [
      { label: "In Progress", jql: '"In Progress"' },
      { label: "In Review", jql: '"In Review"' },
      { label: "(empty)", jql: "EMPTY" },
    ],
  },
  valuesLimitReached: false,
  ...overrides,
});

const list = (overrides: Partial<TicketTab> = {}, rest: Partial<TicketList> = {}): TicketList => ({
  tabs: [tab(overrides)],
  health: "ok",
  refreshing: false,
  ...rest,
});

const WARNING = tab({ id: 2, name: "Warning", jql: "duedate < now()", tickets: [ticket("ABC-77", "Late one", "To Do")] });

type RpcHandlers = NonNullable<NonNullable<Parameters<typeof renderSlot>[2]>["rpc"]>;

let app: CapturedPluginApp;

beforeAll(async () => {
  app = await loadPluginApp(() => import("../../app"));
});

afterEach(() => cleanup());

type PullRequests = NonNullable<NonNullable<Parameters<typeof renderSlot>[2]>["sidebarPullRequests"]>;

function renderPage(rpc: RpcHandlers, sidebarPullRequests: PullRequests = {}, threads: PluginSidebarThread[] = []) {
  return renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc, openUrl: () => true, sidebarPullRequests, sidebarThreads: { threads } });
}

const sidebarThread = (id: string, overrides: Partial<PluginSidebarThread> = {}) =>
  ({ id, status: "idle", hasPendingInteraction: false, indicator: "none", ...overrides }) as PluginSidebarThread;

const pullRequest = (number: number, state: PullRequests[string]["state"]): PullRequests[string] => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  state,
  attention: "none",
});

const savedPullRequest = (number: number, state: PullRequests[string]["state"]) => {
  const { attention: _, ...saved } = pullRequest(number, state);
  return saved;
};

const withSavedPullRequest = (saved: ReturnType<typeof savedPullRequest>) =>
  list({
    tickets: [
      ticket("ABC-12", "Fix login", "In Progress", [
        { threadId: "thr_1", title: "Fix login thread", archived: true, pullRequest: saved },
      ]),
    ],
  });

describe("Jira page", () => {
  it("shows a loading state until the list arrives", async () => {
    const slot = renderPage({ tickets: () => new Promise(() => {}) });

    expect(await slot.findByText("Loading tickets…")).toBeTruthy();
  });

  it("shows tickets with status, linked threads, and archived threads", async () => {
    const slot = renderPage({ tickets: () => list() });

    expect(await slot.findByText("Fix login")).toBeTruthy();
    expect(slot.getByText("In Progress")).toBeTruthy();
    expect(slot.getByText("Fix login thread")).toBeTruthy();
    expect(slot.getByText("(archived)")).toBeTruthy();
    expect(slot.getByText("Refreshed 2 min ago")).toBeTruthy();
    expect(slot.queryByLabelText("Threads for ABC-40")).toBeNull();
    expect(slot.getAllByRole("button", { name: "Start thread" })).toHaveLength(2);
  });

  it("opens a linked thread and the ticket in Jira", async () => {
    const slot = renderPage({ tickets: () => list() });

    const target1 = await slot.findByText("Fix login thread");
    await act(async () => target1.click());
    await act(async () => slot.getByRole("button", { name: "ABC-12" }).click());

    expect(slot.inspection.navigateCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: "thr_1" }),
        expect.objectContaining({ url: "https://example.atlassian.net/browse/ABC-12" }),
      ]),
    );
  });

  it.each(["open", "draft", "merged", "closed"] as const)("shows a %s pull request next to its thread", async (state) => {
    const slot = renderPage({ tickets: () => list() }, { thr_1: pullRequest(412, state) });

    expect(await slot.findByRole("button", { name: `PR #412 (${state})` })).toBeTruthy();
  });

  it("shows no pull request for a thread without one", async () => {
    const slot = renderPage({ tickets: () => list() }, { thr_1: pullRequest(412, "open") });

    await slot.findByText("Old attempt");
    expect(slot.getAllByRole("button", { name: /^PR #/ })).toHaveLength(1);
  });

  it("opens the pull request, not the thread, when its pill is clicked", async () => {
    const slot = renderPage({ tickets: () => list() }, { thr_1: pullRequest(412, "open") });

    const pill = await slot.findByRole("button", { name: "PR #412 (open)" });
    await act(async () => pill.click());

    expect(slot.inspection.navigateCalls).toEqual([
      expect.objectContaining({ url: "https://github.com/acme/app/pull/412" }),
    ]);
  });

  it("shows the saved pull request of a thread when BB has no live one", async () => {
    const slot = renderPage({ tickets: () => withSavedPullRequest(savedPullRequest(300, "merged")) });

    expect(await slot.findByRole("button", { name: "PR #300 (merged)" })).toBeTruthy();
  });

  it("saves a live pull request that differs from the saved one", async () => {
    const savePullRequest = vi.fn(() => ({ ok: true as const }));
    const slot = renderPage(
      { tickets: () => withSavedPullRequest(savedPullRequest(412, "open")), savePullRequest },
      { thr_1: pullRequest(412, "merged") },
    );

    expect(await slot.findByRole("button", { name: "PR #412 (merged)" })).toBeTruthy();
    await vi.waitFor(() =>
      expect(savePullRequest).toHaveBeenCalledWith({ threadId: "thr_1", pullRequest: savedPullRequest(412, "merged") }),
    );
  });

  it("does not save a live pull request that matches the saved one", async () => {
    const savePullRequest = vi.fn(() => ({ ok: true as const }));
    const slot = renderPage(
      { tickets: () => withSavedPullRequest(savedPullRequest(412, "open")), savePullRequest },
      { thr_1: pullRequest(412, "open") },
    );

    await slot.findByRole("button", { name: "PR #412 (open)" });
    await act(async () => {});

    expect(savePullRequest).not.toHaveBeenCalled();
  });

  it.each([
    ["running", { status: "active" }],
    ["needs-you", { status: "active", hasPendingInteraction: true }],
    ["ready", { indicator: "unread-success" }],
    ["failed", { status: "error" }],
    ["idle", {}],
  ] as const)("marks a %s thread on its chip", async (state, overrides) => {
    const slot = renderPage({ tickets: () => list() }, {}, [sidebarThread("thr_1", overrides)]);

    const chip = (await slot.findByText("Fix login thread")).closest("button")!;
    expect(chip.dataset.threadState).toBe(state);
  });

  it("marks a thread missing from the sidebar as idle", async () => {
    const slot = renderPage({ tickets: () => list() });

    const chip = (await slot.findByText("Old attempt")).closest("button")!;
    expect(chip.dataset.threadState).toBe("idle");
  });

  it("says when no ticket matches the query", async () => {
    const slot = renderPage({ tickets: () => list({ tickets: [] }) });

    expect(await slot.findByText("No tickets match the query.")).toBeTruthy();
  });

  it("keeps the last list and shows the error when a refresh failed", async () => {
    const slot = renderPage({ tickets: () => list({ error: "connection reset" }) });

    expect(await slot.findByText(/Refresh failed: connection reset/)).toBeTruthy();
    expect(slot.getByText(/Showing the list from 2 min ago/)).toBeTruthy();
    expect(slot.getByText("Fix login")).toBeTruthy();
  });

  it("tells the user to install acli when it is missing", async () => {
    const slot = renderPage({ tickets: () => list({ tickets: [], refreshedAt: null }, { health: "missing" }) });

    expect(await slot.findByText(/acli is not installed/)).toBeTruthy();
  });

  it("tells the user to log in when acli is logged out", async () => {
    const slot = renderPage({ tickets: () => list({ error: "acli is not logged in" }, { health: "loggedOut" }) });

    expect(await slot.findByText(/acli jira auth login/)).toBeTruthy();
  });

  it("says when the list reached the limit", async () => {
    const slot = renderPage({ tickets: () => list({ limitReached: true }) });

    expect(await slot.findByText(new RegExp(`first ${TICKET_LIMIT} tickets. Edit the tab`))).toBeTruthy();
  });

  it("shows each tab with its ticket count, and the tickets of the picked tab", async () => {
    const slot = renderPage({ tickets: () => ({ ...list(), tabs: [tab(), WARNING, tab({ id: 3, name: "New", refreshedAt: null, tickets: [] })] }) });

    expect(await slot.findByRole("tab", { name: "My tickets (2)" })).toBeTruthy();
    expect(slot.getByRole("tab", { name: "New" })).toBeTruthy();
    expect(slot.queryByText("Late one")).toBeNull();

    await act(async () => slot.getByRole("tab", { name: "Warning (1)" }).click());

    expect(slot.getByRole("tab", { name: "Warning (1)" }).getAttribute("aria-selected")).toBe("true");
    expect(slot.getByText("Late one")).toBeTruthy();
    expect(slot.queryByText("Fix login")).toBeNull();
  });

  it("shows the error of one tab only on that tab", async () => {
    const slot = renderPage({ tickets: () => ({ ...list(), tabs: [tab(), { ...WARNING, error: "bad JQL" }] }) });

    await slot.findByText("Fix login");
    expect(slot.queryByText(/Refresh failed/)).toBeNull();

    await act(async () => slot.getByRole("tab", { name: "Warning (1)" }).click());

    expect(slot.getByText(/Refresh failed: bad JQL/)).toBeTruthy();
  });

  it("offers to add a tab when there are no tabs", async () => {
    const slot = renderPage({ tickets: () => list({}, { tabs: [] }) });

    expect(await slot.findByText(/No tabs yet/)).toBeTruthy();
    expect(slot.getAllByRole("button", { name: "Add tab" })).toHaveLength(1);
  });

  it("refreshes now and shows the new list", async () => {
    let current = list();
    const refresh = vi.fn(() => {
      current = list({ tickets: [ticket("ABC-99", "Brand new", "To Do")], refreshedAt: Date.now() });
      return current;
    });
    const slot = renderPage({ tickets: () => current, refresh });

    const target2 = await slot.findByRole("button", { name: "Refresh" });
    await act(async () => target2.click());

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await slot.findByText("Brand new")).toBeTruthy();
  });
});

describe("tab dialogs", () => {
  async function openAdd(slot: ReturnType<typeof renderPage>) {
    const add = await slot.findByRole("button", { name: "Add tab" });
    await act(async () => add.click());
    return {
      name: (await screen.findByLabelText("Name")) as HTMLInputElement,
      jql: screen.getByLabelText("JQL query") as HTMLTextAreaElement,
      save: screen.getByRole("button", { name: "Save" }) as HTMLButtonElement,
    };
  }

  it("needs a name and a query before it saves", async () => {
    const { name, jql, save } = await openAdd(renderPage({ tickets: () => list() }));

    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "Warning" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(jql, { target: { value: "duedate < now()" } });
    expect(save.disabled).toBe(false);
  });

  it("adds a tab and shows it selected", async () => {
    const saveTab = vi.fn(() => ({ ...list(), tabs: [tab(), WARNING] }));
    const slot = renderPage({ tickets: () => list(), saveTab });
    const { name, jql, save } = await openAdd(slot);

    fireEvent.change(name, { target: { value: "Warning" } });
    fireEvent.change(jql, { target: { value: "duedate < now()" } });
    await act(async () => save.click());

    expect(saveTab).toHaveBeenCalledWith({ name: "Warning", jql: "duedate < now()" });
    expect(screen.queryByLabelText("JQL query")).toBeNull();
    expect(slot.getByRole("tab", { name: "Warning (1)" }).getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the dialog open and shows the error of a bad query", async () => {
    const saveTab = vi.fn(() => {
      throw new Error("Error in the JQL Query");
    });
    const { name, jql, save } = await openAdd(renderPage({ tickets: () => list(), saveTab }));

    fireEvent.change(name, { target: { value: "Broken" } });
    fireEvent.change(jql, { target: { value: "status = = Done" } });
    await act(async () => save.click());

    expect(await screen.findByText("Error in the JQL Query")).toBeTruthy();
    expect(screen.getByLabelText("JQL query")).toBeTruthy();
  });

  it("cannot be cancelled while the query runs", async () => {
    const { name, jql, save } = await openAdd(renderPage({ tickets: () => list(), saveTab: () => new Promise(() => {}) }));
    fireEvent.change(name, { target: { value: "Slow" } });
    fireEvent.change(jql, { target: { value: "q" } });

    await act(async () => save.click());

    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Checking query…" })).toBeTruthy();
  });

  it("edits the selected tab", async () => {
    const saveTab = vi.fn(() => list({ name: "Mine" }));
    const slot = renderPage({ tickets: () => list(), saveTab });
    const edit = await slot.findByRole("button", { name: "Edit tab" });
    await act(async () => edit.click());

    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.value).toBe("My tickets");
    fireEvent.change(name, { target: { value: "Mine" } });
    await act(async () => screen.getByRole("button", { name: "Save" }).click());

    expect(saveTab).toHaveBeenCalledWith({ id: 1, name: "Mine", jql: "assignee = currentUser()" });
    expect(await slot.findByRole("tab", { name: "Mine (2)" })).toBeTruthy();
  });

  it("deletes the selected tab after a confirmation", async () => {
    const deleteTab = vi.fn(() => list({}, { tabs: [WARNING] }));
    const slot = renderPage({ tickets: () => ({ ...list(), tabs: [tab(), WARNING] }), deleteTab });
    const remove = await slot.findByRole("button", { name: "Delete tab" });
    await act(async () => remove.click());

    expect(await screen.findByText("Delete tab My tickets?")).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: "Delete" }).click());

    expect(deleteTab).toHaveBeenCalledWith({ id: 1 });
    expect(slot.queryByRole("tab", { name: "My tickets (2)" })).toBeNull();
    expect(slot.getByRole("tab", { name: "Warning (1)" }).getAttribute("aria-selected")).toBe("true");
  });

  it("deletes nothing when the confirmation is cancelled", async () => {
    const deleteTab = vi.fn();
    const slot = renderPage({ tickets: () => list(), deleteTab });
    const remove = await slot.findByRole("button", { name: "Delete tab" });
    await act(async () => remove.click());

    await act(async () => screen.getByRole("button", { name: "Cancel" }).click());

    expect(deleteTab).not.toHaveBeenCalled();
    expect(slot.getByRole("tab", { name: "My tickets (2)" })).toBeTruthy();
  });
});

describe("tab filters", () => {
  const statusFilter: Filter = {
    field: "status",
    label: "Status",
    operator: "in",
    values: [
      { label: "To Do", jql: '"To Do"' },
      { label: "In Review", jql: '"In Review"' },
    ],
  };
  const assigneeFilter: Filter = { field: "assignee", label: "Assignee", operator: "not in", values: [{ label: "Ann Lee", jql: '"712020:ann"' }] };

  async function openAdd(slot: ReturnType<typeof renderPage>) {
    const add = await slot.findByRole("button", { name: "Add filter" });
    await act(async () => add.click());
    return {
      field: (await screen.findByLabelText("Field")) as HTMLSelectElement,
      apply: screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement,
    };
  }

  it("shows one chip per filter", async () => {
    const slot = renderPage({ tickets: () => list({ filters: [statusFilter, assigneeFilter] }) });

    expect(await slot.findByRole("button", { name: "Status: To Do, In Review" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Assignee not: Ann Lee" })).toBeTruthy();
  });

  it("removes a filter from its chip and shows the new list", async () => {
    const setFilters = vi.fn(() => list({ filters: [assigneeFilter], tickets: [ticket("ABC-77", "Late one", "To Do")] }));
    const slot = renderPage({ tickets: () => list({ filters: [statusFilter, assigneeFilter] }), setFilters });

    const remove = await slot.findByRole("button", { name: "Remove filter Status" });
    await act(async () => remove.click());

    expect(setFilters).toHaveBeenCalledWith({ id: 1, filters: [assigneeFilter] });
    expect(await slot.findByRole("tab", { name: "My tickets (1)" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Status: To Do, In Review" })).toBeNull();
  });

  it("offers only the system fields", async () => {
    const { field } = await openAdd(renderPage({ tickets: () => list() }));

    expect(Array.from(field.options, (option) => option.text)).toEqual([
      "Status",
      "Type",
      "Priority",
      "Assignee",
      "Reporter",
      "Creator",
      "Labels",
      "Fix versions",
      "Affects versions",
      "Components",
      "Resolution",
      "Project",
      "Parent",
    ]);
  });

  it("adds a filter with values from the tab", async () => {
    const setFilters = vi.fn(() => list({ filters: [statusFilter] }));
    const slot = renderPage({ tickets: () => list(), setFilters });
    const { apply } = await openAdd(slot);

    expect(apply.disabled).toBe(true);
    await act(async () => screen.getByRole("checkbox", { name: "In Review" }).click());
    await act(async () => screen.getByRole("button", { name: "not in" }).click());
    await act(async () => apply.click());

    expect(setFilters).toHaveBeenCalledWith({
      id: 1,
      filters: [{ field: "status", label: "Status", operator: "not in", values: [{ label: "In Review", jql: '"In Review"' }] }],
    });
    expect(screen.queryByLabelText("Field")).toBeNull();
  });

  it("adds a filter with typed values for a field without a dropdown", async () => {
    const setFilters = vi.fn(() => list());
    const { field, apply } = await openAdd(renderPage({ tickets: () => list(), setFilters }));

    fireEvent.change(field, { target: { value: "fixVersions" } });
    const value = screen.getByLabelText("Value") as HTMLInputElement;
    fireEvent.change(value, { target: { value: 'v "26.10"' } });
    fireEvent.keyDown(value, { key: "Enter" });
    await act(async () => apply.click());

    expect(setFilters).toHaveBeenCalledWith({
      id: 1,
      filters: [{ field: "fixVersions", label: "Fix versions", operator: "in", values: [{ label: 'v "26.10"', jql: '"v \\"26.10\\""' }] }],
    });
  });

  it("adds the typed value that is still in the input on Apply", async () => {
    const setFilters = vi.fn(() => list());
    const { field, apply } = await openAdd(renderPage({ tickets: () => list(), setFilters }));

    fireEvent.change(field, { target: { value: "components" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "Search" } });
    await act(async () => apply.click());

    expect(setFilters).toHaveBeenCalledWith({
      id: 1,
      filters: [{ field: "components", label: "Components", operator: "in", values: [{ label: "Search", jql: '"Search"' }] }],
    });
  });

  it("says when the values come from a cut list", async () => {
    await openAdd(renderPage({ tickets: () => list({ valuesLimitReached: true }) }));

    expect(screen.getByText(new RegExp(`first ${TICKET_LIMIT} tickets`))).toBeTruthy();
  });

  it("keeps the dialog open and shows the error of a bad filter", async () => {
    const setFilters = vi.fn(() => {
      throw new Error("The value 'x' does not exist for the field 'fixVersion'.");
    });
    const { field, apply } = await openAdd(renderPage({ tickets: () => list(), setFilters }));
    fireEvent.change(field, { target: { value: "fixVersions" } });
    const value = screen.getByLabelText("Value");
    fireEvent.change(value, { target: { value: "x" } });
    fireEvent.keyDown(value, { key: "Enter" });

    await act(async () => apply.click());

    expect(await screen.findByText(/does not exist for the field/)).toBeTruthy();
    expect(screen.getByLabelText("Field")).toBeTruthy();
  });

  it("edits a filter from its chip with its values checked", async () => {
    const setFilters = vi.fn(() => list());
    const slot = renderPage({ tickets: () => list({ filters: [statusFilter, assigneeFilter] }), setFilters });
    const chip = await slot.findByRole("button", { name: "Status: To Do, In Review" });
    await act(async () => chip.click());

    expect((screen.getByRole("checkbox", { name: "To Do" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "In Review" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "In Progress" }) as HTMLInputElement).checked).toBe(false);
    await act(async () => screen.getByRole("checkbox", { name: "To Do" }).click());
    await act(async () => screen.getByRole("button", { name: "Apply" }).click());

    expect(setFilters).toHaveBeenCalledWith({ id: 1, filters: [{ ...statusFilter, values: [statusFilter.values[1]] }, assigneeFilter] });
  });
});

describe("Start thread dialog", () => {
  const rpc = (startThread = vi.fn(() => ({ threadId: "thr_new" }))) => ({
    tickets: () => list(),
    projects: () => [
      { id: "P-1", name: "catalog" },
      { id: "P-2", name: "arbor" },
    ],
    ticket: () => ({ ...ticket("ABC-40", "Add export", "To Do"), description: "Export as CSV.", prompt: "Work on Jira ticket ABC-40: Add export\n\nExport as CSV." }),
    startThread,
  });

  async function openDialog(slot: ReturnType<typeof renderPage>) {
    const [, startExport] = await slot.findAllByRole("button", { name: "Start thread" });
    await act(async () => startExport!.click());
    return (await screen.findByLabelText("First prompt")) as HTMLTextAreaElement;
  }

  it("prefills the prompt from the ticket and needs a project before it starts", async () => {
    const slot = renderPage(rpc());

    const prompt = await openDialog(slot);

    await vi.waitFor(() => expect(prompt.value).toContain("Export as CSV."));
    const start = screen.getAllByRole("button", { name: "Start thread" }).at(-1) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  it("starts a linked thread with the edited prompt and opens it", async () => {
    const startThread = vi.fn(() => ({ threadId: "thr_new" }));
    const slot = renderPage(rpc(startThread));
    const prompt = await openDialog(slot);
    await vi.waitFor(() => expect(prompt.value).not.toBe(""));
    const project = (await screen.findByLabelText("Project")) as HTMLSelectElement;
    await vi.waitFor(() => expect(project.disabled).toBe(false));

    fireEvent.change(project, { target: { value: "P-2" } });
    fireEvent.change(prompt, { target: { value: "Only do the CSV part" } });
    await act(async () => (screen.getAllByRole("button", { name: "Start thread" }).at(-1) as HTMLButtonElement).click());

    expect(startThread).toHaveBeenCalledWith({ projectId: "P-2", key: "ABC-40", prompt: "Only do the CSV part" });
    await vi.waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ threadId: "thr_new" })));
  });

  it("starts nothing when cancelled", async () => {
    const startThread = vi.fn(() => ({ threadId: "thr_new" }));
    const slot = renderPage(rpc(startThread));
    await openDialog(slot);

    await act(async () => screen.getByRole("button", { name: "Cancel" }).click());

    expect(screen.queryByLabelText("First prompt")).toBeNull();
    expect(startThread).not.toHaveBeenCalled();
  });
});

describe("thread header", () => {
  const props = { threadId: "thr_1", projectId: "P-1", isCompactViewport: false };
  const linked: ThreadLinkResult = {
    issueKey: "ABC-12",
    ticket: { key: "ABC-12", summary: "Fix login", status: "In Progress", statusCategory: "indeterminate", issueType: "Bug", url: "https://example.atlassian.net/browse/ABC-12" },
    error: null,
  };
  const unlinked: ThreadLinkResult = { issueKey: null, ticket: null, error: null };

  function renderHeader(rpc: RpcHandlers) {
    return renderSlot(app.threadHeaderActions[0]!, props, { rpc, openUrl: () => true });
  }

  it("shows nothing while the link loads", () => {
    const slot = renderHeader({ threadLink: () => new Promise(() => {}) });

    expect(slot.container.textContent).toBe("");
  });

  it("shows the linked ticket key and status, and its details on click, and closes after opening Jira", async () => {
    const slot = renderHeader({ threadLink: () => linked });

    const target3 = await slot.findByRole("button", { name: "ABC-12 · In Progress" });
    await act(async () => target3.click());

    expect(await screen.findByText("ABC-12: Fix login")).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: "Open in Jira" }).click());
    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ url: "https://example.atlassian.net/browse/ABC-12" }));
    expect(screen.queryByText("ABC-12: Fix login")).toBeNull();
  });

  it("keeps the key and marks the status unknown when the ticket cannot be read", async () => {
    const slot = renderHeader({ threadLink: () => ({ issueKey: "XYZ-7", ticket: null, error: "Work item does not exist" }) });

    const target4 = await slot.findByRole("button", { name: "XYZ-7 · Status unknown" });
    await act(async () => target4.click());

    expect(await screen.findByText(/Could not read the ticket: Work item does not exist/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy();
  });

  it("unlinks a thread", async () => {
    let current = linked;
    const unlink = vi.fn(() => {
      current = unlinked;
      return { ok: true };
    });
    const slot = renderHeader({ threadLink: () => current, unlink });
    const target5 = await slot.findByRole("button", { name: "ABC-12 · In Progress" });
    await act(async () => target5.click());

    const target6 = await screen.findByRole("button", { name: "Unlink" });
    await act(async () => target6.click());

    expect(unlink).toHaveBeenCalledWith({ threadId: "thr_1" });
    expect(await slot.findByRole("button", { name: "Link Jira" })).toBeTruthy();
  });

  it("links a ticket picked from the tickets of all tabs", async () => {
    let current = unlinked;
    const link = vi.fn(() => (current = linked));
    const pickerTickets = () => [...tab().tickets, ...WARNING.tickets].map(({ threads: _threads, ...rest }) => rest);
    const slot = renderHeader({ threadLink: () => current, pickerTickets, link });
    const target7 = await slot.findByRole("button", { name: "Link Jira" });
    await act(async () => target7.click());

    expect(await screen.findByRole("button", { name: /ABC-77\s*Late one/ })).toBeTruthy();
    const target8 = screen.getByRole("button", { name: /ABC-12\s*Fix login/ });
    await act(async () => target8.click());

    expect(link).toHaveBeenCalledWith({ threadId: "thr_1", key: "ABC-12" });
    expect(await slot.findByRole("button", { name: "ABC-12 · In Progress" })).toBeTruthy();
  });

  it("links a typed key and shows the error of an unknown one", async () => {
    const link = vi.fn(() => {
      throw new Error("Work item NOPE-1 does not exist");
    });
    const slot = renderHeader({ threadLink: () => unlinked, pickerTickets: () => [], link });
    const target9 = await slot.findByRole("button", { name: "Link Jira" });
    await act(async () => target9.click());

    fireEvent.change(await screen.findByLabelText("Ticket key"), { target: { value: "NOPE-1" } });
    await act(async () => screen.getByRole("button", { name: "Link" }).click());

    expect(link).toHaveBeenCalledWith({ threadId: "thr_1", key: "NOPE-1" });
    expect(await screen.findByText("Work item NOPE-1 does not exist")).toBeTruthy();
  });
});
