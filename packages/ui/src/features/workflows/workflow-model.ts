/**
 * What the workflow canvas offers. A host that cannot run a node kind, a trigger or an output does not
 * get it in the add menu or in the node's choices; the host still refuses it in a run.
 */

import {
  WORKFLOW_NODE_KINDS,
  type WorkflowNodeKind,
  type WorkflowOutputTarget,
  type WorkflowTriggerType,
} from "@openbot/contracts/ipc";

export interface WorkflowFeatures {
  /** The node kinds that the add menu offers. */
  kinds: readonly WorkflowNodeKind[];
  /** The trigger types that a trigger node offers. */
  triggers: readonly WorkflowTriggerType[];
  /** The places that an output node offers. */
  outputs: readonly WorkflowOutputTarget[];
  /** Whether a node can take a file from the computer. */
  uploads: boolean;
  /** Whether the canvas shows the other people on it. */
  presence: boolean;
}

/** Image and file steps, file outputs and message triggers do not run in this version. */
export const WORKFLOW_FEATURES_V1: WorkflowFeatures = {
  kinds: WORKFLOW_NODE_KINDS.filter((kind) => kind !== "image" && kind !== "asset"),
  triggers: ["manual", "schedule", "webhook"],
  outputs: ["notify", "channel"],
  uploads: false,
  presence: false,
};
