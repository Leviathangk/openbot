import {
  canAdministerServer,
  type WorkflowDetail,
  type WorkflowGraph,
  type WorkflowRunDetail,
  type WorkflowRunPage,
  type WorkflowStep,
} from "@openbot/contracts/ipc";
import {
  WORKFLOW_RUN_STEP_LIMIT,
  WORKFLOW_STEP_TEXT_LIMIT,
  WORKFLOWS_CAPABILITY,
  WORKFLOWS_ROUTES,
} from "@openbot/contracts/team-protocol/workflows-v1";
import { sourceText } from "@openbot/i18n/source";
import { RoutineInputError } from "@openbot/team-client/routine-schedule";
import { Effect } from "effect";
import { runCauseEffect } from "../../backend/effect-boundary";
import { WorkflowStoreError } from "../../backend/workflows/workflow-store";
import { HostEventsFailure, hostEventsFailureMessage } from "../host-events-api";
import {
  parseCreateWorkflow,
  parseDecideWorkflowStep,
  parseRenameWorkflow,
  parseRestoreWorkflowVersion,
  parseRetryWorkflowStep,
  parseRunWorkflowStep,
  parseSaveWorkflowGraph,
  parseStartWorkflowRun,
  parseWorkflowRuns,
  parseWorkflowTrigger,
} from "../ipc/workflow-inputs";
import type { TeamApiAgents, TeamApiWorkflows } from "./dependencies";
import { HttpError } from "./http-error";
import { isPeerHiddenProvider } from "./provider-visibility";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin, requireAgentLevel, stringField, WEBRTC_FRAME_BODY_BUDGET } from "./request-helpers";

const WORKFLOW_PATHS = new Set<string>(Object.values(WORKFLOWS_ROUTES));

function workflowMissing(): never {
  throw new HttpError(404, sourceText("error.workflow.missing"));
}

/** The wire codec has already checked the body, so only a malformed payload fails here, in English. */
function parse<A>(decode: (value: unknown) => A, body: unknown): A {
  try {
    return decode(body);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid workflow request.");
  }
}

/**
 * A workflow refused by the store, such as a cycle, or a schedule that cannot run, is the member's
 * sentence. Anything else is a host fault.
 */
async function run<A>(operation: Effect.Effect<A, { readonly cause: unknown }>): Promise<A> {
  try {
    return await runCauseEffect(operation);
  } catch (error) {
    if (error instanceof WorkflowStoreError) throw new HttpError(error.code === "missing" ? 404 : 400, error.message);
    if (error instanceof RoutineInputError) throw new HttpError(400, error.message);
    throw error;
  }
}

async function runEvents<A>(operation: Effect.Effect<A, HostEventsFailure>): Promise<A> {
  try {
    return await Effect.runPromise(operation);
  } catch (error) {
    // An internal failure goes to the dispatcher, which logs it and returns a generic 500.
    const message = error instanceof HostEventsFailure ? hostEventsFailureMessage(error) : null;
    if (message !== null) throw new HttpError(400, message);
    throw error;
  }
}

/** The agents that the agent steps of a graph send their tasks to. */
function graphAgents(graph: WorkflowGraph): string[] {
  return graph.nodes.flatMap((node) =>
    node.kind === "agent" && typeof node.fields.agentId === "string" && node.fields.agentId
      ? [node.fields.agentId]
      : [],
  );
}

/** The messaging place of each output node that posts to one, by node. */
function placeOutputs(graph: WorkflowGraph): Map<string, string> {
  const places = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind !== "output" || node.fields.target !== "channel") continue;
    places.set(node.id, JSON.stringify([node.fields.connectionId ?? null, node.fields.placeId ?? null]));
  }
  return places;
}

