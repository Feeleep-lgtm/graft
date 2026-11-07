// Thin. Reads X-User-Id, builds an accessor (which carries the scope), calls services.
// No route ever writes SQL.
import { Router, type Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { DealAccessor } from "../access/deal-accessor";
import { findUser } from "../access/users";
import type { IngestService } from "../ingest/ingest-service";
import { RawThreadSchema, type ActingUser } from "../types";

export function buildRoutes(db: Pool, ingest: IngestService): Router {
  const r = Router();

  // Auth is skipped on purpose. Every deal route calls this before constructing an accessor,
  // so a deal read without a known user is not expressible.
  async function acting(req: Request): Promise<ActingUser> {
    const userId = req.header("x-user-id")?.trim();
    if (!userId) throw Object.assign(new Error("X-User-Id required"), { status: 401 });
    const user = await findUser(db, userId);
    if (!user) throw Object.assign(new Error("Unknown user"), { status: 401 });
    return user;
  }

  // Ingest is not done by a user: the deal's owner comes from the thread's inbox_owner.
  r.post("/ingest", async (req, res) => {
    const parsed = RawThreadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid thread", details: z.treeifyError(parsed.error) });
      return;
    }
    res.json(await ingest.ingest(parsed.data));
  });

  r.get("/deals", async (req, res) => {
    const accessor = new DealAccessor(db, await acting(req)); // scope lives in here
    res.json(await accessor.list());
  });

  r.get("/deals/:id", async (req, res) => {
    const accessor = new DealAccessor(db, await acting(req));
    const id = Number(req.params.id);
    const deal = Number.isInteger(id) ? await accessor.getById(id) : null;
    if (!deal) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(deal);
  });

  return r;
}
