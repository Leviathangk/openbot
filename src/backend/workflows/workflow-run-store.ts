/**
 * The run tables of workflows: runs and the steps of each run, and steps that ran alone. Rows are
 * written directly, like the graph tables. Each change of a step is conditional on the status it
 * leaves, so two sweeps, or a sweep and a user action, never both settle one step.
 */

import {
  isWorkflowGraph,
  WORKFLOW_BRANCHES,
  WORKFLOW_NODE_KINDS,
  WORKFLOW_RUN_SOURCES,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_STEP_STATUSES,
  type WorkflowBranch,
  type WorkflowGraph,
  type WorkflowNodeKind,
  type WorkflowRun,
  type WorkflowRunPage,
  type WorkflowRunSource,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowStepStatus,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isOneOf } from "@openbot/contracts/runtime-values";
import {
  databaseRow,
  databaseRows,
  optionalStringColumn,
  requiredNumberColumn,
  requiredStringColumn,
} from "../database/database-rows";
import type { OpenBotDatabase } from "../openbot-database";

/** A run as the runtime reads it: the public row and the graph it started from. */
export interface StoredWorkflowRun extends WorkflowRun {
  graph: WorkflowGraph;
  fromNodeId: string | null;
  scheduledFor: string | null;
  payload: string | null;
}

/** A step as the runtime reads it: the public row and what the runtime alone needs. */
export interface StoredWorkflowStep extends WorkflowStep {
  kind: WorkflowNodeKind;
  input: string;
  deliveryId: string | null;
  turnId: string | null;
  createdAt: string;
}

export const OPEN_STEP_STATUSES = ["waiting", "running", "approval"] as const satisfies readonly WorkflowStepStatus[];
/** Whether a step has not ended yet. */
export function isOpenStep(step: Pick<WorkflowStep, "status">): boolean {
  return isOneOf(OPEN_STEP_STATUSES, step.status);
}
const OPEN_RUN_STATUSES = ["running", "approval", "stopping"] as const satisfies readonly WorkflowRunStatus[];

export interface NewWorkflowRun {
  workflowId: string;
  triggerNodeId: string | null;
  fromNodeId: string | null;
  source: WorkflowRunSource;
  scheduledFor: string | null;
  idempotencyKey: string;
  revision: number;
  graph: WorkflowGraph;
  payload: string | null;
}

export interface NewWorkflowStep {
  workflowId: string;
  runId: string | null;
  nodeId: string;
  kind: WorkflowNodeKind;
  requestId: string;
  agentId: string | null;
  status: WorkflowStepStatus;
  input: string;
  output?: string | null;
  branch?: WorkflowBranch | null;
  error?: string | null;
}

export interface WorkflowStepEnd {
  status: Exclude<WorkflowStepStatus, "waiting" | "running" | "approval">;
  output?: string | null;
  branch?: WorkflowBranch | null;
  error?: string | null;
}

export class WorkflowRunStore {
  readonly #database: OpenBotDatabase;
  readonly #createId: () => string;

