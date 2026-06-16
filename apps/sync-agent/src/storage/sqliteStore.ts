import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import type { CardCountMap, CollectionRecord } from "@mtga/shared-types";

export class SqliteCollectionStore {
  private sql!: SqlJsStatic;
  private db!: Database;

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    await fsp.mkdir(dir, { recursive: true });
    this.sql = await initSqlJs({});

    if (fs.existsSync(this.dbPath)) {
      const data = await fsp.readFile(this.dbPath);
      this.db = new this.sql.Database(data);
    } else {
      this.db = new this.sql.Database();
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collection_cards (
        card_id TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        name TEXT,
        set_code TEXT,
        rarity TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    await this.persist();
  }

  async upsertCounts(counts: CardCountMap, updatedAt: string): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO collection_cards(card_id, count, updated_at)
      VALUES($card_id, $count, $updated_at)
      ON CONFLICT(card_id) DO UPDATE SET
        count = excluded.count,
        updated_at = excluded.updated_at
    `);

    for (const [cardId, count] of Object.entries(counts)) {
      stmt.run({
        $card_id: cardId,
        $count: count,
        $updated_at: updatedAt,
      });
    }
    stmt.free();
    await this.persist();
  }

  getAll(): CollectionRecord[] {
    const result = this.db.exec(`
      SELECT card_id, count, name, set_code, rarity, updated_at
      FROM collection_cards
      ORDER BY card_id ASC;
    `);
    if (result.length === 0) {
      return [];
    }

    const [rows] = result;
    return rows.values.map((value: unknown[]) => ({
      cardId: String(value[0]),
      count: Number(value[1]),
      name: value[2] ? String(value[2]) : undefined,
      setCode: value[3] ? String(value[3]) : undefined,
      rarity: value[4] ? String(value[4]) : undefined,
      updatedAt: String(value[5]),
    }));
  }

  async writeSnapshot(snapshotPath: string): Promise<void> {
    const payload = {
      generatedAt: new Date().toISOString(),
      cards: this.getAll(),
    };
    await fsp.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fsp.writeFile(snapshotPath, JSON.stringify(payload, null, 2), "utf8");
  }

  private async persist(): Promise<void> {
    const data = this.db.export();
    await fsp.writeFile(this.dbPath, Buffer.from(data));
  }
}
