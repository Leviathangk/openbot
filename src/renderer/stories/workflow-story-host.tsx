/**
 * The story hosts of the workflow canvas. The canvas is a controlled component: these hosts keep its
 * workflow, its runs and its versions in the preview mock (`mockWorkflows`), as the desktop host keeps
 * them in the database. After each change, the mock emits, and the host reads the workflow, its runs
 * and its versions again.
 *
 * The runs and versions of a story fixture are history that the mock does not know. The host shows
 * them below the runs and versions of the mock. Retry on a step of a fixture run starts a new run
 * from that node; a fixture run has no open step to stop or to decide.
 */

import {
  type OpenBotDesktopApi,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_OUTPUT_TARGETS,
  WORKFLOW_TRIGGER_TYPES,
  type WorkflowDetail,
  type WorkflowGraph,
  type WorkflowSummary,
  type WorkflowTriggerState,
  type WorkflowVersion,
} from "@openbot/contracts/ipc";
import { toast } from "@openbot/ui";
import { accountUsageProviderRows } from "@openbot/ui/features/account/account-usage-view";
import { Sidebar } from "@openbot/ui/features/sidebar/Sidebar";
import type { SidebarView } from "@openbot/ui/features/sidebar/sidebar-types";
import { HelpMenu } from "@openbot/ui/features/updates/HelpMenu";
import { PageRail, type PageRailPage } from "@openbot/ui/features/window/PageRail";
import { WorkflowCanvas, type WorkflowCanvasProps } from "@openbot/ui/features/workflows/WorkflowCanvas";
import { WORKFLOW_FEATURES_V1, type WorkflowFeatures } from "@openbot/ui/features/workflows/workflow-model";
import { EMPTY_WORKFLOW_RUN_VIEW, type WorkflowRunView } from "@openbot/ui/features/workflows/workflow-run-view";
import { createMemo, createSignal, onSettled, Show, untrack } from "solid-js";
import { fn } from "storybook/test";
import { defaultSidebarLayout } from "../src/features/sidebar/sidebar-sections";
import { mockWorkflows } from "../src/preview/mock-workflows";
import { STORY_AGENTS } from "./fixtures";
import { STORY_CATALOGS, STORY_SEED, type StoryWorkflow, storyWebhook } from "./workflow-story-data";

/** Every node kind, trigger and output, for the stories whose workflows use them all. */
export const STORY_ALL_FEATURES: WorkflowFeatures = {
  kinds: WORKFLOW_NODE_KINDS,
  triggers: WORKFLOW_TRIGGER_TYPES,
  outputs: WORKFLOW_OUTPUT_TARGETS,
  uploads: true,
  presence: false,
};

/** The title of the workflow that opens when the user deletes the last one. */
const UNTITLED = "Untitled workflow";
const RUN_PAGE = 20;

type StoryCanvasProps = Omit<WorkflowCanvasProps, "workflow" | "features" | "frame" | "readOnly">;

const newestFirst = (left: string | null, right: string | null) => (right ?? "").localeCompare(left ?? "");

/** The trigger state that the desktop host gives: the next time of a schedule and the webhook address. */
function withTriggers(detail: WorkflowDetail): WorkflowDetail {
  const triggers = detail.graph.nodes.flatMap((node): WorkflowTriggerState[] => {
    if (node.kind !== "trigger") return [];
    const type = WORKFLOW_TRIGGER_TYPES.find((entry) => entry === node.fields.trigger) ?? "schedule";
    return [
      {
        nodeId: node.id,
        type,
        nextDueAt: type === "schedule" ? STORY_SEED.nextRun : null,
        webhookUrl: type === "webhook" ? storyWebhook(node.id) : null,
      },
    ];
  });
  return { ...detail, triggers };
}

