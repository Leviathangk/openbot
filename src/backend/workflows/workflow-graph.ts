/**
 * The rules of a workflow graph that need the meaning of its nodes, without the database: which
 * port types each kind takes and sends, where a branch edge may start, and that the steps form no
 * loop. The shape and the limits of a graph are the contract's (`isWorkflowGraph`).
 */

import {
  isWorkflowStepKind,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowPortType,
} from "@openbot/contracts/ipc";

export type WorkflowGraphProblem = "annotation" | "port" | "branch" | "condition-branch" | "duplicate" | "cycle";

const ALL_PORTS = ["text", "image", "file"] as const satisfies readonly WorkflowPortType[];

/** The port types each step kind takes in and sends out. The canvas offers the same ports. */
const PORTS: Record<WorkflowNodeKind, { in: readonly WorkflowPortType[]; out: readonly WorkflowPortType[] }> = {
  trigger: { in: [], out: ["text"] },
  prompt: { in: [], out: ["text"] },
  asset: { in: [], out: ALL_PORTS },
  llm: { in: ALL_PORTS, out: ["text"] },
  agent: { in: ALL_PORTS, out: ["text"] },
  image: { in: ["text", "image"], out: ["image"] },
  condition: { in: ["text"], out: ["text"] },
  approval: { in: ["text"], out: ["text"] },
  output: { in: ALL_PORTS, out: [] },
  text: { in: [], out: [] },
  note: { in: [], out: [] },
  shape: { in: [], out: [] },
};

/** Why the graph is not a workflow that can run, or null when it is. */
export function workflowGraphProblem(graph: WorkflowGraph): WorkflowGraphProblem | null {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    // `isWorkflowGraph` already holds every edge to two nodes of the graph.
    if (!from || !to) return "port";
    const problem = edgeProblem(from, to, edge);
    if (problem) return problem;
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.type}\u0000${edge.branch ?? ""}`;
    if (seen.has(key)) return "duplicate";
    seen.add(key);
  }
  return hasCycle(graph.edges) ? "cycle" : null;
}

function edgeProblem(from: WorkflowNode, to: WorkflowNode, edge: WorkflowEdge): WorkflowGraphProblem | null {
  if (!isWorkflowStepKind(from.kind) || !isWorkflowStepKind(to.kind)) return "annotation";
  if (!PORTS[from.kind].out.includes(edge.type) || !PORTS[to.kind].in.includes(edge.type)) return "port";
  if (from.kind === "condition") return edge.branch === undefined ? "condition-branch" : null;
  return edge.branch === undefined ? null : "branch";
}

function hasCycle(edges: readonly WorkflowEdge[]): boolean {
  const next = new Map<string, string[]>();
  for (const edge of edges) next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  const done = new Set<string>();
  const open = new Set<string>();
  // Depth first, without recursion: a long chain must not reach the stack limit.
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    const stack: { id: string; index: number }[] = [{ id: start, index: 0 }];
    open.add(start);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const target = next.get(top.id)?.[top.index];
      if (target === undefined) {
        stack.pop();
        open.delete(top.id);
        done.add(top.id);
        continue;
      }
      top.index += 1;
      if (open.has(target)) return true;
      if (done.has(target)) continue;
      open.add(target);
      stack.push({ id: target, index: 0 });
    }
  }
  return false;
}