  constructor(options: { database: OpenBotDatabase; createId?: () => string }) {
    this.#database = options.database;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  /** Starts a run, or answers the run that the same key already started. */
  startRun(input: NewWorkflowRun, now = new Date()): { run: StoredWorkflowRun; created: boolean } {
    return this.#transaction(() => {
      const db = this.#database.connection;
      const existing = databaseRow(
        db.prepare("SELECT run_id FROM workflow_runs WHERE idempotency_key = ?").get(input.idempotencyKey),
      );
      if (existing) {
        const run = this.run(requiredStringColumn(existing, "run_id"));
        if (run) return { run, created: false };
      }
      const numbered = databaseRow(
        db
          .prepare(
            "UPDATE workflows SET next_run_number = next_run_number + 1 WHERE workflow_id = ? RETURNING next_run_number - 1 AS number",
          )
          .get(input.workflowId),
      );
      if (!numbered) throw new Error("The workflow of a new run does not exist.");
      const runId = this.#createId();
      const at = now.toISOString();
      db.prepare(
        `INSERT INTO workflow_runs (run_id, workflow_id, number, trigger_node_id, from_node_id, source, scheduled_for,
          idempotency_key, graph_revision, graph_json, payload, status, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      ).run(
        runId,
        input.workflowId,
        requiredNumberColumn(numbered, "number"),
        input.triggerNodeId,
        input.fromNodeId,
        input.source,
        input.scheduledFor,
        input.idempotencyKey,
        input.revision,
        JSON.stringify(input.graph),
        input.payload,
        at,
        at,
      );
      const run = this.run(runId);
      if (!run) throw new Error("A new workflow run was not stored.");
      return { run, created: true };
    });
  }

  run(runId: string): StoredWorkflowRun | null {
    const row = databaseRow(this.#database.connection.prepare(`${RUN_SELECT} WHERE run_id = ?`).get(runId));
    return row ? toRun(row) : null;
  }

  /** Runs that can still move: running, waiting for an approval, or stopping. */
  openRuns(): StoredWorkflowRun[] {
    return databaseRows(
      this.#database.connection
        .prepare(`${RUN_SELECT} WHERE status IN (${placeholders(OPEN_RUN_STATUSES)}) ORDER BY started_at, run_id`)
        .all(...OPEN_RUN_STATUSES),
    ).map(toRun);
  }

  /** Changes an open run's status. Answers whether it changed. */
  setRunStatus(runId: string, status: WorkflowRunStatus, error: string | null, now = new Date()): boolean {
    const at = now.toISOString();
    const ended = isOneOf(OPEN_RUN_STATUSES, status) ? null : at;
    return (
      this.#database.connection
        .prepare(
          `UPDATE workflow_runs SET status = ?, error = ?, ended_at = ?, updated_at = ?
           WHERE run_id = ? AND status IN (${placeholders(OPEN_RUN_STATUSES)}) AND (status <> ? OR error IS NOT ?)`,
        )
        .run(status, error, ended, at, runId, ...OPEN_RUN_STATUSES, status, error).changes > 0
    );
  }

  /** Opens an ended run again, for a retried step. */
  reopenRun(runId: string, now = new Date()): boolean {
    return (
      this.#database.connection
        .prepare(
          `UPDATE workflow_runs SET status = 'running', error = NULL, ended_at = NULL, updated_at = ?
           WHERE run_id = ? AND status IN ('done', 'failed', 'stopped')`,
        )
        .run(now.toISOString(), runId).changes > 0
    );
  }

  /** Every attempt of the run's steps, oldest first. */
  steps(runId: string): StoredWorkflowStep[] {
    return databaseRows(
      this.#database.connection
        .prepare(`${STEP_SELECT} WHERE run_id = ? ORDER BY created_at, attempt, step_id`)
        .all(runId),
    ).map(toStep);
  }

  step(stepId: string): StoredWorkflowStep | null {
    const row = databaseRow(this.#database.connection.prepare(`${STEP_SELECT} WHERE step_id = ?`).get(stepId));
    return row ? toStep(row) : null;
  }

  /** Steps that have not ended, of runs and alone. */
  openSteps(): StoredWorkflowStep[] {
    return databaseRows(
      this.#database.connection
        .prepare(`${STEP_SELECT} WHERE status IN (${placeholders(OPEN_STEP_STATUSES)}) ORDER BY created_at, step_id`)
        .all(...OPEN_STEP_STATUSES),
    ).map(toStep);
  }

  /**
   * The newest step of each node that ended with an answer, of runs and alone. A run from a node
   * reads the steps before that node from here.
   */
  latestDone(workflowId: string): Map<string, StoredWorkflowStep> {
    const rows = databaseRows(
      this.#database.connection
        .prepare(`${STEP_SELECT} WHERE workflow_id = ? AND status = 'done' ORDER BY created_at, attempt, step_id`)
        .all(workflowId),
    ).map(toStep);
    return new Map(rows.map((step) => [step.nodeId, step]));
  }

  /**
   * Adds a step, or answers the step that the same request already added. The attempt is the
   * node's next one in its run; a step alone is always the first.
   */
  addStep(input: NewWorkflowStep, now = new Date()): StoredWorkflowStep {
    return this.#transaction(() => {
      const db = this.#database.connection;
      const existing = databaseRow(
        db.prepare("SELECT step_id FROM workflow_steps WHERE request_id = ?").get(input.requestId),
      );
      if (existing) {
        const step = this.step(requiredStringColumn(existing, "step_id"));
        if (step) return step;
      }
      const attempt =
        input.runId === null
          ? 1
          : requiredNumberColumn(
              databaseRow(
                db
                  .prepare(
                    "SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM workflow_steps WHERE run_id = ? AND node_id = ?",
                  )
                  .get(input.runId, input.nodeId),
              ) ?? {},
              "attempt",
            );
      const stepId = this.#createId();
      const at = now.toISOString();
      const ended = isOneOf(OPEN_STEP_STATUSES, input.status) ? null : at;
      db.prepare(
        `INSERT INTO workflow_steps (step_id, workflow_id, run_id, node_id, attempt, request_id, kind, agent_id, status,
          input, output, branch, error, started_at, ended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        stepId,
        input.workflowId,
        input.runId,
        input.nodeId,
        attempt,
        input.requestId,
        input.kind,
        input.agentId,
        input.status,
        input.input,
        input.output ?? null,
        input.branch ?? null,
        input.error ?? null,
        input.status === "waiting" ? null : at,
        ended,
        at,
        at,
      );
      const step = this.step(stepId);
      if (!step) throw new Error("A new workflow step was not stored.");
      return step;
    });
  }

