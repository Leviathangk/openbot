import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/workflow";

export const messages = {
  "error.workflow.missing": "Этого рабочего процесса больше нет.",
  "error.workflow.versionMissing": "Этой версии рабочего процесса больше нет.",
  "error.workflow.annotation": "У текста, заметок и фигур не может быть связей.",
  "error.workflow.port": "Шаг не может принимать такой тип входных данных.",
  "error.workflow.branch": "Только у условия могут быть связи «да» и «нет».",
  "error.workflow.conditionBranch": "Каждая связь от условия должна быть «да» или «нет».",
  "error.workflow.duplicateEdge": "У этих двух шагов уже есть такая связь.",
  "error.workflow.serverTooOld":
    "Этот сервер не поддерживает рабочие процессы. Обновите OpenBot на компьютере, на котором он работает.",
  "error.workflow.cycle": "Рабочий процесс не может вернуться к предыдущему шагу.",
} as const satisfies PartialTranslation<typeof source>;