function clip(text: string | null): string | null {
  return text !== null && text.length > WORKFLOW_STEP_TEXT_LIMIT ? text.slice(0, WORKFLOW_STEP_TEXT_LIMIT) : text;
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * The workflows of a server, their versions and their runs, for a member. A member reads and uses a
 * workflow only when every agent of its agent steps, and every provider of its model steps, is visible
 * to them; otherwise it answers as missing. The answer filter in `provider-visibility.ts` would drop
 * the settings of such a node, and the member's save would then lose them. A change or a run needs the chat level for each of those agents, before and after the
 * change, and a change to an output that posts to a messaging place needs an owner or admin, as
 * routine results do. Frozen by `workflows-v1`.
 */
export async function routeWorkflows(
  context: TeamApiRequestContext,
  workflows: TeamApiWorkflows | undefined,
  agents: Pick<TeamApiAgents, "listAgents">,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json, protocol } = context;
  const path = url.pathname;
  if (method !== "POST" || !WORKFLOW_PATHS.has(path)) return "unmatched";
  if (!workflows || !capabilities.has(WORKFLOWS_CAPABILITY))
    throw new HttpError(400, sourceText("error.workflow.serverTooOld"));
  // `readJson` has already run the body through the workflows wire codec.
  const body = await readJson(request);
  const admin = canAdministerServer(member.role);
  const listed = () => new Set(agents.listAgents().map((agent) => agent.id));

  const visibleGraph = (graph: WorkflowGraph, known: ReadonlySet<string>) =>
    graphAgents(graph).every((agentId) => !hiddenAgentIds.has(agentId) && known.has(agentId)) &&
    graph.nodes.every((node) => !isPeerHiddenProvider(node.fields.provider, protocol));
  /** A graph that the member can read, change and run, or a 404 as for a missing workflow. */
  const requireUsable = (graph: WorkflowGraph) => {
    if (!visibleGraph(graph, listed())) workflowMissing();
    for (const agentId of graphAgents(graph)) requireAgentLevel(context, agentId, "chat");
  };
  const requireChange = (before: WorkflowGraph, after: WorkflowGraph) => {
    requireUsable(before);
    requireUsable(after);
    const old = placeOutputs(before);
    for (const [nodeId, place] of placeOutputs(after)) if (old.get(nodeId) !== place) requireAdmin(member);
  };
  const visibleDetail = async (workflowId: string) => {
    const detail = await run(workflows.get(workflowId));
    if (!visibleGraph(detail.graph, listed())) workflowMissing();
    return detail;
  };
  const usableDetail = async (workflowId: string) => {
    const detail = await visibleDetail(workflowId);
    requireUsable(detail.graph);
    return detail;
  };
  const workflowOf = async (ref: { runId: string } | { stepId: string }) => {
    const workflowId = await run(workflows.workflowOf(ref));
    if (workflowId === null)
      throw new HttpError(404, sourceText("runId" in ref ? "error.workflow.runMissing" : "error.workflow.stepMissing"));
    return workflowId;
  };

  const memberDetail = (detail: WorkflowDetail): WorkflowDetail => {
    const result = admin
      ? detail
      : { ...detail, triggers: detail.triggers.map((trigger) => ({ ...trigger, webhookUrl: null })) };
    if (bytesOf(result) > WEBRTC_FRAME_BODY_BUDGET)
      throw new HttpError(413, sourceText("error.workflow.tooLargeToSend"));
    return result;
  };
  /** A step's texts, clipped. The answer filter drops a step of an agent hidden from the member. */
  const memberStep = (step: WorkflowStep): WorkflowStep => ({
    ...step,
    output: clip(step.output),
    error: clip(step.error),
  });
  const memberRun = (detail: WorkflowRunDetail): WorkflowRunDetail => ({
    run: { ...detail.run, error: clip(detail.run.error) },
    steps: detail.steps.slice(-WORKFLOW_RUN_STEP_LIMIT).map(memberStep),
  });
  const fitted = <A>(value: A): A => {
    if (bytesOf(value) > WEBRTC_FRAME_BODY_BUDGET)
      throw new HttpError(413, sourceText("error.workflow.tooLargeToSend"));
    return value;
  };
  /** The page, with the step texts of the oldest runs emptied first while it would not fit one frame. */
  const memberPage = (page: WorkflowRunPage): WorkflowRunPage => {
    const result: WorkflowRunPage = {
      runs: page.runs.map(memberRun),
      soloSteps: page.soloSteps.map(memberStep),
      nextBefore: page.nextBefore,
    };
    const blank = (step: WorkflowStep): WorkflowStep => ({ ...step, output: null, error: null });
    let bytes = bytesOf(result);
    // The page lists the newest run first.
    for (const detail of [...result.runs].reverse()) {
      if (bytes <= WEBRTC_FRAME_BODY_BUDGET) break;
      const before = bytesOf(detail.steps);
      detail.steps = detail.steps.map(blank);
      bytes -= before - bytesOf(detail.steps);
    }
    if (bytes > WEBRTC_FRAME_BODY_BUDGET) result.soloSteps = result.soloSteps.map(blank);
    return fitted(result);
  };

  switch (path) {
    case WORKFLOWS_ROUTES.list: {
      const known = listed();
      const all = await run(workflows.listWithGraphs());
      return json(200, {
        workflows: all.filter(({ graph }) => visibleGraph(graph, known)).map(({ summary }) => summary),
      });
    }
    case WORKFLOWS_ROUTES.get:
      return json(200, memberDetail(await visibleDetail(stringField(body, "workflowId"))));
    case WORKFLOWS_ROUTES.create: {
      const input = parse(parseCreateWorkflow, body);
      if (input.graph) requireChange({ nodes: [], edges: [], strokes: [] }, input.graph);
      return json(200, memberDetail(await run(workflows.create(input))));
    }
    case WORKFLOWS_ROUTES.rename: {
      const input = parse(parseRenameWorkflow, body);
      await usableDetail(input.workflowId);
      return json(200, await run(workflows.rename(input)));
    }
    case WORKFLOWS_ROUTES.delete: {
      const workflowId = stringField(body, "workflowId");
      await usableDetail(workflowId);
      await run(workflows.remove(workflowId));
      return json(200, {});
    }
    case WORKFLOWS_ROUTES.saveGraph: {
      const input = parse(parseSaveWorkflowGraph, body);
      const current = await visibleDetail(input.workflowId);
      requireChange(current.graph, input.graph);
      const result = await run(workflows.saveGraph(input));
      return json(200, result.ok ? result : { ok: false, conflict: memberDetail(result.conflict) });
    }
    case WORKFLOWS_ROUTES.versions: {
      const workflowId = stringField(body, "workflowId");
      await visibleDetail(workflowId);
      return json(200, { versions: await run(workflows.versions(workflowId)) });
    }
    case WORKFLOWS_ROUTES.restoreVersion: {
      const input = parse(parseRestoreWorkflowVersion, body);
      const current = await visibleDetail(input.workflowId);
      const graph = await run(workflows.versionGraph(input));
      if (graph === null) throw new HttpError(404, sourceText("error.workflow.versionMissing"));
      requireChange(current.graph, graph);
      return json(200, memberDetail(await run(workflows.restoreVersion(input))));
    }
    case WORKFLOWS_ROUTES.startRun: {
      const input = parse(parseStartWorkflowRun, body);
      await usableDetail(input.workflowId);
      return json(200, fitted(memberRun(await run(workflows.startRun(input)))));
    }
    case WORKFLOWS_ROUTES.runStep: {
      const input = parse(parseRunWorkflowStep, body);
      await usableDetail(input.workflowId);
      return json(200, memberStep(await run(workflows.runStep(input))));
    }
    case WORKFLOWS_ROUTES.stopStep: {
      const stepId = stringField(body, "stepId");
      await usableDetail(await workflowOf({ stepId }));
      await run(workflows.stopStep(stepId));
      return json(200, {});
    }
    case WORKFLOWS_ROUTES.stopRun: {
      const runId = stringField(body, "runId");
      await usableDetail(await workflowOf({ runId }));
      await run(workflows.stopRun(runId));
      return json(200, {});
    }
    case WORKFLOWS_ROUTES.retryStep: {
      const input = parse(parseRetryWorkflowStep, body);
      await usableDetail(await workflowOf({ stepId: input.stepId }));
      return json(200, memberStep(await run(workflows.retryStep(input))));
    }
    case WORKFLOWS_ROUTES.decide: {
      const input = parse(parseDecideWorkflowStep, body);
      await usableDetail(await workflowOf({ stepId: input.stepId }));
      await run(workflows.decide(input));
      return json(200, {});
    }
    case WORKFLOWS_ROUTES.runs: {
      const input = parse(parseWorkflowRuns, body);
      await visibleDetail(input.workflowId);
      return json(200, memberPage(await run(workflows.runs(input))));
    }
    case WORKFLOWS_ROUTES.run: {
      const runId = stringField(body, "runId");
      await visibleDetail(await workflowOf({ runId }));
      return json(200, fitted(memberRun(await run(workflows.run(runId)))));
    }
    case WORKFLOWS_ROUTES.rotateWebhookSecret: {
      requireAdmin(member);
      const input = parse(parseWorkflowTrigger, body);
      await visibleDetail(input.workflowId);
      return json(200, await runEvents(workflows.rotateWorkflowSecret(input)));
    }
  }
  return "unmatched";
}
