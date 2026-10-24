import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/workflow";

export const messages = {
  "error.workflow.missing": "Ce workflow n’existe plus.",
  "error.workflow.versionMissing": "Cette version du workflow n’existe plus.",
  "error.workflow.annotation": "Les textes, les notes et les formes ne peuvent pas avoir de connexions.",
  "error.workflow.port": "Une étape ne peut pas recevoir ce type d’entrée.",
  "error.workflow.branch": "Seule une condition peut avoir des connexions oui et non.",
  "error.workflow.conditionBranch": "Chaque connexion d’une condition doit être oui ou non.",
  "error.workflow.duplicateEdge": "Ces deux étapes ont déjà cette connexion.",
  "error.workflow.cycle": "Un workflow ne peut pas revenir à une étape précédente.",
} as const satisfies PartialTranslation<typeof source>;
