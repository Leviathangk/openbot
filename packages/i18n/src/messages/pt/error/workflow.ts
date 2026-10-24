import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/workflow";

export const messages = {
  "error.workflow.missing": "Este fluxo de trabalho não existe mais.",
  "error.workflow.versionMissing": "Esta versão do fluxo de trabalho não existe mais.",
  "error.workflow.annotation": "Textos, notas e formas não podem ter conexões.",
  "error.workflow.port": "Uma etapa não pode receber este tipo de entrada.",
  "error.workflow.branch": "Somente uma condição pode ter conexões de sim e não.",
  "error.workflow.conditionBranch": "Cada conexão de uma condição deve ser sim ou não.",
  "error.workflow.duplicateEdge": "Estas duas etapas já têm esta conexão.",
  "error.workflow.serverTooOld":
    "Este servidor não oferece suporte a fluxos de trabalho. Atualize o OpenBot no computador que o executa.",
  "error.workflow.cycle": "Um fluxo de trabalho não pode voltar a uma etapa anterior.",
} as const satisfies PartialTranslation<typeof source>;
