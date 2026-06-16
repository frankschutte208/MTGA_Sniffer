import cors from "cors";
import express from "express";
import type { SyncService } from "../runtime/syncService.js";

export const createApiServer = (syncService: SyncService) => {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/collection", (_req, res) => {
    res.json({
      cards: syncService.getCollection(),
      status: syncService.getStatus(),
    });
  });

  app.get("/cards", (_req, res) => {
    res.json(syncService.getCollection());
  });

  app.get("/sync-status", (_req, res) => {
    res.json(syncService.getStatus());
  });

  app.get("/overlay-status", (_req, res) => {
    res.json(syncService.getOverlayStatus());
  });

  app.get("/overlay-insights", async (_req, res) => {
    const insights = await syncService.getOverlayInsights();
    res.json(insights);
  });

  app.get("/metadata-status", (_req, res) => {
    res.json(syncService.getMetadataStatus());
  });

  app.get("/set-format-stats", (_req, res) => {
    res.json({
      sets: syncService.getSetFormatStats(),
    });
  });

  app.get("/debug-lines", (_req, res) => {
    res.json({
      lines: syncService.getDebugLines(),
    });
  });

  app.get("/sync-history", async (req, res) => {
    const raw = Number(req.query.limit ?? 25);
    const limit = Number.isFinite(raw) ? raw : 25;
    const history = await syncService.getSyncHistory(limit);
    res.json({
      entries: history,
    });
  });

  app.post("/resync", async (_req, res) => {
    await syncService.forceResync();
    res.json({ ok: true, status: syncService.getStatus() });
  });

  app.post("/memory-scan", async (_req, res) => {
    const result = await syncService.forceMemoryScan();
    res.json({
      ok: result.ok,
      cardCount: result.cardCount,
      status: syncService.getStatus(),
    });
  });

  app.get("/memory-anchors", (_req, res) => {
    res.json({
      anchors: syncService.getMemoryAnchors(),
    });
  });

  app.post("/memory-anchors", async (req, res) => {
    const body = req.body as { anchors?: Array<{ name?: string; quantity?: number }> };
    const anchors = (body.anchors ?? []).map((anchor) => ({
      name: String(anchor.name ?? ""),
      quantity: Number(anchor.quantity ?? 0),
    }));
    await syncService.setMemoryAnchors(anchors);
    res.json({
      ok: true,
      anchors: syncService.getMemoryAnchors(),
    });
  });

  return app;
};
