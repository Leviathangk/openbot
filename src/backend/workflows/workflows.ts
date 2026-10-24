/**
 * Workflows: graphs of steps that a person draws on a canvas, their versions, and their runs.
 *
 * The store keeps the rows and checks the graph rules. This service is the one way in for main and
 * the Team API, and it says which workflow changed, so every view that shows it reads it again.
 *
 * A run copies the graph it starts from. Each pass reads the run's steps, ends what ended, and
 * starts each node whose inputs are in (see `workflow-walk.ts`). An agent step is a message from the
 * workflow to the agent, sent as a routine handoff; it ends when its delivery ends. A model step and
 * a condition run here, one at a time, without tools. Nothing listens to the provider: a pass runs
 * whenever the agent service says a turn or a queue changed, after each user action, and at
 * startup. Passes run one at a time; a request during a pass runs one more after it.
 *
 * A restart keeps approvals and agent steps: their state is in the database and in the mailbox. A
 * model step lives in this process only, so the first pass after a restart fails it.
 */

import { isAgentProvider } from "@openbot/contracts/agent-providers";
import {
  type AgentEvent,
  type AgentReasoningEffort,
  type CreateWorkflowInput,
  type DecideWorkflowStepInput,
  isReasoningEffort,
  type QueueDeliveryStatus,
  type RenameWorkflowInput,
  type RestoreWorkflowVersionInput,
  type RetryWorkflowStepInput,
  type RunWorkflowStepInput,
  type SaveWorkflowGraphInput,
  type StartWorkflowRunInput,
  type WorkflowDetail,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowRunDetail,
  type WorkflowRunPage,
  type WorkflowRunsInput,
  type WorkflowSaveResult,
  type WorkflowStep,
  type WorkflowSummary,
  type WorkflowVersion,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Context, Effect, Exit, Fiber, Layer, ManagedRuntime, Result, Schema, Scope, Semaphore } from "effect";
import { isNoUpdateAnswer } from "../agent/routine-quiet-runs";
import type { AgentProvider } from "../agent-client";
import {
  isOpenStep,
  publicRun,
  publicStep,
  type StoredWorkflowRun,
  type StoredWorkflowStep,
  type WorkflowRunStore,
  type WorkflowStepEnd,
} from "./workflow-run-store";
import { type WorkflowStore, WorkflowStoreError } from "./workflow-store";
import {
  agentStepText,
  conditionAnswer,
  conditionPrompt,
  fieldText,
  inputText,
  modelStepPrompt,
  nextActions,
  runScope,
  soloInputs,
  unsupportedNode,
} from "./workflow-walk";

const logger = createOpenBotLogger("workflows");

class WorkflowFailed extends Schema.TaggedError<WorkflowFailed>()("WorkflowFailed", {
  cause: Schema.Defect(),
}) {}

/** A delivery as the runtime reads it: whether it ended, and the turn that answered it. */
export interface WorkflowDelivery {
  status: QueueDeliveryStatus;
  turnId: string | null;
  error: string | null;
}

/** What a person must see outside the canvas: a step that waits for them, or an output. */
export interface WorkflowNotice {
  kind: "approval" | "output";
  workflowId: string;
  workflowTitle: string;
  text: string;
}

export interface WorkflowTextRequest {
  provider: AgentProvider | null;
  model: string | null;
  effort: AgentReasoningEffort | null;
  prompt: string;
}

export interface WorkflowsDependencies {
  store: WorkflowStore;
  runs: WorkflowRunStore;
  delivery(deliveryId: string): WorkflowDelivery | null;
  /** The answer an agent gave in one turn, or null when it gave none. */
  turnAnswer(agentId: string, turnId: string): string | null;
  sendHandoff(input: {
    run: { id: string; routineId: string; routineName: string; scheduledFor: string };
    agentId: string;
    text: string;
    idempotencyKey: string;
  }): Effect.Effect<string, { readonly cause: unknown }>;
  /** Ends a delivery: cancels it while it waits, or interrupts the turn that answers it. */
  stopDelivery(agentId: string, deliveryId: string): Effect.Effect<void, { readonly cause: unknown }>;
  /** One tool-less generation; the failure is a message the user can read. */
  generateText(request: WorkflowTextRequest): Effect.Effect<string, { readonly message: string }>;
  notify(notice: WorkflowNotice): void;
  /** The workflow whose graph, title, versions or runs changed. */
  changed(workflowId: string): void;
  now?: () => Date;
}

