/**
 * How a run moves through its graph, without the database: which nodes a run includes, which of
 * them can start now, the inputs each gets, and the text a step sends to an agent or a model.
 *
 * A node starts when every node before it has ended. It runs when at least one incoming edge is
 * active, or when it has no incoming edge. An edge is active when the node before it ended with an
 * answer and, for a condition, when its branch is the condition's answer. A node with incoming edges
 * and no active one is skipped, so a failure or the other branch never leaves a run waiting. A
 * skipped node is looked at again on each pass, so a retried step can start the nodes after it.
 */

import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { isWorkflowStepKind, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from "@openbot/contracts/ipc";
import { isOpenStep, type StoredWorkflowStep } from "./workflow-run-store";

/** Node kinds and settings that this version cannot run. The canvas does not offer them. */
export function unsupportedNode(node: WorkflowNode): boolean {
  if (node.kind === "image" || node.kind === "asset") return true;
  if (node.kind === "trigger") return node.fields.trigger === "message";
  if (node.kind === "output") return node.fields.target === "file";
  return false;
}

export interface RunStart {
  triggerNodeId: string | null;
  fromNodeId: string | null;
}

/**
 * The nodes a run includes, and those of them it takes from an earlier answer instead of running.
 * - From a trigger: the nodes after the trigger, and every node they need that is not a trigger.
 * - From a node: that node and the nodes after it. A node they need that answered before gives that
 *   answer again; one that never answered runs.
 * - Otherwise every step of the graph.
 */
export function runScope(
  graph: WorkflowGraph,
  start: RunStart,
  answered: ReadonlySet<string>,
): { nodes: Set<string>; reused: Set<string> } {
  const steps = new Map(graph.nodes.filter((node) => isWorkflowStepKind(node.kind)).map((node) => [node.id, node]));
  const origin = start.triggerNodeId ?? start.fromNodeId;
  if (origin === null || !steps.has(origin)) return { nodes: new Set(steps.keys()), reused: new Set() };
  const after = reach(origin, outgoing(graph.edges));
  const before = incoming(graph.edges);
  const nodes = new Set(after);
  const reused = new Set<string>();
  const pending = [...after];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) break;
    for (const edge of before.get(id) ?? []) {
      const source = steps.get(edge.from);
      if (!source || nodes.has(source.id)) continue;
      if (start.triggerNodeId !== null && source.kind === "trigger") continue;
      nodes.add(source.id);
      if (start.fromNodeId !== null && answered.has(source.id)) {
        reused.add(source.id);
        continue;
      }
      pending.push(source.id);
    }
  }
  return { nodes, reused };
}

export type WalkAction = { nodeId: string; action: "run"; inputs: string[] } | { nodeId: string; action: "skip" };

/**
 * What can happen now, in graph order. `latest` is the newest attempt of each node of the run.
 * A node whose newest attempt is open or ended with something other than a skip waits or is done.
 */
export function nextActions(
  graph: WorkflowGraph,
  scope: ReadonlySet<string>,
  latest: ReadonlyMap<string, StoredWorkflowStep>,
): WalkAction[] {
  const before = incoming(graph.edges);
  const actions: WalkAction[] = [];
  for (const nodeId of graphOrder(graph, scope)) {
    const current = latest.get(nodeId);
    if (current && current.status !== "skipped") continue;
    const edges = (before.get(nodeId) ?? []).filter((edge) => scope.has(edge.from));
    // Another trigger's edge never becomes active in this run.
    const outside = (before.get(nodeId) ?? []).length > edges.length;
    if (edges.some((edge) => isWaiting(latest.get(edge.from)))) continue;
    const inputs = edges.flatMap((edge) => {
      const source = latest.get(edge.from);
      return source && edgeActive(edge, source) ? [source.output ?? ""] : [];
    });
    if (inputs.length === 0 && (edges.length > 0 || outside)) {
      if (!current) actions.push({ nodeId, action: "skip" });
      continue;
    }
    actions.push({ nodeId, action: "run", inputs });
  }
  return actions;
}

/** The inputs of a node that runs alone: the newest answers of the nodes before it. */
export function soloInputs(
  graph: WorkflowGraph,
  nodeId: string,
  answered: ReadonlyMap<string, StoredWorkflowStep>,
): string[] {
  return (incoming(graph.edges).get(nodeId) ?? []).flatMap((edge) => {
    const source = answered.get(edge.from);
    return source && edgeActive(edge, source) ? [source.output ?? ""] : [];
  });
}