  attachDelivery(stepId: string, deliveryId: string, now = new Date()): void {
    this.#database.connection
      .prepare("UPDATE workflow_steps SET delivery_id = ?, updated_at = ? WHERE step_id = ? AND delivery_id IS NULL")
      .run(deliveryId, now.toISOString(), stepId);
  }

  attachTurn(stepId: string, turnId: string, now = new Date()): void {
    this.#database.connection
      .prepare("UPDATE workflow_steps SET turn_id = ?, updated_at = ? WHERE step_id = ? AND turn_id IS NOT ?")
      .run(turnId, now.toISOString(), stepId, turnId);
  }

  /** Holds a running step for a person's decision. */
  awaitApproval(stepId: string, now = new Date()): boolean {
    return (
      this.#database.connection
        .prepare(
          "UPDATE workflow_steps SET status = 'approval', updated_at = ? WHERE step_id = ? AND status = 'running'",
        )
        .run(now.toISOString(), stepId).changes > 0
    );
  }

  /** Ends a step that has not ended. Answers whether it ended it. */
  settleStep(stepId: string, end: WorkflowStepEnd, now = new Date()): boolean {
    const at = now.toISOString();
    return (
      this.#database.connection
        .prepare(
          `UPDATE workflow_steps SET status = ?, output = ?, branch = ?, error = ?, ended_at = ?, updated_at = ?,
            started_at = COALESCE(started_at, ?)
           WHERE step_id = ? AND status IN (${placeholders(OPEN_STEP_STATUSES)})`,
        )
        .run(
          end.status,
          end.output ?? null,
          end.branch ?? null,
          end.error ?? null,
          at,
          at,
          at,
          stepId,
          ...OPEN_STEP_STATUSES,
        ).changes > 0
    );
  }

  /** Runs newest first, before `before` when given, and on the first page the newest steps alone. */
  page(workflowId: string, before: string | undefined, limit: number): WorkflowRunPage {
    const db = this.#database.connection;
    const rows = databaseRows(
      before === undefined
        ? db
            .prepare(`${RUN_SELECT} WHERE workflow_id = ? ORDER BY started_at DESC, run_id DESC LIMIT ?`)
            .all(workflowId, limit + 1)
        : db
            .prepare(
              `${RUN_SELECT} WHERE workflow_id = ? AND started_at < ? ORDER BY started_at DESC, run_id DESC LIMIT ?`,
            )
            .all(workflowId, before, limit + 1),
    ).map(toRun);
    const runs = rows.slice(0, limit);
    const soloSteps =
      before === undefined
        ? databaseRows(
            db
              .prepare(
                `${STEP_SELECT} WHERE workflow_id = ? AND run_id IS NULL ORDER BY created_at DESC, step_id DESC LIMIT ?`,
              )
              .all(workflowId, limit),
          ).map(toStep)
        : [];
    return {
      runs: runs.map((run) => ({ run: publicRun(run), steps: this.steps(run.id).map(publicStep) })),
      soloSteps: soloSteps.map(publicStep),
      nextBefore: rows.length > limit ? (runs.at(-1)?.startedAt ?? null) : null,
    };
  }

