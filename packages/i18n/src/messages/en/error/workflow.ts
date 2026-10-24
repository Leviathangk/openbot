import { defineMessages } from "../../../message";

/** Errors that the workflow store and runtime send. */
export const messages = defineMessages("error.workflow", {
  "error.workflow.missing": "This workflow no longer exists.",
  "error.workflow.versionMissing": "This version of the workflow no longer exists.",
  "error.workflow.annotation": "Text, notes and shapes cannot have connections.",
  "error.workflow.port": "A step cannot take this type of input.",
  "error.workflow.branch": "Only a condition can have yes and no connections.",
  "error.workflow.conditionBranch": "Each connection from a condition must be yes or no.",
  "error.workflow.duplicateEdge": "These two steps already have this connection.",
  "error.workflow.serverTooOld": "This server does not support workflows. Update OpenBot on the computer that runs it.",
  "error.workflow.cycle": "A workflow cannot go back to an earlier step.",
  "error.workflow.nodeUnsupported": "This version of OpenBot cannot run image, file and message steps yet.",
  "error.workflow.interrupted": "OpenBot stopped while this step ran. Run it again.",
  "error.workflow.agentMissing": "Choose an agent for this step.",
  "error.workflow.handoffFailed": "OpenBot could not send this step to its agent.",
  "error.workflow.agentStepEnded": "The agent's message for this step was removed before it answered.",
  "error.workflow.conditionUnclear": "The model did not answer yes or no.",
  "error.workflow.modelFailed": "The model could not answer. Run the step again.",
  "error.workflow.modelBusy": "Another model request is running. Run the step again soon.",
  "error.workflow.stepMissing": "This step no longer exists.",
  "error.workflow.nodeMissing": "This step is not in the workflow.",
  "error.workflow.runMissing": "This run no longer exists.",
  "error.workflow.notRetryable": "Only a step that failed or stopped can run again.",
  "error.workflow.noDecision": "This step does not wait for a decision.",
  "error.workflow.outputPending": "This version of OpenBot cannot post to a channel yet.",
});
