import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createExecFileRunner, type AcliRunner } from "./src/acli";
import { MIGRATIONS } from "./src/database";
import { runRefreshLoop } from "./src/refreshLoop";
import { createRpcHandlers, rpcContract } from "./src/rpc";
import { SETTINGS } from "./src/settings";
import { createTabStore } from "./src/tabs";
import { createThreadLinks } from "./src/threadLinks";
import { createTicketService } from "./src/ticketService";

export type { rpcContract } from "./src/rpc";

export const createPlugin = (acli: AcliRunner) => async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETTINGS);
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const tabs = createTabStore(db);
  tabs.seedFirstTab();

  const tickets = createTicketService({
    db,
    tabs,
    acli,
    now: () => Date.now(),
    onHealth: (health, message) => {
      if (health !== "ok" && message) bb.status.needsConfiguration(message);
    },
  });
  const links = createThreadLinks({ db, sdk: bb.sdk, tickets });

  bb.rpc.register(
    rpcContract,
    createRpcHandlers({ tickets, links, listProjects: () => bb.sdk.projects.list({ includePersonal: true }) }),
  );

  bb.events.on("thread.created", ({ thread }) => links.inheritLink(thread));
  bb.events.on("thread.deleted", ({ thread }) => links.onThreadDeleted(thread.id));

  bb.background.service("ticket-refresh", {
    start: (signal) =>
      runRefreshLoop({
        signal,
        readMinutes: async () => (await settings.get()).refreshMinutes,
        refresh: (signal) => tickets.refresh(signal),
        onError: (message, error) =>
          bb.log.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`),
      }),
  });
};

export default createPlugin(createExecFileRunner());