function edgeActive(edge: WorkflowEdge, source: StoredWorkflowStep): boolean {
  if (source.status !== "done") return false;
  return source.kind !== "condition" || edge.branch === source.branch;
}

function isWaiting(step: StoredWorkflowStep | undefined): boolean {
  return step === undefined || isOpenStep(step);
}

/** The nodes of `scope` with every node before another; the graph rules keep it free of loops. */
function graphOrder(graph: WorkflowGraph, scope: ReadonlySet<string>): string[] {
  const edges = graph.edges.filter((edge) => scope.has(edge.from) && scope.has(edge.to));
  const remaining = new Map([...scope].map((id) => [id, 0]));
  for (const edge of edges) remaining.set(edge.to, (remaining.get(edge.to) ?? 0) + 1);
  const next = outgoing(edges);
  // The canvas order breaks ties, so a pass is the same each time.
  const ready = graph.nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    for (const edge of next.get(id) ?? []) {
      const left = (remaining.get(edge.to) ?? 1) - 1;
      remaining.set(edge.to, left);
      if (left === 0) ready.push(edge.to);
    }
  }
  return order;
}

/** The edges by the node they leave. */
function outgoing(edges: readonly WorkflowEdge[]): Map<string, WorkflowEdge[]> {
  return edgesBy(edges, "from");
}

/** The edges by the node they enter. */
function incoming(edges: readonly WorkflowEdge[]): Map<string, WorkflowEdge[]> {
  return edgesBy(edges, "to");
}

function edgesBy(edges: readonly WorkflowEdge[], end: "from" | "to"): Map<string, WorkflowEdge[]> {
  const map = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    const list = map.get(edge[end]);
    if (list) list.push(edge);
    else map.set(edge[end], [edge]);
  }
  return map;
}

function reach(origin: string, next: ReadonlyMap<string, readonly WorkflowEdge[]>): Set<string> {
  const seen = new Set([origin]);
  const pending = [origin];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) break;
    for (const edge of next.get(id) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      pending.push(edge.to);
    }
  }
  return seen;
}

/** A field as text, or "" when the node has none. */
export function fieldText(node: WorkflowNode, name: string): string {
  const value = node.fields[name];
  return typeof value === "string" ? value : "";
}

/** The inputs as one text, cut to the step limit. A provider reads it, so the words stay English. */
export function inputText(inputs: readonly string[]): string {
  const parts = inputs.map((input) => input.trim()).filter(Boolean);
  const text =
    parts.length <= 1 ? (parts[0] ?? "") : parts.map((part, index) => `Input ${index + 1}:\n\n${part}`).join("\n\n");
  return text.length > INPUT_LIMITS.workflowStepInput ? text.slice(0, INPUT_LIMITS.workflowStepInput) : text;
}

/** The message an agent step sends. */
export function agentStepText(workflowTitle: string, task: string, input: string): string {
  const parts = [`The workflow "${workflowTitle}" gives you one step.`];
  parts.push(task.trim() || "Do this step of the workflow with the input below.");
  if (input) parts.push(`--- input ---\n${input}`);
  return parts.join("\n\n");
}

/** The prompt of a model step: its own prompt, then the inputs. */
export function modelStepPrompt(system: string, prompt: string, input: string): string {
  return [system.trim(), prompt.trim(), input ? `--- input ---\n${input}` : ""].filter(Boolean).join("\n\n");
}

/** The prompt of a condition. The model must answer one word. */
export function conditionPrompt(rule: string, input: string): string {
  return [
    "You judge one condition of a workflow. Read the input, then answer with one word: yes or no.",
    `Condition: ${rule.trim() || "The input is not empty."}`,
    `--- input ---\n${input || "(empty)"}`,
  ].join("\n\n");
}

/** The answer of a condition, or null when the model did not answer yes or no. */
export function conditionAnswer(text: string): "yes" | "no" | null {
  const word = /^[^a-z]*([a-z]+)/iu.exec(text.trim())?.[1]?.toLowerCase();
  return word === "yes" || word === "no" ? word : null;
}
