// The payloads of the workflow endpoints. Only a malformed payload fails here, so the text stays English.

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  type CreateWorkflowInput,
  isCreateWorkflowInput,
  isRenameWorkflowInput,
  isRestoreWorkflowVersionInput,
  isSaveWorkflowGraphInput,
  type RenameWorkflowInput,
  type RestoreWorkflowVersionInput,
  type SaveWorkflowGraphInput,
} from "@openbot/contracts/ipc";
import { requireString } from "./validation";

export function parseWorkflowId(value: unknown): string {
  return requireString(value, "workflowId", INPUT_LIMITS.identifier);
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
