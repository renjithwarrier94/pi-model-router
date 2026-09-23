import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssessmentExtension } from "./adapters/pi/assessment-extension.js";

/** Pi package entry point; registers consent-gated assessment and routing commands. */
export default function modelRouter(pi: ExtensionAPI): void {
  createAssessmentExtension()(pi);
}