/** The runs of the mock above the fixture runs. A mock run takes the numbers after the fixture runs. */
function mergeRuns(fixture: WorkflowRunView, live: WorkflowRunView): WorkflowRunView {
  const offset = Math.max(0, ...fixture.runs.map((entry) => entry.run.number));
  const renumbered = live.runs.map((entry) => ({ ...entry, run: { ...entry.run, number: entry.run.number + offset } }));
  return {
    runs: [...renumbered, ...fixture.runs].sort((left, right) => newestFirst(left.run.startedAt, right.run.startedAt)),
    soloSteps: [...live.soloSteps, ...fixture.soloSteps].sort((left, right) =>
      newestFirst(left.startedAt, right.startedAt),
    ),
    nextBefore: live.nextBefore,
  };
}

/**
 * The state and the callbacks of a canvas over the preview mock, for the workflows of a story. The
 * first workflow opens.
 */
function createWorkflowStory(workflows: readonly StoryWorkflow[]) {
  const fixtures = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const fixtureRuns = new Set(workflows.flatMap((workflow) => workflow.runs?.runs ?? []).map((entry) => entry.run.id));
  const fixtureSteps = new Map(
    workflows
      .flatMap((workflow) => [
        ...(workflow.runs?.runs.flatMap((entry) => entry.steps) ?? []),
        ...(workflow.runs?.soloSteps ?? []),
      ])
      .map((step) => [step.id, step]),
  );
  /** The graph of each version, for its preview. The mock gives the versions without their graphs. */
  const versionGraphs = new Map<string, WorkflowGraph>(
    workflows.flatMap((workflow) => workflow.versions ?? []).map(({ version, graph }) => [version.id, graph]),
  );
  /** The graph of each workflow at the last read, which a restore version keeps. */
  const lastGraphs = new Map<string, WorkflowGraph>();

  /** The open workflow as the mock has it. The host replaces it whole after each read. */
  const [stored, setStored] = createSignal<{
    detail: WorkflowDetail;
    runs: WorkflowRunView;
    versions: readonly WorkflowVersion[];
  }>();
  const [summaries, setSummaries] = createSignal<readonly WorkflowSummary[]>([]);
  const [preview, setPreview] = createSignal<{ versionId: string; graph: WorkflowGraph }>();
  const [resetKey, setResetKey] = createSignal(0);

  /** The open workflow. A plain value, so that a callback reads the new one at once. */
  let current = workflows[0]?.id ?? "";
  /** The revision that the canvas edits are on: the last reset, or the last save of the canvas. */
  let base = { workflowId: "", revision: 0 };
  let limit = RUN_PAGE;
  let disposed = false;
  onSettled(() => () => {
    disposed = true;
  });

  const report = (error: unknown) => {
    toast.error(error instanceof Error ? error.message : String(error));
  };

  const api: OpenBotDesktopApi["workflows"] = mockWorkflows(
    workflows.map(({ id, title, graph }) => ({ id, title, graph })),
    (workflowId) => {
      read(workflowId).catch(report);
    },
  );

  /** Reads the library and, for the open workflow, its detail, runs and versions. */
  const read = async (workflowId: string) => {
    const list = await api.list();
    if (disposed) return;
    setSummaries(list);
    // A delete emits too: the host then opens another workflow.
    if (workflowId !== current || !list.some((summary) => summary.id === workflowId)) return;
    const [next, page, versions] = await Promise.all([
      api.get(workflowId),
      api.runs({ workflowId, limit }),
      api.versions(workflowId),
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
    setStored({ detail: withTriggers(next), runs: page, versions });
    return next;
  };

  /** Shows `next` in place of the canvas edits. */
  const reset = (next: WorkflowDetail) => {
    base = { workflowId: next.summary.id, revision: next.revision };
    lastGraphs.set(next.summary.id, next.graph);
    setStored((open) => open && { ...open, detail: withTriggers(next) });
    setPreview(undefined);
    setResetKey((key) => key + 1);
  };

  /** Reads a workflow that opens. Its new summary id resets the canvas, so the key stays. */
  const load = async (workflowId: string) => {
    current = workflowId;
    limit = RUN_PAGE;
    const next = await read(workflowId);
    if (next) base = { workflowId, revision: next.revision };
  };
  /** Opens a workflow from a callback. */
  const open = (workflowId: string) => {
    setPreview(undefined);
    return load(workflowId);
  };

  /** Saves and restores go one at a time, so that each save has the revision of the one before. */
  let writes: Promise<void> = Promise.resolve();
  const write = (task: () => Promise<void>) => {
    writes = writes.then(task).catch(report);
  };

  // The component body cannot write signals, so the first read writes after the mock answers.
  load(current).catch(report);

  const library = createMemo<readonly WorkflowSummary[]>(() =>
    summaries().map((summary) => {
      const newest = fixtures.get(summary.id)?.runs?.runs[0]?.run;
      if (summary.lastRun || !newest) return summary;
      return { ...summary, lastRun: { status: newest.status, at: newest.startedAt } };
    }),
  );
  const detail = () => stored()?.detail;
  const runs = createMemo(() => {
    const open = stored();
    const fixture = open && fixtures.get(open.detail.summary.id)?.runs;
    return mergeRuns(fixture ?? EMPTY_WORKFLOW_RUN_VIEW, open?.runs ?? EMPTY_WORKFLOW_RUN_VIEW);
  });
  const versions = createMemo<readonly WorkflowVersion[]>(() => {
    const open = stored();
    const fixture = (open && fixtures.get(open.detail.summary.id)?.versions) ?? [];
    return [...(open?.versions ?? []), ...fixture.map(({ version }) => version)].sort((left, right) =>
      newestFirst(left.at, right.at),
    );
  });

  /** Runs the workflow again from a node, as Retry on a fixture step does. */
  const runFrom = (fromNodeId?: string) =>
    api
      .startRun({
        workflowId: current,
        requestId: crypto.randomUUID(),
        ...(fromNodeId === undefined ? {} : { fromNodeId }),
      })
      .catch(report);

  const props: StoryCanvasProps = {
    get resetKey() {
      return resetKey();
    },
    get runs() {
      return runs();
    },
    catalogs: STORY_CATALOGS,
    get versions() {
      return versions();
    },
    get versionPreview() {
      return preview();
    },
    get library() {
      return library();
    },
    onGraphChange: (graph) => {
      const workflowId = current;
      write(async () => {
        if (base.workflowId !== workflowId) return;
        const result = await api.saveGraph({ workflowId, baseRevision: base.revision, graph });
        if (result.ok) base = { workflowId, revision: result.revision };
        else reset(result.conflict);
      });
    },
    onRun: (input) => {
      runFrom(input.fromNodeId);
    },
    onRunStep: (nodeId) => {
      api.runStep({ workflowId: current, nodeId, requestId: crypto.randomUUID() }).catch(report);
    },
    onStopStep: (stepId) => {
      if (!fixtureSteps.has(stepId)) api.stopStep(stepId).catch(report);
    },
    onStopRun: (runId) => {
      if (!fixtureRuns.has(runId)) api.stopRun(runId).catch(report);
    },
    onRetry: (stepId) => {
      const fixture = fixtureSteps.get(stepId);
      if (fixture) runFrom(fixture.nodeId);
      else api.retryStep({ stepId, requestId: crypto.randomUUID() }).catch(report);
    },
    onDecide: (stepId, approved) => {
      if (!fixtureSteps.has(stepId)) api.decide({ stepId, approved }).catch(report);
    },
    onLoadOlderRuns: () => {
      limit += RUN_PAGE;
      read(current).catch(report);
    },
    onRestoreVersion: (versionId) => {
      const workflowId = current;
      write(async () => {
        const fixture = fixtures.get(workflowId)?.versions?.find(({ version }) => version.id === versionId);
        if (!fixture) return reset(await api.restoreVersion({ workflowId, versionId }));
        // The mock does not know a fixture version, so its graph is saved as a new revision.
        const now = await api.get(workflowId);
        const result = await api.saveGraph({ workflowId, baseRevision: now.revision, graph: fixture.graph });
        if (!result.ok) return reset(result.conflict);
        reset(await api.get(workflowId));
      });
    },
    onPreviewVersion: (versionId) => {
      const graph = versionId === null ? undefined : versionGraphs.get(versionId);
      setPreview(versionId === null || !graph ? undefined : { versionId, graph });
    },
    onSelect: (workflowId) => {
      open(workflowId).catch(report);
    },
    onCreate: (input) => {
      api
        .create(input)
        .then((created) => open(created.summary.id))
        .catch(report);
    },
    onRename: (workflowId, title) => {
      api.rename({ workflowId, title }).catch(report);
    },
    onDelete: (workflowId) => {
      const remove = async () => {
        const before = await api.list();
        const index = before.findIndex((summary) => summary.id === workflowId);
        await api.delete(workflowId);
        if (workflowId !== current) return;
        const rest = await api.list();
        const next = rest[Math.min(Math.max(index, 0), rest.length - 1)];
        if (next) return open(next.id);
        const created = await api.create({ title: UNTITLED });
        return open(created.summary.id);
      };
      remove().catch(report);
    },
  };

  return { detail, props };
}

/** A canvas over the preview mock that opens the first of `workflows`. */
export function WorkflowStory(props: { workflows: readonly StoryWorkflow[]; features?: WorkflowFeatures }) {
  const story = createWorkflowStory(untrack(() => props.workflows));
  const features = () => props.features ?? WORKFLOW_FEATURES_V1;
  return (
    <Show when={story.detail()}>
      {(workflow) => <WorkflowCanvas workflow={workflow()} features={features()} {...story.props} />}
    </Show>
  );
}

const usageRows = accountUsageProviderRows(null);

/**
 * The workflow canvas in the desktop window: the page rail and the server menu are the real app
 * components. The canvas is a page that covers the agent list, as the schedule, usage and Marketplace
 * pages do. Its bar goes in the window's top row after the server menu, and the canvas fills the card.
 */
export function WorkflowInAppStory(props: { workflows: readonly StoryWorkflow[]; features?: WorkflowFeatures }) {
  const story = createWorkflowStory(untrack(() => props.workflows));
  const features = () => props.features ?? WORKFLOW_FEATURES_V1;
  const [page, setPage] = createSignal<PageRailPage | null>("routines");
  const [view, setView] = createSignal<SidebarView>("routines");
  return (
    <div class="app-window wfn-app">
      <PageRail
        hidden={false}
        current={page()}
        usageRows={usageRows}
        onAgents={() => setPage("agents")}
        onRoutines={() => setPage("routines")}
        onTasks={() => setPage("tasks")}
        onSchedule={() => setPage("schedule")}
        onUsage={() => setPage("usage")}
        onMarketplace={fn()}
        onSettings={() => setPage("settings")}
        help={
          <HelpMenu
            news={[]}
            triggerClass="window-rail-button"
            onOpenWhatsNew={fn()}
            onOpenChangelog={fn()}
            onOpenGuides={fn()}
            onOpenDiscord={fn()}
            onSendFeedback={fn()}
          />
        }
      />
      <div
        class="app-frame app-frame-edge app-frame-platform-darwin"
        data-window-page-kind="titled"
        style="--left-panel-width: 280px"
      >
        <Sidebar
          serverName="Local"
          onOpenServerSettings={fn()}
          agents={STORY_AGENTS}
          activeAgentId=""
          people={[]}
          directThreads={[]}
          activeDirectMemberId={null}
          agentStates={{}}
          agentMoods={{}}
          layout={defaultSidebarLayout()}
          collapsedSectionIds={[]}
          onMutateLayout={fn(async () => undefined)}
          onToggleSection={fn()}
          pinnedItems={[]}
          peopleOrder={[]}
          onPin={fn()}
          onUnpin={fn()}
          onReorderPinned={fn()}
          onReorderPeople={fn()}
          onSelectAgent={fn()}
          onSelectPerson={fn()}
          onCreateAgent={fn()}
          onEditAgent={fn()}
          onDeleteAgent={async () => undefined}
          compact={false}
          onExpand={fn()}
          onOpenSearch={fn()}
          onOpenMarketplace={fn()}
          channels={[]}
          onSelectChannel={fn()}
          onCreateChannel={fn()}
          view={view()}
          onViewChange={setView}
        />
        <div class="window-page wfn-app-pane">
          <Show when={story.detail()}>
            {(workflow) => (
              <WorkflowCanvas workflow={workflow()} features={features()} frame="window" {...story.props} />
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
