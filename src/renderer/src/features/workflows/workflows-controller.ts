import {
  type AgentAccessLevels,
  graphAgentIds,
  type WorkflowDetail,
  type WorkflowGraph,
  type WorkflowSaveResult,
  type WorkflowSummary,
  type WorkflowVersion,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import { toast } from "@openbot/ui";
import type { WorkflowCanvasProps } from "@openbot/ui/features/workflows/WorkflowCanvas";
import type { WorkflowPlace } from "@openbot/ui/features/workflows/workflow-model";
import { EMPTY_WORKFLOW_RUN_VIEW, type WorkflowRunView } from "@openbot/ui/features/workflows/workflow-run-view";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, onSettled, untrack } from "solid-js";
import type { WorkflowHost } from "./workflows-port";

const RUN_PAGE = 20;
/** The pause after the last edit before the canvas saves. */
const SAVE_DELAY_MS = 400;

export type WorkflowsControllerProps = Omit<
  WorkflowCanvasProps,
  "workflow" | "features" | "frame" | "readOnly" | "catalogs"
>;

/**
 * The state and the callbacks of the canvas over one host. The canvas keeps its edits; this saves
 * them after a pause, one save at a time, each on the revision of the one before. A change from
 * another device or a restore loads the graph again. The first workflow of the host opens; a host
 * with none gets a new one, as the canvas needs a workflow.
 */
