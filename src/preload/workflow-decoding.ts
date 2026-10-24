// What main answers for workflows: the list, one workflow, a save, and the version history.

import { isWorkflowDetail, isWorkflowSaveResult, isWorkflowSummary, isWorkflowVersion } from "@openbot/contracts/ipc";
import { guardedDecoder, guardedListDecoder } from "@openbot/contracts/ipc-decoding";

export const decodeWorkflowSummaries = guardedListDecoder(isWorkflowSummary, "workflow list response");
export const decodeWorkflowSummary = guardedDecoder(isWorkflowSummary, "workflow summary response");
export const decodeWorkflowDetail = guardedDecoder(isWorkflowDetail, "workflow response");
export const decodeWorkflowSaveResult = guardedDecoder(isWorkflowSaveResult, "workflow save response");
export const decodeWorkflowVersions = guardedListDecoder(isWorkflowVersion, "workflow versions response");
