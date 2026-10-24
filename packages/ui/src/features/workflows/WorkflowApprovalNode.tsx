/** An approval: a stop in the run that waits for the user. */

import { Button, Check, CircleCheck, Textarea, UserCheck, X } from "@openbot/ui";
import { createEffect, createSignal, Show, untrack } from "solid-js";
import { useText } from "../../text";
import { useBoard } from "./workflow-board";
import { Field, NodeShell, NodeToolbar, useLocked, useTextField } from "./workflow-node-parts";

/* ----------------------------------------------------------- Approval */

/**
 * A stop in the run. The run waits here until the user approves or rejects the question. Reject
 * stops the run.
 */
export function ApprovalNode(props: { id: string; question?: string }) {
  const board = useBoard();
  const { t, format } = useText();
  const [question, setQuestion] = useTextField(
    () => props.id,
    "question",
    untrack(() => props.question ?? ""),
  );
  /** The answer of the user, with the time of the answer. */
  const [decision, setDecision] = createSignal<{ kind: "approved" | "rejected"; at: Date }>();
  const approvedText = (at: Date) =>
    t("workflow.approval.approvedAt", { time: format.date(at, { hour: "2-digit", minute: "2-digit" }) });
  const [locked, setLocked] = useLocked(() => props.id);
  const waiting = () => board.status(props.id) === "approval" && decision() === undefined;
  // A new run asks again.
  createEffect(
    () => board.status(props.id),
    (status) => {
      if (status === "waiting") setDecision(undefined);
    },
  );
  return (
    <NodeShell
      id={props.id}
      label={t("workflow.approval.title")}
      icon={<UserCheck aria-hidden="true" />}
      kind="approval"
      inputs={["text"]}
      output="text"
      requires
      toolbar={<NodeToolbar id={props.id} name={t("workflow.approval.name")} locked={locked()} onLock={setLocked} />}
    >
      <Field class="wfn-block-field">
        <Textarea
          class="wfn-input"
          aria-label={t("workflow.approval.question")}
          placeholder={t("workflow.approval.questionPlaceholder")}
          readonly={locked()}
          value={question()}
          onValueChange={setQuestion}
        />
      </Field>
      <Show when={waiting()}>
        <div class="wfn-block-actions">
          <Button
            size="sm"
            onClick={() => {
              const at = new Date();
              setDecision({ kind: "approved", at });
              board.record(props.id, approvedText(at));
              board.decide(props.id, true);
            }}
          >
            <Check aria-hidden="true" />
            {t("workflow.approval.approve")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setDecision({ kind: "rejected", at: new Date() });
              board.decide(props.id, false);
            }}
          >
            <X aria-hidden="true" />
            {t("workflow.approval.reject")}
          </Button>
        </div>
      </Show>
      <Show when={decision()?.kind === "rejected"}>
        <p class="wfn-alert" data-tone="danger">
          <X aria-hidden="true" />
          <span class="wfn-alert-text">{t("workflow.approval.rejected")}</span>
        </p>
      </Show>
      <Show when={decision()?.kind === "approved" ? decision()?.at : undefined}>
        {(at) => (
          <p class="wfn-alert" data-tone="success">
            <CircleCheck aria-hidden="true" />
            <span class="wfn-alert-text">{approvedText(at())}</span>
          </p>
        )}
      </Show>
    </NodeShell>
  );
}
