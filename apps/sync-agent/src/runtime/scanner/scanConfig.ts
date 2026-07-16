import { readFile } from "node:fs/promises";
import path from "node:path";
import { COLLECTOR_DATA_DIRECTORY } from "../../constants.js";

export interface ScanConfig {
  debugKeepWorkDir?: boolean;
  debugCopyOutputTo?: string;
  /** Force bundled vendor exe even when Python+pymem is available (diagnostics only). */
  useExeRuntime?: boolean;
}

export const SCAN_CONFIG_PATH = path.join(COLLECTOR_DATA_DIRECTORY, "scan-config.json");

export const loadScanConfig = async (): Promise<ScanConfig> => {
  try {
    const raw = JSON.parse(await readFile(SCAN_CONFIG_PATH, "utf8")) as ScanConfig;
    return {
      debugKeepWorkDir: Boolean(raw.debugKeepWorkDir),
      debugCopyOutputTo:
        typeof raw.debugCopyOutputTo === "string" && raw.debugCopyOutputTo.trim()
          ? raw.debugCopyOutputTo.trim()
          : undefined,
      useExeRuntime: Boolean(raw.useExeRuntime),
    };
  } catch {
    return {};
  }
};
