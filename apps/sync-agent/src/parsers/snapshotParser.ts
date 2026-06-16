import type { CardCountMap, CollectionEvent } from "@mtga/shared-types";

const toCardMap = (value: unknown): CardCountMap | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const out: CardCountMap = {};
  for (const [cardId, count] of Object.entries(value as Record<string, unknown>)) {
    const parsedCount = Number(count);
    if (Number.isFinite(parsedCount) && parsedCount >= 0) {
      out[cardId] = Math.floor(parsedCount);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
};

export const parseSnapshotContent = (content: string): CollectionEvent | null => {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const cards = toCardMap(parsed.cards ?? parsed.cardCounts ?? parsed.collection ?? parsed);
    if (!cards) {
      return null;
    }
    return {
      source: "snapshot-file",
      timestamp: new Date().toISOString(),
      cards,
    };
  } catch {
    return null;
  }
};
