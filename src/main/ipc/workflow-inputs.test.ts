// @vitest-environment node

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { describe, expect, it } from "vitest";
import {
  parseCreateWorkflow,
  parseDecideWorkflowStep,
  parseRetryWorkflowStep,
  parseRunWorkflowStep,
  parseSaveWorkflowGraph,
  parseStartWorkflowRun,
  parseWorkflowRuns,
  parseWorkflowTrigger,
} from "./workflow-inputs";

const node = (id: string, fields: object = {}) => ({ id, kind: "prompt", at: { x: 0, y: 0 }, fields });
const save = (graph: unknown) => ({ workflowId: "workflow-1", baseRevision: 0, graph });

describe("workflow payloads from the renderer", () => {
  it("keeps only the known fields of a valid save", () => {
    const graph = { nodes: [node("a", { text: "hi" })], edges: [], strokes: [] };
    expect(parseSaveWorkflowGraph({ ...save(graph), extra: "dropped" })).toEqual(save(graph));
  });

  it.each([
    ["an unknown node kind", { nodes: [{ ...node("a"), kind: "script" }], edges: [], strokes: [] }],
    [
      "an edge to a node that is not in the graph",
      {
        nodes: [node("a")],
        edges: [{ id: "e", from: "a", to: "b", type: "text" }],
        strokes: [],
      },
    ],
    ["a field that is an object", { nodes: [node("a", { text: { toString: "x" } })], edges: [], strokes: [] }],
    [
      "a schedule on a node that is not a trigger",
      {
        nodes: [{ ...node("a"), schedule: { kind: "daily", time: "09:00" } }],
        edges: [],
        strokes: [],
      },
    ],
    [
      "too many nodes",
      {
        nodes: Array.from({ length: INPUT_LIMITS.workflowNodes + 1 }, (_, index) => node(`n${index}`)),
        edges: [],
        strokes: [],
      },
    ],
    [
      "a field over the text limit",
      {
        nodes: [node("a", { text: "x".repeat(INPUT_LIMITS.workflowNodeText + 1) })],
        edges: [],
        strokes: [],
      },
    ],
    [
      "a coordinate that is not finite",
      { nodes: [{ ...node("a"), at: { x: Number.NaN, y: 0 } }], edges: [], strokes: [] },
    ],
  ])("refuses %s", (_name, graph) => {
    expect(() => parseSaveWorkflowGraph(save(graph))).toThrow("Invalid workflow graph.");
  });

  it("refuses a stale revision that is not a whole number, and a title over the limit", () => {
    expect(() =>
      parseSaveWorkflowGraph({ ...save({ nodes: [], edges: [], strokes: [] }), baseRevision: 1.5 }),
    ).toThrow();
    expect(() => parseCreateWorkflow({ title: "x".repeat(INPUT_LIMITS.workflowTitle + 1) })).toThrow(
      "Invalid workflow.",
    );
    expect(() => parseCreateWorkflow({ title: "   " })).toThrow("Invalid workflow.");
  });

  it("keeps only the known fields of the run requests", () => {
    expect(parseStartWorkflowRun({ workflowId: "w", requestId: "r", extra: 1 })).toEqual({
      workflowId: "w",
      requestId: "r",
    });
    expect(parseRunWorkflowStep({ workflowId: "w", nodeId: "n", requestId: "r", fromNodeId: "x" })).toEqual({
      workflowId: "w",
      nodeId: "n",
      requestId: "r",
    });
    expect(parseDecideWorkflowStep({ stepId: "s", approved: false, output: "x" })).toEqual({
      stepId: "s",
      approved: false,
    });
    expect(parseWorkflowTrigger({ workflowId: "w", nodeId: "n", secret: "whsec_x" })).toEqual({
      workflowId: "w",
      nodeId: "n",
    });
  });

  it.each([
    ["a run without a request id", () => parseStartWorkflowRun({ workflowId: "w" })],
    ["a start node that is not text", () => parseStartWorkflowRun({ workflowId: "w", requestId: "r", fromNodeId: 1 })],
    ["a retry without a step", () => parseRetryWorkflowStep({ requestId: "r" })],
    ["a decision that is not a boolean", () => parseDecideWorkflowStep({ stepId: "s", approved: "yes" })],
    [
      "a runs page over the limit",
      () => parseWorkflowRuns({ workflowId: "w", limit: INPUT_LIMITS.workflowRunsPage + 1 }),
    ],
    ["a runs page of zero", () => parseWorkflowRuns({ workflowId: "w", limit: 0 })],
    ["a webhook secret request without a node", () => parseWorkflowTrigger({ workflowId: "w" })],
  ])("refuses %s", (_name, parse) => {
    expect(parse).toThrow();
  });
});
