import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/workflow";

export const messages = {
  "error.workflow.missing": "このワークフローはもう存在しません。",
  "error.workflow.versionMissing": "このバージョンのワークフローはもう存在しません。",
  "error.workflow.annotation": "テキスト、メモ、図形には接続を付けられません。",
  "error.workflow.port": "このステップはこの種類の入力を受け取れません。",
  "error.workflow.branch": "「はい」と「いいえ」の接続を持てるのは条件だけです。",
  "error.workflow.conditionBranch": "条件からの接続は、それぞれ「はい」か「いいえ」である必要があります。",
  "error.workflow.duplicateEdge": "この 2 つのステップにはすでにこの接続があります。",
  "error.workflow.serverTooOld":
    "このサーバーはワークフローに対応していません。サーバーを実行しているコンピューターの OpenBot を更新してください。",
  "error.workflow.cycle": "ワークフローは前のステップに戻れません。",
} as const satisfies PartialTranslation<typeof source>;