export interface WorkflowsShape {
  list(): Effect.Effect<WorkflowSummary[], WorkflowFailed>;
  get(workflowId: string): Effect.Effect<WorkflowDetail, WorkflowFailed>;
  create(input: CreateWorkflowInput): Effect.Effect<WorkflowDetail, WorkflowFailed>;
  rename(input: RenameWorkflowInput): Effect.Effect<WorkflowSummary, WorkflowFailed>;
  remove(workflowId: string): Effect.Effect<void, WorkflowFailed>;
  saveGraph(input: SaveWorkflowGraphInput): Effect.Effect<WorkflowSaveResult, WorkflowFailed>;
  versions(workflowId: string): Effect.Effect<WorkflowVersion[], WorkflowFailed>;
  restoreVersion(input: RestoreWorkflowVersionInput): Effect.Effect<WorkflowDetail, WorkflowFailed>;
  /** Starts a run of the whole workflow, from a trigger, or from one node. Idempotent by request id. */
  startRun(input: StartWorkflowRunInput): Effect.Effect<WorkflowRunDetail, WorkflowFailed>;
  /** Runs one node alone, with the newest answers of the nodes before it. */
  runStep(input: RunWorkflowStepInput): Effect.Effect<WorkflowStep, WorkflowFailed>;
  stopStep(stepId: string): Effect.Effect<void, WorkflowFailed>;
  stopRun(runId: string): Effect.Effect<void, WorkflowFailed>;
  /** Runs a failed or stopped step again with the same input, as its next attempt. */
  retryStep(input: RetryWorkflowStepInput): Effect.Effect<WorkflowStep, WorkflowFailed>;
  decide(input: DecideWorkflowStepInput): Effect.Effect<void, WorkflowFailed>;
  runs(input: WorkflowRunsInput): Effect.Effect<WorkflowRunPage, WorkflowFailed>;
  run(runId: string): Effect.Effect<WorkflowRunDetail, WorkflowFailed>;
  /** Moves every run that can move now. */
  sweep(): Effect.Effect<void>;
  /** Asks for a sweep when an agent event may have ended a step. Returns at once. */
  notice(event: AgentEvent): Effect.Effect<void>;
  /** Whether a model step is generating now. A restart would fail it. */
  generating(): boolean;
}

