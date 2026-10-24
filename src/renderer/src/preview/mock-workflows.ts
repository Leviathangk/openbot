// The workflow group of the preview: workflows, graphs and versions in memory. A save checks the
// revision as the host does; the graph rules stay the host's.

import type {
  OpenBotDesktopApi,
  WorkflowDetail,
  WorkflowGraph,
  WorkflowSummary,
  WorkflowVersion,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";

/** A workflow that a story starts with. */
export interface MockWorkflowSeed {
  id: string;
  title: string;
  graph: WorkflowGraph;
  updatedAt?: string;
}

interface MockWorkflowRecord {
  detail: WorkflowDetail;
  versions: (WorkflowVersion & { graph: WorkflowGraph })[];
}

const MAX_VERSIONS = 50;

/** `emit` sends the agent event `workflows-changed` for one workflow that changed. */
export function mockWorkflows(
  seeds: readonly MockWorkflowSeed[],
  emit: (workflowId: string) => void,
): OpenBotDesktopApi["workflows"] {
  const records = new Map<string, MockWorkflowRecord>();
  const stamp = () => new Date().toISOString();
  const summaryOf = (id: string, title: string, graph: WorkflowGraph, updatedAt: string): WorkflowSummary => ({
    id,
    title,
    steps: graph.nodes.filter((node) => node.kind !== "text" && node.kind !== "note" && node.kind !== "shape").length,
    updatedAt,
    lastRun: null,
  });
  const put = (id: string, title: string, graph: WorkflowGraph, revision: number, updatedAt = stamp()) => {
    const versions = records.get(id)?.versions ?? [];
    const detail: WorkflowDetail = {
      summary: summaryOf(id, title, graph, updatedAt),
      graph: structuredClone(graph),
      revision,
      triggers: [],
    };
    records.set(id, { detail, versions });
    return detail;
  };
  const record = (id: string) => {
    const found = records.get(id);
    if (!found) throw new Error(sourceText("error.workflow.missing"));
    return found;
  };
  const addVersion = (id: string, kind: WorkflowVersion["kind"]) => {
    const { detail, versions } = record(id);
    versions.unshift({ id: crypto.randomUUID(), at: stamp(), kind, revision: detail.revision, graph: detail.graph });
    versions.splice(MAX_VERSIONS);
  };
  for (const seed of seeds) put(seed.id, seed.title, seed.graph, 0, seed.updatedAt);

  return {
    list: async () =>
      structuredClone([...records.values()].map((entry) => entry.detail.summary)).sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      ),
    get: async (workflowId) => structuredClone(record(workflowId).detail),
    create: async (input) => {
      const id = crypto.randomUUID();
      const detail = put(id, input.title.trim(), input.graph ?? { nodes: [], edges: [], strokes: [] }, 0);
      emit(id);
      return structuredClone(detail);
    },
    rename: async (input) => {
      const { detail } = record(input.workflowId);
      const next = put(input.workflowId, input.title.trim(), detail.graph, detail.revision);
      emit(input.workflowId);
      return structuredClone(next.summary);
    },
    delete: async (workflowId) => {
      if (records.delete(workflowId)) emit(workflowId);
    },
    saveGraph: async (input) => {
      const { detail, versions } = record(input.workflowId);
      if (detail.revision !== input.baseRevision) return { ok: false, conflict: structuredClone(detail) };
      put(input.workflowId, detail.summary.title, input.graph, detail.revision + 1);
      const last = versions[0];
      if (!last || Date.now() - Date.parse(last.at) >= 5 * 60_000) addVersion(input.workflowId, "auto");
      emit(input.workflowId);
      return { ok: true, revision: detail.revision + 1 };
    },
    versions: async (workflowId) =>
      structuredClone(record(workflowId).versions.map(({ graph: _graph, ...version }) => version)),
    restoreVersion: async (input) => {
      const { detail, versions } = record(input.workflowId);
      const version = versions.find((entry) => entry.id === input.versionId);
      if (!version) throw new Error(sourceText("error.workflow.versionMissing"));
      addVersion(input.workflowId, "restore");
      const next = put(input.workflowId, detail.summary.title, version.graph, detail.revision + 1);
      emit(input.workflowId);
      return structuredClone(next);
    },
  };
}
