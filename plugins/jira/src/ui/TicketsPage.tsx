import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRpc,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { INSTALL_HINT, LOGIN_HINT } from "../acliErrors";
import type { rpcContract, TicketList, TicketTab } from "../rpc";
import { TICKET_LIMIT } from "../tickets";
import { errorMessage } from "../errorMessage";
import { FilterBar } from "./FilterBar";
import { FilterDialog } from "./FilterDialog";
import { formatRefreshTime } from "./format";
import { StartThreadDialog } from "./StartThreadDialog";
import { DeleteTabDialog, TabDialog } from "./TabDialog";
import { usePolled } from "./usePolled";
import "./threadStatus.css";

type TicketRow = TicketTab["tickets"][number];
type LinkedThread = TicketRow["threads"][number];
type SavedPullRequest = NonNullable<LinkedThread["pullRequest"]>;

type TabAction = { kind: "add" } | { kind: "edit" | "delete"; tab: TicketTab } | { kind: "filter"; tabId: number; index: number | null };

const STATUS_GROUPS = [
  { category: "indeterminate", title: "In progress", dot: "bg-sky-500", pill: "bg-sky-500/12 text-sky-600 dark:text-sky-400" },
  { category: "new", title: "To do", dot: "bg-muted-foreground", pill: "bg-muted text-muted-foreground" },
  { category: "done", title: "Done", dot: "bg-emerald-500", pill: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" },
] as const;

const OTHER_GROUP = { category: "", title: "Other", dot: "bg-muted-foreground/50", pill: "bg-muted text-muted-foreground" };

function groupFor(category: string) {
  return STATUS_GROUPS.find((group) => group.category === category) ?? OTHER_GROUP;
}

function issueTypeIcon(issueType: string): { name: string; className: string } {
  const type = issueType.toLowerCase();
  if (type.includes("bug")) return { name: "Bug", className: "text-red-500" };
  if (type.includes("epic")) return { name: "Zap", className: "text-violet-500" };
  if (type.includes("story")) return { name: "FileText", className: "text-emerald-500" };
  if (type.includes("sub")) return { name: "CornerDownRight", className: "text-sky-500" };
  return { name: "CircleCheck", className: "text-sky-500" };
}

function Banner({ tone, children }: { tone: "warning" | "error"; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
        tone === "error"
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-amber-500/40 bg-amber-500/8 text-foreground",
      )}
    >
      <Icon
        name={tone === "error" ? "AlertCircle" : "AlertTriangle"}
        className={cn("mt-0.5 size-4", tone === "warning" && "text-amber-500")}
        aria-hidden
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function HealthBanner({ health, tab }: { health: TicketList["health"]; tab: TicketTab }) {
  if (health === "missing") return <Banner tone="warning">acli is not installed. {INSTALL_HINT}</Banner>;
  if (health === "loggedOut") return <Banner tone="warning">acli is not logged in to Jira. {LOGIN_HINT}</Banner>;
  if (!tab.error) return null;
  return (
    <Banner tone="error">
      Refresh failed: {tab.error}
      {tab.refreshedAt !== null ? ` Showing the list from ${formatRefreshTime(tab.refreshedAt)}.` : null}
    </Banner>
  );
}

function EmptyState({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon name={icon} className={cn("size-5 text-muted-foreground", icon === "Spinner" && "animate-spin")} aria-hidden />
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

const PULL_REQUEST_STATES = {
  open: { icon: "GitPullRequest", className: "border-emerald-500/30 text-emerald-600 dark:text-emerald-400" },
  draft: { icon: "GitPullRequestDraft", className: "border-border text-muted-foreground" },
  merged: { icon: "GitMerge", className: "border-violet-500/30 text-violet-600 dark:text-violet-400" },
  closed: { icon: "GitPullRequestClosed", className: "border-red-500/30 text-red-600 dark:text-red-400" },
} as const;

type ThreadState = "running" | "needs-you" | "ready" | "failed" | "idle";

const THREAD_STATE_LABELS: Record<ThreadState, string> = {
  running: "Running",
  "needs-you": "Needs you",
  ready: "Ready",
  failed: "Failed",
  idle: "Idle",
};

function threadStateOf(thread: PluginSidebarThread | undefined): ThreadState {
  if (!thread) return "idle";
  if (thread.hasPendingInteraction) return "needs-you";
  if (thread.status === "error" || thread.indicator === "unread-error") return "failed";
  if (thread.status !== "idle") return "running";
  if (thread.indicator === "unread-success") return "ready";
  return "idle";
}

function samePullRequest(a: SavedPullRequest | null, b: SavedPullRequest | null) {
  return a?.number === b?.number && a?.title === b?.title && a?.url === b?.url && a?.state === b?.state;
}

function useLatestPullRequest(thread: LinkedThread): SavedPullRequest | null {
  const rpc = useRpc<typeof rpcContract>();
  const { pullRequest: live } = experimental_useSidebarThreadPullRequest(thread.threadId);
  const latest = live ? { number: live.number, title: live.title, url: live.url, state: live.state } : null;
  const unsaved = latest && !samePullRequest(latest, thread.pullRequest) ? latest : null;
  useEffect(() => {
    if (unsaved) rpc.call("savePullRequest", { threadId: thread.threadId, pullRequest: unsaved }).catch(() => {});
  }, [rpc, thread.threadId, unsaved?.number, unsaved?.title, unsaved?.url, unsaved?.state]);
  return latest ?? thread.pullRequest;
}

function ThreadChip({ thread }: { thread: LinkedThread }) {
  const navigate = useBbNavigate();
  const pullRequest = useLatestPullRequest(thread);
  const { threads } = experimental_useSidebarThreads();
  const state = threadStateOf(threads.find(({ id }) => id === thread.threadId));
  const prState = pullRequest ? PULL_REQUEST_STATES[pullRequest.state] : null;
  return (
    <li className="inline-flex max-w-full items-center gap-1">
      <button
        type="button"
        className={cn(
          "thread-chip inline-flex max-w-72 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-xs hover:bg-state-hover",
          thread.archived && "opacity-60",
        )}
        data-thread-state={state}
        title={THREAD_STATE_LABELS[state]}
        onClick={() => navigate.toThread(thread.threadId)}
      >
        <Icon name="MessageSquare" className="size-3 text-muted-foreground" aria-hidden />
        <span className="truncate">{thread.title}</span>
        {thread.archived ? <span className="text-muted-foreground">(archived)</span> : null}
      </button>
      {pullRequest && prState ? (
        <button
          type="button"
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 font-mono text-xs hover:bg-state-hover",
            prState.className,
          )}
          title={pullRequest.title}
          aria-label={`PR #${pullRequest.number} (${pullRequest.state})`}
          onClick={() => navigate.openUrl(pullRequest.url)}
        >
          <Icon name={prState.icon} className="size-3" aria-hidden />#{pullRequest.number}
        </button>
      ) : null}
    </li>
  );
}

function TicketItem({ ticket, onStart }: { ticket: TicketRow; onStart(): void }) {
  const navigate = useBbNavigate();
  const type = issueTypeIcon(ticket.issueType);
  return (
    <li className="group flex gap-3 px-4 py-3 transition-colors hover:bg-state-hover/60">
      <Icon name={type.name} className={cn("mt-0.5 size-4", type.className)} aria-label={ticket.issueType || undefined} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="shrink-0 cursor-pointer font-mono text-xs text-muted-foreground hover:text-primary hover:underline disabled:cursor-default disabled:no-underline"
            title="Open in Jira"
            onClick={() => navigate.openUrl(ticket.url)}
            disabled={!ticket.url}
          >
            {ticket.key}
          </button>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              groupFor(ticket.statusCategory).pill,
            )}
          >
            {ticket.status}
          </span>
        </div>
        <span className="text-sm font-medium leading-snug text-foreground">{ticket.summary}</span>
        {ticket.threads.length > 0 ? (
          <ul aria-label={`Threads for ${ticket.key}`} className="m-0 flex list-none flex-wrap gap-1.5 p-0 pt-0.5">
            {ticket.threads.map((thread) => (
              <ThreadChip key={thread.threadId} thread={thread} />
            ))}
          </ul>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 self-start opacity-70 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={onStart}
      >
        <Icon name="MessageSquarePlus" aria-hidden />
        Start thread
      </Button>
    </li>
  );
}

function TicketGroups({ tickets, onStart }: { tickets: TicketRow[]; onStart(ticket: TicketRow): void }) {
  const groups = [...STATUS_GROUPS, OTHER_GROUP]
    .map((group) => ({ ...group, tickets: tickets.filter((ticket) => groupFor(ticket.statusCategory) === group) }))
    .filter((group) => group.tickets.length > 0);
  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group.title} aria-label={group.title} className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span className={cn("size-2 rounded-full", group.dot)} aria-hidden />
            {group.title}
            <span className="font-normal tabular-nums">{group.tickets.length}</span>
          </h2>
          <ul className="m-0 list-none divide-y divide-border overflow-hidden rounded-xl border border-border bg-card p-0">
            {group.tickets.map((ticket) => (
              <TicketItem key={ticket.key} ticket={ticket} onStart={() => onStart(ticket)} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function tabLabel(tab: TicketTab): string {
  return tab.refreshedAt === null ? tab.name : `${tab.name} (${tab.tickets.length})`;
}

function TabBar({
  tabs,
  selected,
  onSelect,
  onEdit,
  onDelete,
}: {
  tabs: TicketTab[];
  selected: TicketTab;
  onSelect(tab: TicketTab): void;
  onEdit(): void;
  onDelete(): void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border">
      <div role="tablist" aria-label="Ticket tabs" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === selected.id}
            className={cn(
              "-mb-px shrink-0 cursor-pointer border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
              tab.id === selected.id
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onSelect(tab)}
          >
            {tabLabel(tab)}
          </button>
        ))}
      </div>
      <Button size="sm" variant="ghost" aria-label="Edit tab" onClick={onEdit}>
        <Icon name="Edit" aria-hidden />
      </Button>
      <Button size="sm" variant="ghost" aria-label="Delete tab" onClick={onDelete}>
        <Icon name="Trash2" aria-hidden />
      </Button>
    </div>
  );
}

function TabPanel({
  tab,
  health,
  onStart,
  onChanged,
  onEditFilter,
}: {
  tab: TicketTab;
  health: TicketList["health"];
  onStart(ticket: TicketRow): void;
  onChanged(list: TicketList): void;
  onEditFilter(index: number | null): void;
}) {
  return (
    <div role="tabpanel" aria-label={tab.name} className="flex flex-col gap-5">
      <FilterBar key={tab.id} tab={tab} onChanged={onChanged} onEdit={onEditFilter} />
      <HealthBanner health={health} tab={tab} />
      {tab.tickets.length === 0 && tab.refreshedAt !== null ? (
        <EmptyState icon="CircleCheck">No tickets match the query.</EmptyState>
      ) : null}
      {tab.tickets.length === 0 && tab.refreshedAt === null && health === "ok" && !tab.error ? (
        <EmptyState icon="Spinner">Reading tickets from Jira…</EmptyState>
      ) : null}
      {tab.tickets.length > 0 ? <TicketGroups tickets={tab.tickets} onStart={onStart} /> : null}
      {tab.limitReached ? (
        <p className="text-center text-xs text-muted-foreground">
          Showing the first {TICKET_LIMIT} tickets. Edit the tab to narrow the query.
        </p>
      ) : null}
    </div>
  );
}

function NoTabs({ onAdd }: { onAdd(): void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <p role="status" className="m-0 text-sm text-muted-foreground">
        No tabs yet. Add a tab with a JQL query to see its tickets.
      </p>
      <Button size="sm" onClick={onAdd}>
        <Icon name="Plus" aria-hidden />
        Add tab
      </Button>
    </div>
  );
}

export function TicketsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => rpc.call("tickets", null), [rpc]);
  const { value: list, error: loadError, set: setList } = usePolled(load);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [starting, setStarting] = useState<TicketRow | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [action, setAction] = useState<TabAction | null>(null);
  const busy = refreshing || Boolean(list?.refreshing);
  const selected = list ? (list.tabs.find((tab) => tab.id === selectedId) ?? list.tabs[0] ?? null) : null;
  const filterTab = action?.kind === "filter" ? list?.tabs.find((tab) => tab.id === action.tabId) : undefined;

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      setList(await rpc.call("refresh", null));
    } catch (cause) {
      setRefreshError(errorMessage(cause));
    } finally {
      setRefreshing(false);
    }
  };

  const closeAction = (open: boolean) => !open && setAction(null);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <header className="flex items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-[#0c66e4]/10">
              <Icon name="jira/jira" fallback="ListTodo" className="size-5" aria-hidden />
            </div>
            <div className="flex flex-col">
              <h1 className="text-base font-semibold leading-tight">Jira tickets</h1>
              <span className="text-xs text-muted-foreground">
                {selected?.refreshedAt ? `Refreshed ${formatRefreshTime(selected.refreshedAt)}` : "Tickets from your Jira queries"}
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            {list && list.tabs.length > 0 ? (
              <Button size="sm" variant="outline" onClick={() => setAction({ kind: "add" })}>
                <Icon name="Plus" aria-hidden />
                Add tab
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
              <Icon name="ArrowReloadHorizontal" className={cn(busy && "animate-spin")} aria-hidden />
              {busy ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </header>
        {refreshError || (loadError && !list) ? <Banner tone="error">{refreshError ?? loadError}</Banner> : null}
        {!list ? <EmptyState icon="Spinner">Loading tickets…</EmptyState> : null}
        {list && !selected ? <NoTabs onAdd={() => setAction({ kind: "add" })} /> : null}
        {list && selected ? (
          <>
            <TabBar
              tabs={list.tabs}
              selected={selected}
              onSelect={(tab) => setSelectedId(tab.id)}
              onEdit={() => setAction({ kind: "edit", tab: selected })}
              onDelete={() => setAction({ kind: "delete", tab: selected })}
            />
            <TabPanel
              tab={selected}
              health={list.health}
              onStart={setStarting}
              onChanged={setList}
              onEditFilter={(index) => setAction({ kind: "filter", tabId: selected.id, index })}
            />
          </>
        ) : null}
        {action?.kind === "add" ? (
          <TabDialog
            onSaved={(next) => {
              setList(next);
              setSelectedId(next.tabs.at(-1)?.id ?? null);
            }}
            onOpenChange={closeAction}
          />
        ) : null}
        {action?.kind === "edit" ? <TabDialog tab={action.tab} onSaved={setList} onOpenChange={closeAction} /> : null}
        {action?.kind === "delete" ? <DeleteTabDialog tab={action.tab} onDeleted={setList} onOpenChange={closeAction} /> : null}
        {action?.kind === "filter" && filterTab ? (
          <FilterDialog tab={filterTab} index={action.index} onSaved={setList} onOpenChange={closeAction} />
        ) : null}
        {starting ? (
          <StartThreadDialog
            ticketKey={starting.key}
            summary={starting.summary}
            onOpenChange={(open) => !open && setStarting(null)}
          />
        ) : null}
      </div>
    </div>
  );
}
