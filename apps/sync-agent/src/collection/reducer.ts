import type { CardCountMap, CollectionEvent } from "@mtga/shared-types";

export interface CollectionState {
  counts: CardCountMap;
  updatedAt: string | null;
}

export const createEmptyCollectionState = (): CollectionState => ({
  counts: {},
  updatedAt: null,
});

export const reduceCollectionEvent = (
  state: CollectionState,
  event: CollectionEvent,
): CollectionState => ({
  counts: {
    ...state.counts,
    ...event.cards,
  },
  updatedAt: event.timestamp,
});
