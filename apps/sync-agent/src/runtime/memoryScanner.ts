import type { MemoryScanAnchor, MemoryScanResponse } from "@mtga/shared-types";
import { executeMemoryScanRequest } from "./scanner/runner.js";
import { SCAN_API_VERSION } from "./scanner/config.js";

export type MemoryScanResult = MemoryScanResponse;
export type { MemoryScanAnchor };

export const runMemoryScan = async (
  scriptPath: string,
  anchors: MemoryScanAnchor[],
): Promise<MemoryScanResult> =>
  executeMemoryScanRequest({
    scanApiVersion: SCAN_API_VERSION,
    scriptPath,
    anchors,
  });
