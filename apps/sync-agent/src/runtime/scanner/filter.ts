import type { CardCountMap } from "@mtga/shared-types";
import { MAX_FILTERED_CARD_COUNT, MIN_FILTERED_CARD_COUNT } from "./config.js";

export const filterScannedCards = (
  cards: CardCountMap,
  knownCardIds: Set<string>,
  maxCountPerCard = MAX_FILTERED_CARD_COUNT,
): CardCountMap =>
  Object.fromEntries(
    Object.entries(cards).filter(
      ([cardId, count]) =>
        knownCardIds.has(cardId) &&
        Number.isFinite(count) &&
        count >= MIN_FILTERED_CARD_COUNT &&
        count <= maxCountPerCard,
    ),
  );

