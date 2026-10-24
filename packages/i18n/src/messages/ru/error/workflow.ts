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
  "error.workflow.nodeUnsupported":
    "Эта версия OpenBot пока не может выполнять шаги с изображениями, файлами и сообщениями.",
  "error.workflow.interrupted": "OpenBot остановился во время этого шага. Запустите его снова.",
  "error.workflow.agentMissing": "Выберите агента для этого шага.",
  "error.workflow.handoffFailed": "OpenBot не смог отправить этот шаг агенту.",
  "error.workflow.agentStepEnded": "Сообщение агенту было удалено до его ответа.",
  "error.workflow.conditionUnclear": "Модель не ответила «да» или «нет».",
  "error.workflow.modelFailed": "Модель не смогла ответить. Запустите шаг снова.",
  "error.workflow.modelBusy": "Выполняется другой запрос к модели. Скоро запустите шаг снова.",
  "error.workflow.stepMissing": "Этого шага больше нет.",
  "error.workflow.nodeMissing": "Этого шага нет в рабочем процессе.",
  "error.workflow.runMissing": "Этого запуска больше нет.",
  "error.workflow.notRetryable": "Снова можно запустить только шаг, который завершился ошибкой или был остановлен.",
  "error.workflow.noDecision": "Этот шаг не ждет решения.",
  "error.workflow.outputPending": "Эта версия OpenBot пока не может публиковать в канал.",
} as const satisfies PartialTranslation<typeof source>;
