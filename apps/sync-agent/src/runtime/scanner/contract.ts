import type { CardCountMap, MemoryScanMetrics } from "@mtga/shared-types";
import { SCAN_API_VERSION } from "./config.js";

interface RawMemoryScanPayload {
  scanApiVersion?: number;
  ok?: boolean;
  cards?: Record<string, number>;
  error?: string;
  inspected_regions?: number;
  candidate_blocks?: number;
  read_errors?: number;
  anchors_provided?: number;
  anchors_matched?: number;
}

export interface NormalizedScanPayload {
  scanApiVersion: number;
  ok: boolean;
  cards: CardCountMap;
  diagnostics: string[];
  metrics: MemoryScanMetrics;
}

export const parseRawScanPayload = (stdout: string): RawMemoryScanPayload | null => {
  const out = stdout.trim();
  if (!out) {
    return null;
  }
  try {
    return JSON.parse(out) as RawMemoryScanPayload;
  } catch {
    return null;
  }
};

export const normalizeScanPayload = (
  rawPayload: RawMemoryScanPayload | null,
  stderr: string,
  exitCode: number | null,
): NormalizedScanPayload => {
  const parsedVersion = rawPayload?.scanApiVersion;
  const versionIsValid = parsedVersion === SCAN_API_VERSION;
  const cards = rawPayload?.cards ?? {};
  const metrics: MemoryScanMetrics = {
    inspectedRegions: rawPayload?.inspected_regions,
    candidateBlocks: rawPayload?.candidate_blocks,
    readErrors: rawPayload?.read_errors,
    anchorsProvided: rawPayload?.anchors_provided,
    anchorsMatched: rawPayload?.anchors_matched,
    exitCode,
  };

  const diagnostics = [
    parsedVersion === undefined ? "memory_scan_contract_missing_version" : null,
    parsedVersion !== undefined && !versionIsValid
      ? `memory_scan_contract_version_mismatch:${parsedVersion}`
      : null,
    rawPayload?.error ? `memory_scan_error:${rawPayload.error}` : null,
    metrics.inspectedRegions !== undefined ? `memory_scan_regions:${metrics.inspectedRegions}` : null,
    metrics.candidateBlocks !== undefined
      ? `memory_scan_candidate_blocks:${metrics.candidateBlocks}`
      : null,
    metrics.readErrors !== undefined ? `memory_scan_read_errors:${metrics.readErrors}` : null,
    metrics.anchorsProvided !== undefined
      ? `memory_scan_anchors_provided:${metrics.anchorsProvided}`
      : null,
    metrics.anchorsMatched !== undefined ? `memory_scan_anchors_matched:${metrics.anchorsMatched}` : null,
    stderr ? `memory_scan_stderr:${stderr}` : null,
    `memory_scan_exit_code:${exitCode ?? "null"}`,
  ].filter((value): value is string => Boolean(value));

  const ok = versionIsValid && Boolean(rawPayload?.ok) && Object.keys(cards).length > 0;
  return {
    scanApiVersion: SCAN_API_VERSION,
    ok,
    cards,
    diagnostics,
    metrics,
  };
};

