import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssessmentExtension } from "./adapters/pi/assessment-extension.js";

/** Pi package entry point; v1 observes and reports assessments, never switches models. */
export default function modelRouter(pi: ExtensionAPI): void {
  createAssessmentExtension()(pi);
}
