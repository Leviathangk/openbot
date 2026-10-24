// Workflows: graphs of steps drawn on a canvas. This computer's host answers from its own runtime. A
// joined server does not answer workflows yet, so the remote arm says so.

import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { WorkflowsHandle } from "../../backend/workflows/workflows";
import type { IpcGroupHandlers } from "./define-ipc-group";
import { scopedHandler, scopedQueryHandler } from "./scoped-handler";
import {
  parseCreateWorkflow,
  parseRenameWorkflow,
  parseRestoreWorkflowVersion,
  parseSaveWorkflowGraph,
  parseWorkflowId,
} from "./workflow-inputs";

interface WorkflowIpcDependencies {
  workflows: WorkflowsHandle;
}

export function workflowIpcHandlers({ workflows }: WorkflowIpcDependencies): Pick<IpcGroupHandlers, "workflows"> {
  const remote = (): never => {
    throw new Error(sourceText("error.workflow.serverTooOld"));
  };
  return {
    workflows: {
      list: scopedQueryHandler({ local: () => runCauseEffect(workflows.list()), remote }),
      get: scopedHandler(parseWorkflowId, { local: (id) => runCauseEffect(workflows.get(id)), remote }),
      create: scopedHandler(parseCreateWorkflow, { local: (input) => runCauseEffect(workflows.create(input)), remote }),
      rename: scopedHandler(parseRenameWorkflow, { local: (input) => runCauseEffect(workflows.rename(input)), remote }),
      delete: scopedHandler(parseWorkflowId, { local: (id) => runCauseEffect(workflows.remove(id)), remote }),
      saveGraph: scopedHandler(parseSaveWorkflowGraph, {
        local: (input) => runCauseEffect(workflows.saveGraph(input)),
        remote,
      }),
      versions: scopedHandler(parseWorkflowId, { local: (id) => runCauseEffect(workflows.versions(id)), remote }),
      restoreVersion: scopedHandler(parseRestoreWorkflowVersion, {
        local: (input) => runCauseEffect(workflows.restoreVersion(input)),
        remote,
      }),
    },
  };
}