class Workflows extends Context.Service<Workflows, WorkflowsShape>()("openbot/backend/Workflows") {
  static layer(dependencies: WorkflowsDependencies) {
    return Layer.effect(
      Workflows,
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const lock = yield* Semaphore.make(1);
        /** One model step at a time, so a run does not take every generation slot of the computer. */
        const generationLock = yield* Semaphore.make(1);
        const { store, runs, changed } = dependencies;
        const now = () => (dependencies.now ?? (() => new Date()))();
        /** The model steps generating, by step. */
        const generations = new Map<string, Fiber.Fiber<void>>();
        let sweeping = false;
        let again = false;

        const attempt = <A>(work: () => A) =>
          Effect.try({ try: work, catch: (cause) => new WorkflowFailed({ cause }) });
        const refuse = (message: string) => new WorkflowFailed({ cause: new WorkflowStoreError(message) });

        const detailOf = (workflowId: string) => {
          const detail = store.detail(workflowId);
          if (!detail) throw new WorkflowStoreError(sourceText("error.workflow.missing"));
          return detail;
        };
        const runDetail = (run: StoredWorkflowRun): WorkflowRunDetail => ({
          run: publicRun(run),
          steps: runs.steps(run.id).map(publicStep),
        });
        const titleOf = (workflowId: string) => store.detail(workflowId)?.summary.title ?? "";
        const settle = (step: StoredWorkflowStep, end: WorkflowStepEnd) => {
          const ended = runs.settleStep(step.id, end, now());
          if (ended) changed(step.workflowId);
          return ended;
        };
        // The sweep and the steps call each other, so this type ends the loop of inferred types.
        const requestSweep = (): Effect.Effect<void> => Effect.forkIn(sweep(), scope).pipe(Effect.asVoid);

        // --- Steps ---------------------------------------------------------------------------------

        /**
         * Sends an agent step's message and keeps the delivery. The key is the step's, so a second
         * attempt after a restart finds the delivery the first one made instead of sending twice.
         */
        const sendAgentStep = Effect.fn("Workflows.sendAgentStep")(function* (step: StoredWorkflowStep) {
          if (!step.agentId) {
            settle(step, { status: "failed", error: sourceText("error.workflow.agentMissing") });
            return;
          }
          const run = step.runId ? runs.run(step.runId) : null;
          const sent = yield* dependencies
            .sendHandoff({
              run: {
                id: step.runId ?? step.id,
                routineId: step.workflowId,
                routineName: titleOf(step.workflowId),
                scheduledFor: run?.scheduledFor ?? run?.startedAt ?? step.createdAt,
              },
              agentId: step.agentId,
              text: step.input,
              idempotencyKey: `workflow-step:${step.id}`,
            })
            .pipe(Effect.exit);
          if (Exit.isSuccess(sent)) {
            runs.attachDelivery(step.id, sent.value, now());
            return;
          }
          logger.warn("A workflow could not send a step to its agent.", {
            stepId: step.id,
            agentId: step.agentId,
            cause: String(sent.cause),
          });
          settle(step, { status: "failed", error: sourceText("error.workflow.handoffFailed") });
        });

        /** Ends an agent step from its delivery. Answers whether the step ended. */
        const settleFromDelivery = (step: StoredWorkflowStep): boolean => {
          if (!step.deliveryId || !step.agentId) return false;
          const delivery = dependencies.delivery(step.deliveryId);
          if (!delivery) return settle(step, { status: "failed", error: sourceText("error.workflow.agentStepEnded") });
          if (delivery.turnId) runs.attachTurn(step.id, delivery.turnId, now());
          if (delivery.status === "completed") {
            if (delivery.error) return settle(step, { status: "failed", error: delivery.error });
            const answer = delivery.turnId ? dependencies.turnAnswer(step.agentId, delivery.turnId) : null;
            // The no-update marker is the routine wording for "nothing to say".
            const output = answer === null || isNoUpdateAnswer(answer) ? "" : answer;
            return settle(step, { status: "done", output });
          }
          if (delivery.status === "cancelled") return settle(step, { status: "stopped", error: delivery.error });
          if (delivery.status === "failed" || delivery.status === "interrupted")
            return settle(step, {
              status: "failed",
              error: delivery.error ?? sourceText("error.workflow.agentStepEnded"),
            });
          return false;
        };

        /** Runs a model step or a condition in a fiber of its own; the pass does not wait for it. */
        const startGeneration = (step: StoredWorkflowStep, node: WorkflowNode): Effect.Effect<void> => {
          const condition = node.kind === "condition";
          const request: WorkflowTextRequest = {
            provider: isAgentProvider(node.fields.provider) ? node.fields.provider : null,
            model: fieldText(node, "model") || null,
            effort: isReasoningEffort(node.fields.effort) ? node.fields.effort : null,
            prompt: condition
              ? conditionPrompt(fieldText(node, "rule"), step.input)
              : modelStepPrompt(fieldText(node, "system"), fieldText(node, "prompt"), step.input),
          };
          const generate = Effect.gen(function* () {
            const result = yield* generationLock.withPermit(dependencies.generateText(request)).pipe(Effect.result);
            if (Result.isFailure(result)) {
              settle(step, { status: "failed", error: result.failure.message });
            } else if (!condition) {
              settle(step, { status: "done", output: result.success });
            } else {
              const branch = conditionAnswer(result.success);
              // A condition hands its input on, so the nodes after it read what it judged.
              settle(
                step,
                branch
                  ? { status: "done", output: step.input, branch }
                  : { status: "failed", error: sourceText("error.workflow.conditionUnclear") },
              );
            }
            yield* requestSweep();
          }).pipe(
            // The step ends before the fiber is forgotten, so a pass never sees it running without one.
            Effect.ensuring(Effect.sync(() => generations.delete(step.id))),
          );
          return Effect.forkIn(generate, scope).pipe(
            Effect.tap((fiber) => Effect.sync(() => generations.set(step.id, fiber))),
            Effect.asVoid,
          );
        };

        /** Does what a new running step of `node` does. */
        const execute = Effect.fn("Workflows.execute")(function* (
          step: StoredWorkflowStep,
          node: WorkflowNode,
          run: StoredWorkflowRun | null,
        ) {
          if (unsupportedNode(node)) {
            settle(step, { status: "failed", error: sourceText("error.workflow.nodeUnsupported") });
            return;
          }
          switch (node.kind) {
            case "trigger":
              settle(step, { status: "done", output: run?.payload ?? "" });
              return;
            case "prompt":
              settle(step, { status: "done", output: fieldText(node, "text") });
              return;
            case "agent":
              yield* sendAgentStep(step);
              return;
            case "llm":
            case "condition":
              yield* startGeneration(step, node);
              return;
            case "approval":
              if (runs.awaitApproval(step.id, now())) {
                changed(step.workflowId);
                dependencies.notify({
                  kind: "approval",
                  workflowId: step.workflowId,
                  workflowTitle: titleOf(step.workflowId),
                  text: fieldText(node, "question"),
                });
              }
              return;
            case "output":
              if (fieldText(node, "target") === "channel") {
                settle(step, { status: "failed", error: sourceText("error.workflow.outputPending") });
                return;
              }
              dependencies.notify({
                kind: "output",
                workflowId: step.workflowId,
                workflowTitle: titleOf(step.workflowId),
                text: step.input,
              });
              settle(step, { status: "done", output: step.input });
              return;
            default:
              settle(step, { status: "failed", error: sourceText("error.workflow.nodeUnsupported") });
          }
        });

        /** The text a new step of `node` keeps as its input: the message itself for an agent. */
        const stepInput = (node: WorkflowNode, workflowId: string, inputs: readonly string[]) => {
          const text = inputText(inputs);
          return node.kind === "agent" ? agentStepText(titleOf(workflowId), fieldText(node, "task"), text) : text;
        };

        /** Ends an open step now: its delivery, its generation, then its row. */
        const stopNow = Effect.fn("Workflows.stopNow")(function* (step: StoredWorkflowStep) {
          if (step.deliveryId && step.agentId)
            yield* dependencies.stopDelivery(step.agentId, step.deliveryId).pipe(
              Effect.catch((failure) =>
                Effect.sync(() =>
                  logger.warn("A workflow step's delivery did not stop.", {
                    stepId: step.id,
                    cause: String(failure.cause),
                  }),
                ),
              ),
            );
          const fiber = generations.get(step.id);
          if (fiber) yield* Fiber.interrupt(fiber);
          settle(step, { status: "stopped" });
          // A fiber interrupted before it starts never runs its own clean-up.
          generations.delete(step.id);
        });

        // --- Runs ----------------------------------------------------------------------------------

        /** The newest attempt of each node of the run. */
        const latestSteps = (runId: string) => {
          const latest = new Map<string, StoredWorkflowStep>();
          for (const step of runs.steps(runId)) {
            const current = latest.get(step.nodeId);
            if (!current || step.attempt >= current.attempt) latest.set(step.nodeId, step);
          }
          return latest;
        };

        const scopeOf = (run: StoredWorkflowRun, latest: ReadonlyMap<string, StoredWorkflowStep>) =>
          runScope(
            run.graph,
            { triggerNodeId: run.triggerNodeId, fromNodeId: run.fromNodeId },
            new Set([...latest.values()].filter((step) => step.status === "done").map((step) => step.nodeId)),
          );

        /** Starts every node of the run that can start now, then sets the run's status. */
        const advance = Effect.fn("Workflows.advance")(function* (runId: string) {
          const run = runs.run(runId);
          if (!run) return;
          const nodes = new Map(run.graph.nodes.map((node) => [node.id, node]));
          let latest = latestSteps(run.id);
          if (run.status !== "stopping") {
            // An instant step can let the nodes after it start in the same pass.
            for (;;) {
              const actions = nextActions(run.graph, scopeOf(run, latest).nodes, latest);
              if (actions.length === 0) break;
              for (const action of actions) {
                const node = nodes.get(action.nodeId);
                if (!node) continue;
                const step = runs.addStep(
                  {
                    workflowId: run.workflowId,
                    runId: run.id,
                    nodeId: node.id,
                    kind: node.kind,
                    requestId: `${run.id}:${node.id}:${(latest.get(node.id)?.attempt ?? 0) + 1}`,
                    agentId: node.kind === "agent" ? fieldText(node, "agentId") || null : null,
                    status: action.action === "skip" ? "skipped" : "running",
                    input: action.action === "skip" ? "" : stepInput(node, run.workflowId, action.inputs),
                  },
                  now(),
                );
                changed(run.workflowId);
                if (action.action === "run" && step.status === "running") yield* execute(step, node, run);
              }
              latest = latestSteps(run.id);
            }
          }
          const ends = [...latest.values()];
          const open = ends.filter(isOpenStep);
          const status =
            open.length > 0
              ? run.status === "stopping"
                ? "stopping"
                : open.every((step) => step.status === "approval")
                  ? "approval"
                  : "running"
              : run.status === "stopping"
                ? "stopped"
                : ends.some((step) => step.status === "failed")
                  ? "failed"
                  : ends.some((step) => step.status === "stopped")
                    ? "stopped"
                    : "done";
          if (runs.setRunStatus(run.id, status, null, now())) changed(run.workflowId);
        });

        const sweepOnce = Effect.fn("Workflows.sweepOnce")(function* () {
          const runIds = new Set<string>();
          for (const step of runs.openSteps()) {
            if (step.status !== "running") continue;
            let ended = false;
            if (step.kind === "agent") {
              // A step without a delivery lost its message to a restart between the two writes.
              if (!step.deliveryId) {
                yield* sendAgentStep(step);
                ended = runs.step(step.id)?.status !== "running";
              } else ended = settleFromDelivery(step);
            } else if ((step.kind === "llm" || step.kind === "condition") && !generations.has(step.id)) {
              ended = settle(step, { status: "failed", error: sourceText("error.workflow.interrupted") });
            }
            if (ended && step.runId) runIds.add(step.runId);
          }
          for (const run of runs.openRuns()) runIds.add(run.id);
          for (const runId of runIds) yield* advance(runId);
        });

        /** Runs passes until none was asked for during the last one. A second call only asks again. */
        const sweep = (): Effect.Effect<void> =>
          Effect.suspend(() => {
            if (sweeping) {
              again = true;
              return Effect.void;
            }
            sweeping = true;
            return Effect.gen(function* () {
              do {
                again = false;
                yield* lock
                  .withPermit(sweepOnce())
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.sync(() => logger.warn("A workflow sweep failed.", { cause: String(cause) })),
                    ),
                  );
              } while (again);
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  sweeping = false;
                }),
              ),
              Effect.withSpan("Workflows.sweep"),
            );
          });

        const notice = Effect.fn("Workflows.notice")(function* (event: AgentEvent) {
          if (event.type !== "turn-completed" && event.type !== "queue-changed") return;
          yield* requestSweep();
        });

        /** A user action, under the same lock as a pass. */
        const locked = <A>(work: Effect.Effect<A, WorkflowFailed>) => lock.withPermit(work);

        // --- Graphs --------------------------------------------------------------------------------

        const list = Effect.fn("Workflows.list")(function* () {
          return yield* attempt(() => store.list());
        });

        const get = Effect.fn("Workflows.get")(function* (workflowId: string) {
          return yield* attempt(() => detailOf(workflowId));
        });

        const create = Effect.fn("Workflows.create")(function* (input: CreateWorkflowInput) {
          const detail = yield* attempt(() => store.create(input, now()));
          changed(detail.summary.id);
          return detail;
        });

        const rename = Effect.fn("Workflows.rename")(function* (input: RenameWorkflowInput) {
          const summary = yield* attempt(() => store.rename(input.workflowId, input.title, now()));
          changed(summary.id);
          return summary;
        });

        const remove = Effect.fn("Workflows.remove")(function* (workflowId: string) {
          yield* locked(
            Effect.gen(function* () {
              // The agents stop working for a workflow that is gone.
              for (const step of runs.openSteps())
                if (step.workflowId === workflowId) yield* stopNow(step).pipe(Effect.ignore);
              const removed = yield* attempt(() => store.remove(workflowId, now()));
              if (removed) changed(workflowId);
            }),
          );
        });

        const saveGraph = Effect.fn("Workflows.saveGraph")(function* (input: SaveWorkflowGraphInput) {
          const result = yield* attempt(() =>
            store.saveGraph(input.workflowId, input.baseRevision, input.graph, now()),
          );
          // A conflict changed nothing: the editor that saved gets the newer workflow in the answer.
          if (result.ok) changed(input.workflowId);
          return result;
        });

        const versions = Effect.fn("Workflows.versions")(function* (workflowId: string) {
          return yield* attempt(() => {
            detailOf(workflowId);
            return store.versions(workflowId);
          });
        });

        const restoreVersion = Effect.fn("Workflows.restoreVersion")(function* (input: RestoreWorkflowVersionInput) {
          const detail = yield* attempt(() => store.restoreVersion(input.workflowId, input.versionId, now()));
          changed(input.workflowId);
          return detail;
        });

        // --- Run actions ---------------------------------------------------------------------------

        const startRun = Effect.fn("Workflows.startRun")(function* (input: StartWorkflowRunInput) {
          return yield* locked(
            Effect.gen(function* () {
              const detail = yield* attempt(() => detailOf(input.workflowId));
              const from = input.fromNodeId ? detail.graph.nodes.find((node) => node.id === input.fromNodeId) : null;
              if (from === undefined) return yield* refuse(sourceText("error.workflow.nodeMissing"));
              const start = {
                triggerNodeId: from?.kind === "trigger" ? from.id : null,
                fromNodeId: from && from.kind !== "trigger" ? from.id : null,
              };
              const answered = runs.latestDone(input.workflowId);
              const scope = runScope(detail.graph, start, new Set(answered.keys()));
              if (detail.graph.nodes.some((node) => scope.nodes.has(node.id) && unsupportedNode(node)))
                return yield* refuse(sourceText("error.workflow.nodeUnsupported"));
              const { run, created } = yield* attempt(() =>
                runs.startRun(
                  {
                    workflowId: input.workflowId,
                    ...start,
                    source: "manual",
                    scheduledFor: null,
                    idempotencyKey: `manual:${input.requestId}`,
                    revision: detail.revision,
                    graph: detail.graph,
                    payload: null,
                  },
                  now(),
                ),
              );
              if (created) {
                yield* attempt(() => {
                  store.addRunVersion(input.workflowId, detail.revision, detail.graph, now());
                  // The nodes before the start give their earlier answers again.
                  for (const nodeId of scope.reused) {
                    const earlier = answered.get(nodeId);
                    if (!earlier) continue;
                    runs.addStep(
                      {
                        workflowId: run.workflowId,
                        runId: run.id,
                        nodeId,
                        kind: earlier.kind,
                        requestId: `${run.id}:${nodeId}:reused`,
                        agentId: earlier.agentId,
                        status: "done",
                        input: earlier.input,
                        output: earlier.output,
                        branch: earlier.branch,
                      },
                      now(),
                    );
                  }
                });
                changed(input.workflowId);
                yield* advance(run.id);
              }
              const current = runs.run(run.id);
              return runDetail(current ?? run);
            }),
          );
        });

        const runStep = Effect.fn("Workflows.runStep")(function* (input: RunWorkflowStepInput) {
          return yield* locked(
            Effect.gen(function* () {
              const detail = yield* attempt(() => detailOf(input.workflowId));
              const node = detail.graph.nodes.find((candidate) => candidate.id === input.nodeId);
              if (!node) return yield* refuse(sourceText("error.workflow.nodeMissing"));
              if (unsupportedNode(node)) return yield* refuse(sourceText("error.workflow.nodeUnsupported"));
              const inputs = soloInputs(detail.graph, node.id, runs.latestDone(input.workflowId));
              const step = yield* attempt(() =>
                runs.addStep(
                  {
                    workflowId: input.workflowId,
                    runId: null,
                    nodeId: node.id,
                    kind: node.kind,
                    requestId: input.requestId,
                    agentId: node.kind === "agent" ? fieldText(node, "agentId") || null : null,
                    status: "running",
                    input: stepInput(node, input.workflowId, inputs),
                  },
                  now(),
                ),
              );
              changed(input.workflowId);
              if (step.status === "running" && !step.deliveryId && !generations.has(step.id))
                yield* execute(step, node, null);
              return publicStep(runs.step(step.id) ?? step);
            }),
          );
        });

        const stopStep = Effect.fn("Workflows.stopStep")(function* (stepId: string) {
          yield* locked(
            Effect.gen(function* () {
              const step = runs.step(stepId);
              if (!step) return yield* refuse(sourceText("error.workflow.stepMissing"));
              if (!isOpenStep(step)) return;
              yield* stopNow(step);
              if (step.runId) yield* advance(step.runId);
            }),
          );
        });

        /** Stops every open step of a run, then the run. */
        const stopRunNow = Effect.fn("Workflows.stopRunNow")(function* (run: StoredWorkflowRun) {
          if (!runs.setRunStatus(run.id, "stopping", null, now())) return;
          changed(run.workflowId);
          for (const step of runs.steps(run.id)) if (isOpenStep(step)) yield* stopNow(step);
          yield* advance(run.id);
        });

        const stopRun = Effect.fn("Workflows.stopRun")(function* (runId: string) {
          yield* locked(
            Effect.gen(function* () {
              const run = runs.run(runId);
              if (!run) return yield* refuse(sourceText("error.workflow.runMissing"));
              yield* stopRunNow(run);
            }),
          );
        });

        const retryStep = Effect.fn("Workflows.retryStep")(function* (input: RetryWorkflowStepInput) {
          return yield* locked(
            Effect.gen(function* () {
              const failed = runs.step(input.stepId);
              if (!failed) return yield* refuse(sourceText("error.workflow.stepMissing"));
              if (failed.status !== "failed" && failed.status !== "stopped")
                return yield* refuse(sourceText("error.workflow.notRetryable"));
              const run = failed.runId ? runs.run(failed.runId) : null;
              const graph: WorkflowGraph = run?.graph ?? (yield* attempt(() => detailOf(failed.workflowId))).graph;
              const node = graph.nodes.find((candidate) => candidate.id === failed.nodeId);
              if (!node) return yield* refuse(sourceText("error.workflow.nodeMissing"));
              if (run && runs.reopenRun(run.id, now())) changed(run.workflowId);
              const step = yield* attempt(() =>
                runs.addStep(
                  {
                    workflowId: failed.workflowId,
                    runId: failed.runId,
                    nodeId: failed.nodeId,
                    kind: failed.kind,
                    requestId: input.requestId,
                    agentId: failed.agentId,
                    status: "running",
                    input: failed.input,
                  },
                  now(),
                ),
              );
              changed(failed.workflowId);
              if (step.status === "running" && !step.deliveryId && !generations.has(step.id))
                yield* execute(step, node, run);
              if (run) yield* advance(run.id);
              return publicStep(runs.step(step.id) ?? step);
            }),
          );
        });

        const decide = Effect.fn("Workflows.decide")(function* (input: DecideWorkflowStepInput) {
          yield* locked(
            Effect.gen(function* () {
              const step = runs.step(input.stepId);
              if (!step) return yield* refuse(sourceText("error.workflow.stepMissing"));
              if (step.status !== "approval") return yield* refuse(sourceText("error.workflow.noDecision"));
              settle(step, input.approved ? { status: "done", output: step.input } : { status: "stopped" });
              const run = step.runId ? runs.run(step.runId) : null;
              if (!run) return;
              // A rejection stops the whole run.
              if (input.approved) yield* advance(run.id);
              else yield* stopRunNow(run);
            }),
          );
        });

        const runPage = Effect.fn("Workflows.runs")(function* (input: WorkflowRunsInput) {
          return yield* attempt(() => {
            detailOf(input.workflowId);
            return runs.page(input.workflowId, input.before, input.limit);
          });
        });

        const run = Effect.fn("Workflows.run")(function* (runId: string) {
          const found = runs.run(runId);
          if (!found) return yield* refuse(sourceText("error.workflow.runMissing"));
          return yield* attempt(() => runDetail(found));
        });

        return Workflows.of({
          list,
          get,
          create,
          rename,
          remove,
          saveGraph,
          versions,
          restoreVersion,
          startRun,
          runStep,
          stopStep,
          stopRun,
          retryStep,
          decide,
          runs: runPage,
          run,
          sweep,
          notice,
          generating: () => generations.size > 0,
        });
      }),
    );
  }
}

export interface WorkflowsHandle extends WorkflowsShape {
  close(): Effect.Effect<void>;
}

/** Starts the service on its own runtime; `close` stops the passes and generations it forked. */
export const createWorkflows = Effect.fn("createWorkflows")(function* (dependencies: WorkflowsDependencies) {
  const runtime = ManagedRuntime.make(Workflows.layer(dependencies));
  const context = yield* runtime.contextEffect.pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? runtime.disposeEffect : Effect.void)),
  );
  const service = Context.get(context, Workflows);
  return { ...service, close: () => runtime.disposeEffect } satisfies WorkflowsHandle;
});
