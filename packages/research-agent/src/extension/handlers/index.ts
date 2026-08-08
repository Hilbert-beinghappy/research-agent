// SPDX-License-Identifier: Apache-2.0

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RegisterResearchToolsOptions } from "../tool-operations.ts";
import { registerKnowledgeHandlers } from "./knowledge.ts";
import { registerMemoryHandlers } from "./memory.ts";
import { registerMethodHandlers } from "./methods.ts";
import { registerSourceHandlers } from "./sources.ts";
import { registerWritingHandlers } from "./writing.ts";

export function registerResearchTools(pi: ExtensionAPI, options: RegisterResearchToolsOptions): void {
	registerSourceHandlers(pi, options);
	registerKnowledgeHandlers(pi, options);
	registerMethodHandlers(pi, options);
	registerWritingHandlers(pi, options);
	registerMemoryHandlers(pi, options);
}
