// The payloads of the workflow endpoints. Only a malformed payload fails here, so the text stays English.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type CreateWorkflowInput,
  type DecideWorkflowStepInput,
  isCreateWorkflowInput,
  isDecideWorkflowStepInput,
  isRenameWorkflowInput,
  isRestoreWorkflowVersionInput,
  isRetryWorkflowStepInput,
  isRunWorkflowStepInput,
  isSaveWorkflowGraphInput,
  isStartWorkflowRunInput,
  isWorkflowRunsInput,
  type RenameWorkflowInput,
  type RestoreWorkflowVersionInput,
  type RetryWorkflowStepInput,
  type RunWorkflowStepInput,
  type SaveWorkflowGraphInput,
  type StartWorkflowRunInput,
  type WorkflowRunsInput,
} from "@openbot/contracts/ipc";
import { requireString } from "./validation";

export function parseWorkflowId(value: unknown): string {
  return requireString(value, "workflowId", INPUT_LIMITS.identifier);
}

export function parseWorkflowStepId(value: unknown): string {
  return requireString(value, "stepId", INPUT_LIMITS.identifier);
}

export function parseWorkflowRunId(value: unknown): string {
  return requireString(value, "runId", INPUT_LIMITS.identifier);
}

export function parseCreateWorkflow(value: unknown): CreateWorkflowInput {
  if (!isCreateWorkflowInput(value)) throw new Error("Invalid workflow.");
  return { title: value.title, ...(value.graph === undefined ? {} : { graph: value.graph }) };
}

export function parseRenameWorkflow(value: unknown): RenameWorkflowInput {
  if (!isRenameWorkflowInput(value)) throw new Error("Invalid workflow title.");
  return { workflowId: value.workflowId, title: value.title };
}

export function parseSaveWorkflowGraph(value: unknown): SaveWorkflowGraphInput {
  if (!isSaveWorkflowGraphInput(value)) throw new Error("Invalid workflow graph.");
  return { workflowId: value.workflowId, baseRevision: value.baseRevision, graph: value.graph };
}

export function parseRestoreWorkflowVersion(value: unknown): RestoreWorkflowVersionInput {
  if (!isRestoreWorkflowVersionInput(value)) throw new Error("Invalid workflow version.");
  return { workflowId: value.workflowId, versionId: value.versionId };
}

export function parseStartWorkflowRun(value: unknown): StartWorkflowRunInput {
  if (!isStartWorkflowRunInput(value)) throw new Error("Invalid workflow run.");
  return {
    workflowId: value.workflowId,
    requestId: value.requestId,
    ...(value.fromNodeId === undefined ? {} : { fromNodeId: value.fromNodeId }),
  };
}

export function parseRunWorkflowStep(value: unknown): RunWorkflowStepInput {
  if (!isRunWorkflowStepInput(value)) throw new Error("Invalid workflow step.");
  return { workflowId: value.workflowId, nodeId: value.nodeId, requestId: value.requestId };
}

export function parseRetryWorkflowStep(value: unknown): RetryWorkflowStepInput {
  if (!isRetryWorkflowStepInput(value)) throw new Error("Invalid workflow step.");
  return { stepId: value.stepId, requestId: value.requestId };
}

export function parseDecideWorkflowStep(value: unknown): DecideWorkflowStepInput {
  if (!isDecideWorkflowStepInput(value)) throw new Error("Invalid workflow decision.");
  return { stepId: value.stepId, approved: value.approved };
}

export function parseWorkflowRuns(value: unknown): WorkflowRunsInput {
  if (!isWorkflowRunsInput(value)) throw new Error("Invalid workflow runs request.");
  return {
    workflowId: value.workflowId,
    limit: value.limit,
    ...(value.before === undefined ? {} : { before: value.before }),
  };
}
