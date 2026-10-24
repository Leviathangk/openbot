import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";
import type { WorkflowPlace } from "@openbot/ui/features/workflows/workflow-model";

type WorkflowsApi = OpenBotDesktopApi["workflows"];
/** Each method with its input only; `list` takes none. */
type BoundWorkflowsApi = {
  [Name in Exclude<keyof WorkflowsApi, "list">]: (
    input: Parameters<WorkflowsApi[Name]>[0],
  ) => ReturnType<WorkflowsApi[Name]>;
} & { list(): ReturnType<WorkflowsApi["list"]> };

/**
 * What the Workflows page reaches on one server: the workflows, the changes that make one stale, and
 * the messaging places an output can post to. The desktop app reaches this computer or a joined
 * server through main.
 */
export interface WorkflowHost {
  /** Called without a server: the host already names one. */
  workflows: BoundWorkflowsApi;
  /** Calls `changed` with the workflow that changed, or null when the server came back and all can be stale. */
  onChanged(changed: (workflowId: string | null) => void): () => void;
  /** Only this computer keeps messaging places; a joined server gives none. */
  places(): Promise<WorkflowPlace[]>;
}

/** The desktop adapter for one server. `window.openbot` is read on each call: tests and stories replace it per case. */
export function desktopWorkflowHost(serverId: string, local: boolean): WorkflowHost {
  const api = () => window.openbot.workflows;
  return {
    workflows: {
      list: () => api().list(serverId),
      get: (workflowId) => api().get(workflowId, serverId),
      create: (input) => api().create(input, serverId),
      rename: (input) => api().rename(input, serverId),
      delete: (workflowId) => api().delete(workflowId, serverId),
      saveGraph: (input) => api().saveGraph(input, serverId),
      versions: (workflowId) => api().versions(workflowId, serverId),
      restoreVersion: (input) => api().restoreVersion(input, serverId),
      startRun: (input) => api().startRun(input, serverId),
      runStep: (input) => api().runStep(input, serverId),
      stopStep: (stepId) => api().stopStep(stepId, serverId),
      stopRun: (runId) => api().stopRun(runId, serverId),
      retryStep: (input) => api().retryStep(input, serverId),
      decide: (input) => api().decide(input, serverId),
      runs: (input) => api().runs(input, serverId),
      run: (runId) => api().run(runId, serverId),
      rotateWebhookSecret: (input) => api().rotateWebhookSecret(input, serverId),
    },
    onChanged(changed) {
      const unsubscribe = window.openbot.agent.onScopedEvent((scoped) => {
        if (scoped.serverId === serverId && scoped.event.type === "workflows-changed") changed(scoped.event.workflowId);
      });
      const reconnect = window.openbot.servers.onEvent((servers) => {
        if (servers.some((server) => server.id === serverId && server.state === "online")) changed(null);
      });
      return () => {
        unsubscribe();
        reconnect();
      };
    },
    async places() {
      if (!local) return [];
      const connections = await window.openbot.routineResults.options();
      return connections.flatMap((connection) =>
        connection.places.map((place) => ({
          connectionId: connection.connectionId,
          placeId: place.id,
          label: `${connection.connectionName} · ${place.name}`,
        })),
      );
    },
  };
}
