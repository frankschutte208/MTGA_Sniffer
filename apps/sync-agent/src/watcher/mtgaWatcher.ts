import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import type { CollectionEvent } from "@mtga/shared-types";
import { parsePlayerLogLine } from "../parsers/playerLogParser.js";
import { parseSnapshotContent } from "../parsers/snapshotParser.js";

export interface WatcherOptions {
  playerLogPath: string;
  snapshotPath: string;
  onEvent: (event: CollectionEvent, sourcePath: string) => Promise<void>;
  onDiagnostic: (message: string) => void;
  onDebugLine?: (line: string, matched: boolean) => void;
}

export class MtgaWatcher {
  private readonly offsets = new Map<string, number>();

  constructor(private readonly options: WatcherOptions) {}

  async start(): Promise<void> {
    await this.safeReadPlayerLog(this.options.playerLogPath, true);
    await this.safeReadSnapshot(this.options.snapshotPath);

    chokidar
      .watch([this.options.playerLogPath, this.options.snapshotPath], {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 350,
          pollInterval: 100,
        },
      })
      .on("change", async (filePath) => {
        if (path.basename(filePath).toLowerCase() === "player.log") {
          await this.safeReadPlayerLog(filePath, false);
        } else {
          await this.safeReadSnapshot(filePath);
        }
      })
      .on("error", (error) => this.options.onDiagnostic(`watcher_error:${String(error)}`));
  }

  async forceRefresh(): Promise<void> {
    await this.safeReadPlayerLog(this.options.playerLogPath, false);
    await this.safeReadSnapshot(this.options.snapshotPath);
  }

  private async safeReadPlayerLog(filePath: string, bootstrap: boolean): Promise<void> {
    if (!fs.existsSync(filePath)) {
      this.options.onDiagnostic(`player_log_missing:${filePath}`);
      return;
    }

    const prevOffset = this.offsets.get(filePath) ?? 0;
    const stat = await fsp.stat(filePath);
    const nextOffset = bootstrap ? Math.max(stat.size - 500_000, 0) : prevOffset;
    const readLen = stat.size - nextOffset;
    if (readLen <= 0) {
      return;
    }

    const fh = await fsp.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(readLen);
      await fh.read(buffer, 0, readLen, nextOffset);
      this.offsets.set(filePath, stat.size);

      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (const line of lines) {
        const event = parsePlayerLogLine(line);
        this.options.onDebugLine?.(line, Boolean(event));
        if (event) {
          await this.options.onEvent(event, filePath);
        }
      }
    } finally {
      await fh.close();
    }
  }

  private async safeReadSnapshot(filePath: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      return;
    }

    try {
      const content = await fsp.readFile(filePath, "utf8");
      const event = parseSnapshotContent(content);
      if (event) {
        await this.options.onEvent(event, filePath);
      } else {
        this.options.onDiagnostic(`snapshot_parse_failed:${filePath}`);
      }
    } catch (error) {
      this.options.onDiagnostic(`snapshot_read_failed:${String(error)}`);
    }
  }
}
