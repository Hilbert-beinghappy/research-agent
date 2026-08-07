// SPDX-License-Identifier: Apache-2.0

import { createJiti } from "jiti/static";

const implementation = await createJiti(import.meta.url).import("./index.ts");

export const createResearchSdk = implementation.createResearchSdk;
export const RESEARCH_AGENT_SDK_VERSION = implementation.RESEARCH_AGENT_SDK_VERSION;
export const RESEARCH_SDK_METHODS = implementation.RESEARCH_SDK_METHODS;