export function createWorkflowsController(host: WorkflowHost) {
  const { t, errorMessage } = useText();
  const report = (error: unknown) => {
    toast.error(errorMessage(error, t("workflow.page.failed")));
  };
  /** Shows the error of a call whose caller undoes what it showed. */
  const reported = <T>(call: Promise<T>) =>
    call.catch((error: unknown) => {
      report(error);
      throw error;
    });

  /** The open workflow as the host has it. Replaced whole after each read. */
  const [stored, setStored] = createSignal<{
    detail: WorkflowDetail;
    runs: WorkflowRunView;
    versions: readonly WorkflowVersion[];
  }>();
  const [summaries, setSummaries] = createSignal<readonly WorkflowSummary[]>([]);
  const [places, setPlaces] = createSignal<readonly WorkflowPlace[]>([]);
  /** Null while this account manages every agent of the host. */
  const [levels, setLevels] = createSignal<AgentAccessLevels | null>(null);
  const [preview, setPreview] = createSignal<{ versionId: string; graph: WorkflowGraph }>();
  const [resetKey, setResetKey] = createSignal(0);

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
  /** Counts each preview request, so that the graph of an older one does not show. */
  let previewRequest = 0;

  /**
   * Saves, restores and opens go one at a time, so that each save has the revision of the one before.
   * The queue shows the error of a task. `queued` gives the task's promise, so a caller that showed a
   * change can undo it when the task fails.
   */
  let writes: Promise<void> = Promise.resolve();
  const queued = <T>(task: () => Promise<T>): Promise<T> => {
    writing += 1;
    const done = writes.then(task);
    writes = done
      .then(() => undefined, report)
      .finally(() => {
        writing -= 1;
        edits += 1;
      });
    return done;
  };
  const write = (task: () => Promise<unknown>) => {
    void queued(task);
  };

  const closePreview = () => {
    previewRequest += 1;
    setPreview(undefined);
  };

  /** Shows `next` in place of the canvas edits. Undo on the canvas gets them back. */
  const reset = (next: WorkflowDetail) => {
    if (disposed) return;
    base = { workflowId: next.summary.id, revision: next.revision };
    setStored((open) => open && { ...open, detail: next });
    closePreview();
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
      let result: WorkflowSaveResult;
      try {
        result = await host.workflows.saveGraph({
          workflowId: edit.workflowId,
          baseRevision: base.revision,
          graph: edit.graph,
        });
      } catch (error) {
        // The canvas counts the edit as sent, so it saves with the next edit, or when the page closes.
        pending ??= edit;
        throw error;
      }
      if (result.ok) {
        base = { workflowId: edit.workflowId, revision: result.revision };
        return;
      }
      reset(result.conflict);
      toast.info(t("workflow.page.conflict"));
    });
  };

  /** Opens a workflow after the save of the one before. */
  const open = (workflowId: string) => {
    flush();
    closePreview();
    write(() => load(workflowId));
  };

  const readLevels = () => {
    host.agentLevels().then((next) => {
      if (!disposed) setLevels(next);
    }, report);
  };
  const readPlaces = () => {
    host.places().then((next) => {
      if (!disposed) setPlaces(next);
    }, report);
  };

  const refresh = (workflowId: string | null) => {
    read(workflowId ?? current).catch(report);
    if (workflowId !== null) return;
    readPlaces();
    readLevels();
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

  // The host reads the server role once for each call; a change event reads again.
  untrack(() => {
    readPlaces();
    readLevels();
  });
  write(async () => {
    const list = await host.workflows.list();
    const first = list[0] ?? (await host.workflows.create({ title: t("workflow.canvas.untitled") })).summary;
    if (!disposed) await load(first.id);
  });

  /**
   * Why the open workflow is read-only, or undefined when this account may change it: it has steps
   * that only a newer app knows, or an agent that this account does not manage. The host checks again.
   */
  const lock = createMemo((): AppTextKey | undefined => {
    const detail = stored()?.detail;
    if (!detail) return undefined;
    if (detail.needsNewerApp) return "workflow.page.needsNewerApp";
    const known = levels();
    return known && graphAgentIds(detail.graph).some((agentId) => known[agentId] !== "manage")
      ? "workflow.page.manageOnly"
      : undefined;
  });
  // The reason shows once each time a workflow opens read-only. The memo stops a read of the same
  // workflow: an effect runs on each change of what its compute function reads.
  const lockToken = createMemo(() => {
    const reason = lock();
    return reason && `${current}\u0000${reason}`;
  });
  createEffect(lockToken, (token) => {
    const reason = untrack(lock);
    if (token && reason) toast.info(t(reason));
  });

  /** Starts a run of the open workflow after the save of its edits. */
  const start = (call: (workflowId: string) => Promise<unknown>) => {
    flush();
    const workflowId = current;
    write(() => call(workflowId));
  };

  const props: WorkflowsControllerProps = {
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
      start((workflowId) =>
        host.workflows.startRun({
          workflowId,
          requestId: crypto.randomUUID(),
          ...(input.fromNodeId === undefined ? {} : { fromNodeId: input.fromNodeId }),
        }),
      );
    },
    onRunStep: (nodeId) => {
      start((workflowId) => host.workflows.runStep({ workflowId, nodeId, requestId: crypto.randomUUID() }));
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
    onDecide: (stepId, approved) => reported(host.workflows.decide({ stepId, approved })),
    // The host makes the address of a trigger that it has, so the secret waits for the save before it.
    onRotateWebhookSecret: (nodeId) => {
      flush();
      const workflowId = current;
      return queued(() => host.workflows.rotateWebhookSecret({ workflowId, nodeId })).then((result) => result.secret);
    },
    onLoadOlderRuns: () => {
      limit += RUN_PAGE;
      read(current).catch(report);
    },
    onRestoreVersion: (versionId) => {
      // The edit that waits saves first, so the version that the restore keeps has it.
      flush();
      const workflowId = current;
      write(async () => {
        reset(await host.workflows.restoreVersion({ workflowId, versionId }));
      });
    },
    onPreviewVersion: (versionId) => {
      closePreview();
      if (versionId === null) return;
      const request = previewRequest;
      const workflowId = current;
      host.workflows.versionGraph({ workflowId, versionId }).then((graph) => {
        if (!disposed && request === previewRequest && workflowId === current) setPreview({ versionId, graph });
      }, report);
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
      flush();
      return queued(async () => {
        const before = await host.workflows.list();
        const index = before.findIndex((summary) => summary.id === workflowId);
        await host.workflows.delete(workflowId);
        if (disposed || workflowId !== current) return;
        const rest = before.filter((summary) => summary.id !== workflowId);
        const next = rest[Math.min(Math.max(index, 0), rest.length - 1)];
        const opened = next?.id ?? (await host.workflows.create({ title: t("workflow.canvas.untitled") })).summary.id;
        closePreview();
        await load(opened);
      });
    },
  };

  return { detail: () => stored()?.detail, places, readOnly: () => lock() !== undefined, props };
}
