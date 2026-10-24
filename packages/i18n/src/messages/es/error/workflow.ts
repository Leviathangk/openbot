import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/workflow";

export const messages = {
  "error.workflow.missing": "Este flujo de trabajo ya no existe.",
  "error.workflow.versionMissing": "Esta versión del flujo de trabajo ya no existe.",
  "error.workflow.annotation": "Los textos, las notas y las formas no pueden tener conexiones.",
  "error.workflow.port": "Un paso no puede recibir este tipo de entrada.",
  "error.workflow.branch": "Solo una condición puede tener conexiones de sí y no.",
  "error.workflow.conditionBranch": "Cada conexión de una condición debe ser sí o no.",
  "error.workflow.duplicateEdge": "Estos dos pasos ya tienen esta conexión.",
  "error.workflow.cycle": "Un flujo de trabajo no puede volver a un paso anterior.",
} as const satisfies PartialTranslation<typeof source>;
