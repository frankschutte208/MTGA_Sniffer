import type { CardCountMap, CollectionEvent } from "@mtga/shared-types";

const CARD_MAP_KEYS = ["cardCounts", "cards", "collection", "playerCards"] as const;
const NUMERIC_KEY = /^\d{3,8}$/;

const toCardMap = (value: unknown): CardCountMap | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const out: CardCountMap = {};
  for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
    const num = Number(count);
    if (Number.isFinite(num) && num >= 0) {
      out[key] = Math.floor(num);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
};

const maybeParseJsonString = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const looksLikeCollectionMap = (value: unknown): CardCountMap | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 20) {
    return null;
  }

  let numericCount = 0;
  const map: CardCountMap = {};
  for (const [key, rawCount] of entries) {
    if (!NUMERIC_KEY.test(key)) {
      return null;
    }
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count < 0 || count > 500) {
      return null;
    }
    numericCount += 1;
    map[key] = Math.floor(count);
  }

  return numericCount >= 20 ? map : null;
};

const findCardMap = (payload: Record<string, unknown>): CardCountMap | null => {
  for (const key of CARD_MAP_KEYS) {
    const parsed = toCardMap(payload[key]);
    if (parsed) {
      return parsed;
    }
  }
  return null;
};

const deepFindCardMap = (root: unknown): CardCountMap | null => {
  const queue: unknown[] = [root];
  const seen = new Set<unknown>();

  while (queue.length > 0) {
    const current = maybeParseJsonString(queue.shift());
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);

    const direct = looksLikeCollectionMap(current);
    if (direct) {
      return direct;
    }

    if (!Array.isArray(current)) {
      const nested = findCardMap(current as Record<string, unknown>);
      if (nested) {
        return nested;
      }

      for (const value of Object.values(current as Record<string, unknown>)) {
        queue.push(value);
      }
    } else {
      for (const value of current) {
        queue.push(value);
      }
    }
  }

  return null;
};

export const parsePlayerLogLine = (line: string): CollectionEvent | null => {
  const jsonStart = line.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }

  const jsonSlice = line.slice(jsonStart);

  try {
    const parsed = JSON.parse(jsonSlice) as Record<string, unknown>;
    const cards = deepFindCardMap(parsed.payload ?? parsed);
    if (!cards) {
      return null;
    }
    return {
      source: "player-log",
      timestamp: new Date().toISOString(),
      cards,
    };
  } catch {
    return null;
  }
};
