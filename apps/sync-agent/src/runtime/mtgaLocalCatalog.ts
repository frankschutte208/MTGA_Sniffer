import { promises as fsp } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";

export interface LocalCardMetadata {
  name?: string;
  setCode?: string;
  collectorNumber?: string;
  rarity?: string;
  isCollectible?: boolean;
}

const rawCandidates = [
  path.join("C:", "Program Files (x86)", "Steam", "steamapps", "common", "MTGA", "MTGA_Data", "Downloads", "Raw"),
  path.join("C:", "Program Files", "Wizards of the Coast", "MTGA", "MTGA_Data", "Downloads", "Raw"),
  path.join("C:", "Program Files (x86)", "Wizards of the Coast", "MTGA", "MTGA_Data", "Downloads", "Raw"),
];

const getRawPath = (): string | null => rawCandidates.find((candidate) => fs.existsSync(candidate)) ?? null;

const parseTables = (db: { exec: (sql: string) => Array<{ values: unknown[][] }> }): Set<string> => {
  const rows = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  const out = new Set<string>();
  if (rows.length === 0) {
    return out;
  }
  for (const value of rows[0].values) {
    out.add(String(value[0]));
  }
  return out;
};

export const loadMtgaLocalCatalog = async (): Promise<Map<string, LocalCardMetadata>> => {
  const rawPath = getRawPath();
  if (!rawPath) {
    return new Map();
  }

  const sql = await initSqlJs({});
  const files = (await fsp.readdir(rawPath))
    .filter((fileName) => fileName.endsWith(".mtga"))
    .map((fileName) => path.join(rawPath, fileName));
  const result = new Map<string, LocalCardMetadata>();
  const localizations = new Map<number, string>();
  const pendingCards: Array<{
    grpId: string;
    titleId: number;
    setCode?: string;
    collectorNumber?: string;
    rarity?: string;
    isCollectible?: boolean;
    isToken?: boolean;
    isPrimaryCard?: boolean;
  }> = [];

  for (const fullPath of files) {
    try {
      const stat = await fsp.stat(fullPath);
      if (stat.size < 500 * 1024) {
        continue;
      }

      const fileData = await fsp.readFile(fullPath);
      const db = new sql.Database(fileData);
      const tables = parseTables(db);
      if (!tables.has("Cards")) {
        db.close();
        continue;
      }

      if (tables.has("Localizations_enUS")) {
        // Card titles use Formatted = 1; Formatted = 0 is flavor/rules text.
        for (const formatted of [1, 0]) {
          const locRows = db.exec(
            `SELECT LocId, Loc FROM Localizations_enUS WHERE Formatted = ${formatted}`,
          );
          if (locRows.length === 0) {
            continue;
          }
          for (const [id, text] of locRows[0].values) {
            const locId = Number(id);
            if (localizations.has(locId)) {
              continue;
            }
            if (typeof text === "string" && text.length > 0 && !text.startsWith("#NoTranslationNeeded")) {
              localizations.set(locId, text);
            }
          }
        }
      } else if (tables.has("Localizations")) {
        const locRows = db.exec("SELECT Id, Text FROM Localizations");
        if (locRows.length > 0) {
          for (const [id, text] of locRows[0].values) {
            if (typeof text === "string" && text.length > 0) {
              localizations.set(Number(id), text);
            }
          }
        }
      }

      const columnsRes = db.exec("PRAGMA table_info(Cards)");
      const columns = new Set<string>();
      if (columnsRes.length > 0) {
        for (const col of columnsRes[0].values) {
          columns.add(String(col[1]));
        }
      }
      const hasSet = columns.has("ExpansionCode");
      const hasCollector = columns.has("CollectorNumber");
      const hasRarity = columns.has("Rarity");
      const hasRarityCode = columns.has("RarityCode");
      const hasIsCollectible = columns.has("IsCollectible");
      const hasCollectible = columns.has("Collectible");
      const hasIsToken = columns.has("IsToken");
      const hasIsPrimaryCard = columns.has("IsPrimaryCard");

      if (tables.has("Cards")) {
        const query = `SELECT GrpId, TitleId, ${hasSet ? "ExpansionCode" : "NULL"}, ${hasCollector ? "CollectorNumber" : "NULL"}, ${hasRarity ? "Rarity" : hasRarityCode ? "RarityCode" : "NULL"}, ${hasIsCollectible ? "IsCollectible" : hasCollectible ? "Collectible" : "NULL"}, ${hasIsToken ? "IsToken" : "NULL"}, ${hasIsPrimaryCard ? "IsPrimaryCard" : "NULL"} FROM Cards`;
        const rows = db.exec(query);
        if (rows.length > 0) {
          for (const [grpId, titleId, setCode, collector, rarity, isCollectible, isToken, isPrimaryCard] of rows[0].values) {
            pendingCards.push({
              grpId: String(grpId),
              titleId: Number(titleId),
              setCode: setCode ? String(setCode).toLowerCase() : undefined,
              collectorNumber: collector ? String(collector) : undefined,
              rarity: rarity ? String(rarity).toLowerCase() : undefined,
              isCollectible:
                isCollectible === null || isCollectible === undefined
                  ? undefined
                  : Number(isCollectible) !== 0,
              isToken:
                isToken === null || isToken === undefined
                  ? undefined
                  : Number(isToken) !== 0,
              isPrimaryCard:
                isPrimaryCard === null || isPrimaryCard === undefined
                  ? undefined
                  : Number(isPrimaryCard) !== 0,
            });
          }
        }
      }
      db.close();
    } catch {
      // Ignore unreadable files; continue scanning.
    }
  }

  for (const item of pendingCards) {
    const name = localizations.get(item.titleId);
    const isCollectible =
      item.isCollectible ??
      (item.isToken !== undefined || item.isPrimaryCard !== undefined
        ? !Boolean(item.isToken) && Boolean(item.isPrimaryCard)
        : undefined);
    result.set(item.grpId, {
      name,
      setCode: item.setCode,
      collectorNumber: item.collectorNumber,
      rarity: item.rarity,
      isCollectible,
    });
  }

  return result;
};
