import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/workflow";

export const messages = {
  "error.workflow.missing": "Questo workflow non esiste più.",
  "error.workflow.versionMissing": "Questa versione del workflow non esiste più.",
  "error.workflow.annotation": "Testi, note e forme non possono avere connessioni.",
  "error.workflow.port": "Un passaggio non può ricevere questo tipo di input.",
  "error.workflow.branch": "Solo una condizione può avere connessioni sì e no.",
  "error.workflow.conditionBranch": "Ogni connessione da una condizione deve essere sì o no.",
  "error.workflow.duplicateEdge": "Questi due passaggi hanno già questa connessione.",
  "error.workflow.serverTooOld": "Questo server non supporta i workflow. Aggiorna OpenBot sul computer che lo esegue.",
  "error.workflow.cycle": "Un workflow non può tornare a un passaggio precedente.",
} as const satisfies PartialTranslation<typeof source>;