  #transaction<T>(work: () => T): T {
    const db = this.#database.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      // SQLite may have rolled back already, and a second ROLLBACK would replace the error that did it.
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** The public part of a run, as IPC and the Team API carry it. */
export function publicRun(run: StoredWorkflowRun): WorkflowRun {
  return {
    id: run.id,
    workflowId: run.workflowId,
    number: run.number,
    triggerNodeId: run.triggerNodeId,
    source: run.source,
    status: run.status,
    error: run.error,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}

/** The public part of a step, as IPC and the Team API carry it. */
export function publicStep(step: StoredWorkflowStep): WorkflowStep {
  return {
    id: step.id,
    workflowId: step.workflowId,
    runId: step.runId,
    nodeId: step.nodeId,
    attempt: step.attempt,
    agentId: step.agentId,
    status: step.status,
    output: step.output,
    branch: step.branch,
    error: step.error,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
  };
}

const RUN_SELECT = `
  SELECT run_id, workflow_id, number, trigger_node_id, from_node_id, source, scheduled_for, graph_json, payload,
    status, error, started_at, ended_at
  FROM workflow_runs`;

const STEP_SELECT = `
  SELECT step_id, workflow_id, run_id, node_id, attempt, kind, agent_id, status, delivery_id, turn_id, input, output,
    branch, error, started_at, ended_at, created_at
  FROM workflow_steps`;

function placeholders(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

function toRun(row: DynamicRecord): StoredWorkflowRun {
  const source = row.source;
  const status = row.status;
  const graph = JSON.parse(requiredStringColumn(row, "graph_json"));
  if (!isWorkflowGraph(graph)) throw new Error("Invalid SQLite column: workflow_runs.graph_json");
  return {
    id: requiredStringColumn(row, "run_id"),
    workflowId: requiredStringColumn(row, "workflow_id"),
    number: requiredNumberColumn(row, "number"),
    triggerNodeId: optionalStringColumn(row, "trigger_node_id"),
    fromNodeId: optionalStringColumn(row, "from_node_id"),
    // The CHECK constraints hold these columns to the values; the guards only narrow the types.
    source: isOneOf(WORKFLOW_RUN_SOURCES, source) ? source : "manual",
    status: isOneOf(WORKFLOW_RUN_STATUSES, status) ? status : "failed",
    error: optionalStringColumn(row, "error"),
    startedAt: requiredStringColumn(row, "started_at"),
    endedAt: optionalStringColumn(row, "ended_at"),
    scheduledFor: optionalStringColumn(row, "scheduled_for"),
    payload: optionalStringColumn(row, "payload"),
    graph,
  };
}

function toStep(row: DynamicRecord): StoredWorkflowStep {
  const status = row.status;
  const branch = row.branch;
  const kind = row.kind;
  if (!isOneOf(WORKFLOW_NODE_KINDS, kind)) throw new Error("Invalid SQLite column: workflow_steps.kind");
  return {
    id: requiredStringColumn(row, "step_id"),
    workflowId: requiredStringColumn(row, "workflow_id"),
    runId: optionalStringColumn(row, "run_id"),
    nodeId: requiredStringColumn(row, "node_id"),
    attempt: requiredNumberColumn(row, "attempt"),
    kind,
    agentId: optionalStringColumn(row, "agent_id"),
    status: isOneOf(WORKFLOW_STEP_STATUSES, status) ? status : "failed",
    deliveryId: optionalStringColumn(row, "delivery_id"),
    turnId: optionalStringColumn(row, "turn_id"),
    input: requiredStringColumn(row, "input"),
    output: optionalStringColumn(row, "output"),
    branch: isOneOf(WORKFLOW_BRANCHES, branch) ? branch : null,
    error: optionalStringColumn(row, "error"),
    startedAt: optionalStringColumn(row, "started_at"),
    endedAt: optionalStringColumn(row, "ended_at"),
    createdAt: requiredStringColumn(row, "created_at"),
  };
}
