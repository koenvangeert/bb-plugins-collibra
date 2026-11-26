import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MIGRATIONS } from "./src/database";
import { createGh } from "./src/gh";
import { createGhSearchPageReader } from "./src/github";
import { createHealthService } from "./src/healthService";
import { createRpcHandlers, rpcContract } from "./src/rpc";
import { parseRepositories, SETTINGS } from "./src/settings";
import { runSyncLoop } from "./src/syncLoop";
import { fetchTeamMembers } from "./src/teams";

export type { rpcContract } from "./src/rpc";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETTINGS);
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);

  const gh = createGh();
  const service = createHealthService({
    db,
    readPage: createGhSearchPageReader(gh),
    readTeamMembers: (repo, signal) => fetchTeamMembers(gh, repo, signal),
    readViewer: async (signal) => (await gh(["api", "user", "--jq", ".login"], signal)).trim(),
    readRepos: async () => parseRepositories((await settings.get()).repositories),
    now: () => Date.now(),
    onError: (message, error) =>
      bb.log.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`),
  });

  bb.rpc.register(rpcContract, createRpcHandlers(service));

  let serviceSignal: AbortSignal | null = null;
  bb.background.service("pull-request-sync", {
    start: (signal) => {
      serviceSignal = signal;
      return runSyncLoop({ signal, sync: (loopSignal) => service.sync(loopSignal) });
    },
  });
  settings.onChange((next, prev) => {
    if (next.repositories !== prev.repositories && serviceSignal && !serviceSignal.aborted) {
      service.sync(serviceSignal).catch((error) => bb.log.warn(`pull request sync failed: ${String(error)}`));
    }
  });
}
