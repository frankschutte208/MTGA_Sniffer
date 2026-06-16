import type { MemoryScanRequest, MemoryScanResponse } from "@mtga/shared-types";
import { SCAN_API_VERSION } from "./config.js";
import { invokeUpstreamExporter } from "./invokeUpstreamExporter.js";

export const executeMemoryScanRequest = async (
  request: MemoryScanRequest,
): Promise<MemoryScanResponse> => {
  if (request.scanApiVersion !== SCAN_API_VERSION) {
    return {
      scanApiVersion: SCAN_API_VERSION,
      ok: false,
      cards: {},
      diagnostics: [`memory_scan_request_version_mismatch:${request.scanApiVersion}`],
      metrics: { exitCode: null },
    };
  }

  return invokeUpstreamExporter(request.scriptPath, request.anchors);
};
