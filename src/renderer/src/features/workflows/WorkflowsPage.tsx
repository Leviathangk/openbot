import type { WorkflowDetail, WorkflowGraph, WorkflowSummary, WorkflowVersion } from "@openbot/contracts/ipc";
import { WORKFLOWS_CAPABILITY } from "@openbot/contracts/team-protocol/workflows-v1";
import { toast } from "@openbot/ui";
import { WorkflowCanvas, type WorkflowCanvasProps } from "@openbot/ui/features/workflows/WorkflowCanvas";
import {
  WORKFLOW_FEATURES_V1,
  type WorkflowCatalogs,
  type WorkflowPlace,
} from "@openbot/ui/features/workflows/workflow-model";
import { EMPTY_WORKFLOW_RUN_VIEW, type WorkflowRunView } from "@openbot/ui/features/workflows/workflow-run-view";
import { useText } from "@openbot/ui/text";
import { createSignal, onSettled, Show, untrack } from "solid-js";
import { useAuth } from "../account/account-context";
import { useAgents } from "../agents/agents-context";
import { serverSupportsCapability } from "../servers/server-capabilities";
import { useServers } from "../servers/servers-context";
import { desktopWorkflowHost, type WorkflowHost } from "./workflows-port";

const RUN_PAGE = 20;
/** The pause after the last edit before the canvas saves. */
const SAVE_DELAY_MS = 400;

type ControlledProps = Omit<WorkflowCanvasProps, "workflow" | "features" | "frame" | "readOnly" | "catalogs">;

/**
 * The workflows of one server on a page that covers the agent list. A joined server whose OpenBot
 * does not serve `workflows-v1` shows a notice.
 */
export function WorkflowsPage(props: { serverId: string }) {
  const { t } = useText();
  const { servers } = useServers();
  const server = () => servers().find((entry) => entry.id === props.serverId);
  const local = () => server()?.kind !== "remote";
  const supported = () => {
    const entry = server();
    return !entry || entry.kind === "local" || serverSupportsCapability(entry, WORKFLOWS_CAPABILITY);
  };
  /** A joined server that has not answered the compatibility check yet is not an older host. */
  const checking = () => {
    const entry = server();
    return entry?.kind === "remote" && !entry.compatibility?.hostAppVersion;
  };
  return (
    <Show
      when={supported() ? props.serverId : null}
      keyed
      fallback={
        <main class="window-page diagram-view diagram-flows-notice">
          <Show when={!checking()}>
            <p>{t("error.workflow.serverTooOld")}</p>
          </Show>
        </main>
      }
    >
      {(serverId) => <WorkflowsCanvas host={desktopWorkflowHost(serverId, local())} />}
    </Show>
  );
}

function WorkflowsCanvas(props: { host: WorkflowHost }) {
  const { agentList, modelOptions } = useAgents();
  const { signedInAccount } = useAuth();
  // The keyed parent mounts a new canvas for each server, so the host does not change.
  const workflows = createWorkflowsController(untrack(() => props.host));
  const catalogs: WorkflowCatalogs = {
    get agents() {
      return agentList();
    },
    get models() {
      return modelOptions();
    },
    get places() {
      return workflows.places();
    },
    imageModels: [],
    files: [],
    get self() {
      return signedInAccount()?.name ?? undefined;
    },
  };
  // The canvas is a direct child of the window page, which gives it the height of the pane.
  return (
    <Show when={workflows.detail()}>
      {(workflow) => (
        <WorkflowCanvas
          workflow={workflow()}
          features={WORKFLOW_FEATURES_V1}
          catalogs={catalogs}
          frame="window"
          {...workflows.props}
        />
      )}
    </Show>
  );
}

/**
 * The state and the callbacks of the canvas over one server. The canvas keeps its edits; this saves
 * them after a pause, one save at a time, each on the revision of the one before. A change from
 * another device or a restore loads the graph again.
 */
