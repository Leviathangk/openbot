import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/workflow";

export const messages = {
  "error.workflow.missing": "Dieser Workflow existiert nicht mehr.",
  "error.workflow.versionMissing": "Diese Version des Workflows existiert nicht mehr.",
  "error.workflow.annotation": "Texte, Notizen und Formen können keine Verbindungen haben.",
  "error.workflow.port": "Ein Schritt kann diese Art von Eingabe nicht annehmen.",
  "error.workflow.branch": "Nur eine Bedingung kann Ja- und Nein-Verbindungen haben.",
  "error.workflow.conditionBranch": "Jede Verbindung einer Bedingung muss Ja oder Nein sein.",
  "error.workflow.duplicateEdge": "Diese zwei Schritte haben diese Verbindung bereits.",
  "error.workflow.serverTooOld":
    "Dieser Server unterstützt keine Workflows. Aktualisiere OpenBot auf dem Computer, auf dem er läuft.",
  "error.workflow.cycle": "Ein Workflow kann nicht zu einem früheren Schritt zurückgehen.",
} as const satisfies PartialTranslation<typeof source>;
