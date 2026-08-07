// SPDX-License-Identifier: Apache-2.0

import { createJiti } from "jiti/static";

const implementation = await createJiti(import.meta.url).import("./server.ts");

export const runResearchRpcServer = implementation.runResearchRpcServer;
