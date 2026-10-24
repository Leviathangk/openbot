import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/workflow";

export const messages = {
  "error.workflow.missing": "Ten przepływ pracy już nie istnieje.",
  "error.workflow.versionMissing": "Ta wersja przepływu pracy już nie istnieje.",
  "error.workflow.annotation": "Teksty, notatki i kształty nie mogą mieć połączeń.",
  "error.workflow.port": "Krok nie może przyjąć tego typu danych.",
  "error.workflow.branch": "Tylko warunek może mieć połączenia tak i nie.",
  "error.workflow.conditionBranch": "Każde połączenie z warunku musi być tak albo nie.",
  "error.workflow.duplicateEdge": "Te dwa kroki mają już to połączenie.",
  "error.workflow.cycle": "Przepływ pracy nie może wrócić do wcześniejszego kroku.",
} as const satisfies PartialTranslation<typeof source>;
