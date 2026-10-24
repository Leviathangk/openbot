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
  "error.workflow.nodeUnsupported":
    "Esta versão do OpenBot ainda não pode executar etapas de imagem, arquivo e mensagem.",
  "error.workflow.interrupted": "O OpenBot parou enquanto esta etapa era executada. Execute-a novamente.",
  "error.workflow.agentMissing": "Escolha um agente para esta etapa.",
  "error.workflow.handoffFailed": "O OpenBot não conseguiu enviar esta etapa ao agente.",
  "error.workflow.agentStepEnded": "A mensagem ao agente foi removida antes da resposta.",
  "error.workflow.conditionUnclear": "O modelo não respondeu sim ou não.",
  "error.workflow.modelFailed": "O modelo não conseguiu responder. Execute a etapa novamente.",
  "error.workflow.modelBusy": "Outra solicitação ao modelo está em andamento. Execute a etapa novamente em breve.",
  "error.workflow.stepMissing": "Esta etapa não existe mais.",
  "error.workflow.nodeMissing": "Esta etapa não está no fluxo de trabalho.",
  "error.workflow.runMissing": "Esta execução não existe mais.",
  "error.workflow.notRetryable": "Somente uma etapa que falhou ou parou pode ser executada novamente.",
  "error.workflow.noDecision": "Esta etapa não aguarda uma decisão.",
  "error.workflow.outputPending": "Esta versão do OpenBot ainda não pode publicar em um canal.",
} as const satisfies PartialTranslation<typeof source>;
