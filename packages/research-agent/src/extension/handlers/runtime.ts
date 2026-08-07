// SPDX-License-Identifier: Apache-2.0

import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResearchResult } from "../../contracts/schemas.ts";
import {
	authorizeModelVisiblePayload,
	type CurrentProject,
	type RegisterResearchToolsOptions,
	toolResponse,
	unavailableToolResult,
} from "../tool-operations.ts";

export async function runModelVisibleHandler<Value>(
	ctx: ExtensionContext,
	options: RegisterResearchToolsOptions,
	dataClasses: readonly string[],
	denialMessage: string,
	handler: (project: CurrentProject) => Promise<ResearchResult<Value>>,
): Promise<AgentToolResult<ResearchResult<Value>>> {
	try {
		const project = await options.requireProject(ctx);
		const blocked = authorizeModelVisiblePayload(project, ctx, dataClasses, denialMessage);
		if (blocked !== null) return toolResponse(blocked);
		return toolResponse(await handler(project));
	} catch (error) {
		return unavailableToolResult(error);
	}
}
