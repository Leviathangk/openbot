/**
 * Workflows: graphs of steps that a person draws on a canvas, and their versions.
 *
 * The store keeps the rows and checks the graph rules. This service is the one way in for main and
 * the Team API, and it says which workflow changed, so every view that shows it reads it again.
 */

import type {
  CreateWorkflowInput,
  RenameWorkflowInput,
  RestoreWorkflowVersionInput,
  SaveWorkflowGraphInput,
  WorkflowDetail,
  WorkflowSaveResult,
  WorkflowSummary,
  WorkflowVersion,
} from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { Context, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect";
import { type WorkflowStore, WorkflowStoreError } from "./workflow-store";

class WorkflowFailed extends Schema.TaggedError<WorkflowFailed>()("WorkflowFailed", {
  cause: Schema.Defect(),
}) {}

export interface WorkflowsDependencies {
  store: WorkflowStore;
  /** The workflow whose graph, title, versions or runs changed. */
  changed(workflowId: string): void;
  now?: () => Date;
}

export interface WorkflowsShape {
  list(): Effect.Effect<WorkflowSummary[], WorkflowFailed>;
  get(workflowId: string): Effect.Effect<WorkflowDetail, WorkflowFailed>;
  create(input: CreateWorkflowInput): Effect.Effect<WorkflowDetail, WorkflowFailed>;
  rename(input: RenameWorkflowInput): Effect.Effect<WorkflowSummary, WorkflowFailed>;
  remove(workflowId: string): Effect.Effect<void, WorkflowFailed>;
  saveGraph(input: SaveWorkflowGraphInput): Effect.Effect<WorkflowSaveResult, WorkflowFailed>;
  versions(workflowId: string): Effect.Effect<WorkflowVersion[], WorkflowFailed>;
  restoreVersion(input: RestoreWorkflowVersionInput): Effect.Effect<WorkflowDetail, WorkflowFailed>;
}

class Workflows extends Context.Service<Workflows, WorkflowsShape>()("openbot/backend/Workflows") {
  static layer(dependencies: WorkflowsDependencies) {
    return Layer.succeed(
      Workflows,
      (() => {
        const { store, changed } = dependencies;
        const now = () => (dependencies.now ?? (() => new Date()))();
        const attempt = <A>(work: () => A) =>
          Effect.try({ try: work, catch: (cause) => new WorkflowFailed({ cause }) });

        const list = Effect.fn("Workflows.list")(function* () {
          return yield* attempt(() => store.list());
        });

        const get = Effect.fn("Workflows.get")(function* (workflowId: string) {
          return yield* attempt(() => {
            const detail = store.detail(workflowId);
            if (!detail) throw new WorkflowStoreError(sourceText("error.workflow.missing"));
            return detail;
          });
        });

        const create = Effect.fn("Workflows.create")(function* (input: CreateWorkflowInput) {
          const detail = yield* attempt(() => store.create(input, now()));
          changed(detail.summary.id);
          return detail;
        });

        const rename = Effect.fn("Workflows.rename")(function* (input: RenameWorkflowInput) {
          const summary = yield* attempt(() => store.rename(input.workflowId, input.title, now()));
          changed(summary.id);
          return summary;
        });

        const remove = Effect.fn("Workflows.remove")(function* (workflowId: string) {
          const removed = yield* attempt(() => store.remove(workflowId, now()));
          if (removed) changed(workflowId);
        });

        const saveGraph = Effect.fn("Workflows.saveGraph")(function* (input: SaveWorkflowGraphInput) {
          const result = yield* attempt(() =>
            store.saveGraph(input.workflowId, input.baseRevision, input.graph, now()),
          );
          // A conflict changed nothing: the editor that saved gets the newer workflow in the answer.
          if (result.ok) changed(input.workflowId);
          return result;
        });

        const versions = Effect.fn("Workflows.versions")(function* (workflowId: string) {
          return yield* attempt(() => {
            if (!store.detail(workflowId)) throw new WorkflowStoreError(sourceText("error.workflow.missing"));
            return store.versions(workflowId);
          });
        });

        const restoreVersion = Effect.fn("Workflows.restoreVersion")(function* (input: RestoreWorkflowVersionInput) {
          const detail = yield* attempt(() => store.restoreVersion(input.workflowId, input.versionId, now()));
          changed(input.workflowId);
          return detail;
        });

        return Workflows.of({ list, get, create, rename, remove, saveGraph, versions, restoreVersion });
      })(),
    );
  }
}

export interface WorkflowsHandle extends WorkflowsShape {
  close(): Effect.Effect<void>;
}

/** Starts the service on its own runtime; `close` stops what it forked. */
export const createWorkflows = Effect.fn("createWorkflows")(function* (dependencies: WorkflowsDependencies) {
  const runtime = ManagedRuntime.make(Workflows.layer(dependencies));
  const context = yield* runtime.contextEffect.pipe(
    Effect.onExit((exit) => (Exit.isFailure(exit) ? runtime.disposeEffect : Effect.void)),
  );
  const service = Context.get(context, Workflows);
  return { ...service, close: () => runtime.disposeEffect } satisfies WorkflowsHandle;
});