function createWorkflowsController(host: WorkflowHost) {
  const { t, errorMessage } = useText();
  const report = (error: unknown) => {
    toast.error(errorMessage(error, t("workflow.page.failed")));
  };

  /** The open workflow as the server has it. Replaced whole after each read. */
  const [stored, setStored] = createSignal<{
    detail: WorkflowDetail;
    runs: WorkflowRunView;
    versions: readonly WorkflowVersion[];
  }>();
  const [summaries, setSummaries] = createSignal<readonly WorkflowSummary[]>([]);
  const [places, setPlaces] = createSignal<readonly WorkflowPlace[]>([]);
  const [preview, setPreview] = createSignal<{ versionId: string; graph: WorkflowGraph }>();
  const [resetKey, setResetKey] = createSignal(0);

  /** The graph of each version seen on this page, for its preview. The server sends versions without graphs. */
  const versionGraphs = new Map<string, WorkflowGraph>();
  /** The graph of each workflow at the last read, which a restore version keeps. */
  const lastGraphs = new Map<string, WorkflowGraph>();

  /** The open workflow. A plain value, so that a callback reads the new one at once. */
  let current = "";
  /** The revision that the canvas edits are on: the last reset, or the last save of the canvas. */
  let base = { workflowId: "", revision: 0 };
  let limit = RUN_PAGE;
  let disposed = false;
  /** The edit that waits for the pause, and its timer. */
  let pending: { workflowId: string; graph: WorkflowGraph } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Counts each edit and each save, so that a read that started before one does not reset the canvas. */
  let edits = 0;
  let writing = 0;

  /** Saves, restores and opens go one at a time, so that each save has the revision of the one before. */
  let writes: Promise<void> = Promise.resolve();
  const write = (task: () => Promise<void>) => {
    writing += 1;
    writes = writes
      .then(task)
      .catch(report)
      .finally(() => {
        writing -= 1;
        edits += 1;
      });
  };

  /** Shows `next` in place of the canvas edits. */
  const reset = (next: WorkflowDetail) => {
    if (disposed) return;
    base = { workflowId: next.summary.id, revision: next.revision };
    lastGraphs.set(next.summary.id, next.graph);
    setStored((open) => open && { ...open, detail: next });
    setPreview(undefined);
    setResetKey((key) => key + 1);
  };

  /** Reads the library and, for the open workflow, its detail, runs and versions. */
  const read = async (workflowId: string) => {
    const seen = edits;
    const list = await host.workflows.list();
    if (disposed) return;
    setSummaries(list);
    // A delete changes the library too: the delete then opens another workflow.
    if (workflowId !== current || !list.some((summary) => summary.id === workflowId)) return;
    const [next, page, versions] = await Promise.all([
      host.workflows.get(workflowId),
      host.workflows.runs({ workflowId, limit }),
      host.workflows.versions(workflowId),
    ]);
    if (disposed || workflowId !== current) return;
    for (const version of versions) {
      if (versionGraphs.has(version.id)) continue;
      // A restore saves the graph before it; every other version saves the graph after it.
      versionGraphs.set(
        version.id,
        version.kind === "restore" ? (lastGraphs.get(workflowId) ?? next.graph) : next.graph,
      );
    }
    lastGraphs.set(workflowId, next.graph);
    const outside =
      base.workflowId === workflowId &&
      next.revision > base.revision &&
      seen === edits &&
      writing === 0 &&
      pending === undefined;
    // The canvas reads the graph only when it opens or resets, so a read under its edits keeps them.
    setStored({ detail: next, runs: page, versions });
    if (outside) reset(next);
    return next;
  };

  /** Reads a workflow that opens. Its new summary id resets the canvas, so the key stays. */
  const load = async (workflowId: string) => {
    current = workflowId;
    limit = RUN_PAGE;
    const next = await read(workflowId);
    if (next) base = { workflowId, revision: next.revision };
  };

  /** Starts the save of the edit that waits. */
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const edit = pending;
    pending = undefined;
    if (!edit) return;
    write(async () => {
      if (base.workflowId !== edit.workflowId) return;
      const result = await host.workflows.saveGraph({
        workflowId: edit.workflowId,
        baseRevision: base.revision,
        graph: edit.graph,
      });
      if (result.ok) base = { workflowId: edit.workflowId, revision: result.revision };
      else reset(result.conflict);
    });
  };

  /** Opens a workflow after the save of the one before. */
  const open = (workflowId: string) => {
    flush();
    setPreview(undefined);
    write(() => load(workflowId));
  };

  const refresh = (workflowId: string | null) => {
    read(workflowId ?? current).catch(report);
    if (workflowId === null) host.places().then(setPlaces, report);
  };

  onSettled(() => {
    const stop = host.onChanged(refresh);
    return () => {
      stop();
      // A pending edit still saves after the page closes.
      flush();
      disposed = true;
    };
  });

  host.places().then((next) => {
    if (!disposed) setPlaces(next);
  }, report);
  // The first workflow opens. A server with none gets a new one, as the canvas needs a workflow.
  write(async () => {
    const list = await host.workflows.list();
    const first = list[0] ?? (await host.workflows.create({ title: t("workflow.canvas.untitled") })).summary;
    if (!disposed) await load(first.id);
  });

  /** Runs the workflow from its triggers, or from one node. */
  const runFrom = (fromNodeId?: string) => {
    flush();
    const workflowId = current;
    write(async () => {
      await host.workflows.startRun({
        workflowId,
        requestId: crypto.randomUUID(),
        ...(fromNodeId === undefined ? {} : { fromNodeId }),
      });
    });
  };

  const props: ControlledProps = {
    get resetKey() {
      return resetKey();
    },
    get runs() {
      return stored()?.runs ?? EMPTY_WORKFLOW_RUN_VIEW;
    },
    get versions() {
      return stored()?.versions ?? [];
    },
    get versionPreview() {
      return preview();
    },
    get library() {
      return summaries();
    },
    onGraphChange: (graph) => {
      edits += 1;
      pending = { workflowId: current, graph };
      clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DELAY_MS);
    },
    onRun: (input) => {
      runFrom(input.fromNodeId);
    },
    onRunStep: (nodeId) => {
      flush();
      const workflowId = current;
      write(async () => {
        await host.workflows.runStep({ workflowId, nodeId, requestId: crypto.randomUUID() });
      });
    },
    onStopStep: (stepId) => {
      host.workflows.stopStep(stepId).catch(report);
    },
    onStopRun: (runId) => {
      host.workflows.stopRun(runId).catch(report);
    },
    onRetry: (stepId) => {
      host.workflows.retryStep({ stepId, requestId: crypto.randomUUID() }).catch(report);
    },
    onDecide: (stepId, approved) => {
      host.workflows.decide({ stepId, approved }).catch(report);
    },
    // The host makes the address of a trigger that it has, so the secret waits for the save before it.
    onRotateWebhookSecret: (nodeId) => {
      flush();
      const workflowId = current;
      return new Promise<string>((resolve, reject) => {
        write(() =>
          host.workflows.rotateWebhookSecret({ workflowId, nodeId }).then((result) => resolve(result.secret), reject),
        );
      });
    },
    onLoadOlderRuns: () => {
      limit += RUN_PAGE;
      read(current).catch(report);
    },
    onRestoreVersion: (versionId) => {
      // A restore replaces the edits, so the edit that waits does not save.
      clearTimeout(timer);
      pending = undefined;
      const workflowId = current;
      write(async () => {
        reset(await host.workflows.restoreVersion({ workflowId, versionId }));
      });
    },
    onPreviewVersion: (versionId) => {
      const graph = versionId === null ? undefined : versionGraphs.get(versionId);
      setPreview(versionId === null || !graph ? undefined : { versionId, graph });
    },
    onSelect: (workflowId) => {
      open(workflowId);
    },
    onCreate: (input) => {
      flush();
      write(async () => {
        const created = await host.workflows.create(input);
        await load(created.summary.id);
      });
    },
    onRename: (workflowId, title) => {
      host.workflows.rename({ workflowId, title }).catch(report);
    },
    onDelete: (workflowId) => {
      if (pending?.workflowId === workflowId) {
        clearTimeout(timer);
        pending = undefined;
      }
      write(async () => {
        const before = await host.workflows.list();
        const index = before.findIndex((summary) => summary.id === workflowId);
        await host.workflows.delete(workflowId);
        if (disposed || workflowId !== current) return;
        const rest = before.filter((summary) => summary.id !== workflowId);
        const next = rest[Math.min(Math.max(index, 0), rest.length - 1)];
        const opened = next?.id ?? (await host.workflows.create({ title: t("workflow.canvas.untitled") })).summary.id;
        setPreview(undefined);
        await load(opened);
      });
    },
  };

  return { detail: () => stored()?.detail, places, props };
}
