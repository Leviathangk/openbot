import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/workflow";

export const messages = {
  "error.workflow.missing": "Bu iş akışı artık yok.",
  "error.workflow.versionMissing": "İş akışının bu sürümü artık yok.",
  "error.workflow.annotation": "Metinler, notlar ve şekiller bağlantı içeremez.",
  "error.workflow.port": "Bir adım bu tür girdiyi alamaz.",
  "error.workflow.branch": "Yalnızca bir koşul evet ve hayır bağlantılarına sahip olabilir.",
  "error.workflow.conditionBranch": "Bir koşuldan çıkan her bağlantı evet veya hayır olmalıdır.",
  "error.workflow.duplicateEdge": "Bu iki adımda bu bağlantı zaten var.",
  "error.workflow.cycle": "Bir iş akışı önceki bir adıma geri dönemez.",
} as const satisfies PartialTranslation<typeof source>;
