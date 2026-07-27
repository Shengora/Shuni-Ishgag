import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { admins, adminStats } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  CreateAdminBody,
  UpdateAdminBody,
  GetAdminParams,
  UpdateAdminParams,
  DeleteAdminParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Root super admin — configured via env, always exists, never manageable
// through this API (mirrors the same guard the bot's admin panel enforces
// for the root SA and for any DB-flagged super admin).
const ROOT_SA_ID = Number((process.env.SUPER_ADMIN_ID ?? "").trim());

/**
 * Blocks destructive/state-changing operations (block/unblock, delete)
 * against the root super admin or any admin flagged isSuperAdmin. Returns
 * a rejection response (already sent) or null if the action may proceed.
 */
async function rejectIfProtectedAdmin(
  telegramUserId: number,
): Promise<{ status: number; body: { error: string } } | null> {
  if (telegramUserId === ROOT_SA_ID) {
    return { status: 403, body: { error: "The root super admin cannot be modified via this API." } };
  }
  const [row] = await db
    .select({ isSuperAdmin: admins.isSuperAdmin })
    .from(admins)
    .where(eq(admins.telegramUserId, telegramUserId))
    .limit(1);
  if (row?.isSuperAdmin) {
    return { status: 403, body: { error: "Super admins must be demoted (via the bot's admin panel) before they can be blocked or deleted." } };
  }
  return null;
}

// GET /admins — list all admins
router.get("/admins", async (req, res) => {
  try {
    const rows = await db.select().from(admins).orderBy(admins.createdAt);
    const result = rows.map((r) => ({
      id: r.id,
      telegramUserId: String(r.telegramUserId),
      username: r.username,
      firstName: r.firstName,
      isSuperAdmin: r.isSuperAdmin,
      isBlocked: r.isBlocked,
      addedBySuperAdminId: r.addedBySuperAdminId ? String(r.addedBySuperAdminId) : null,
      createdAt: r.createdAt.toISOString(),
      blockedAt: r.blockedAt ? r.blockedAt.toISOString() : null,
    }));
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "listAdmins error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admins — add new admin
router.post("/admins", async (req, res) => {
  const parsed = CreateAdminBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.issues });
    return;
  }
  const { telegramUserId, username, firstName } = parsed.data;
  try {
    const [row] = await db
      .insert(admins)
      .values({
        telegramUserId: Number(telegramUserId),
        username: username ?? null,
        firstName: firstName ?? null,
        isSuperAdmin: false,
        isBlocked: false,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      res.status(409).json({ error: "Admin with this Telegram user ID already exists" });
      return;
    }

    res.status(201).json({
      id: row.id,
      telegramUserId: String(row.telegramUserId),
      username: row.username,
      firstName: row.firstName,
      isSuperAdmin: row.isSuperAdmin,
      isBlocked: row.isBlocked,
      addedBySuperAdminId: row.addedBySuperAdminId ? String(row.addedBySuperAdminId) : null,
      createdAt: row.createdAt.toISOString(),
      blockedAt: row.blockedAt ? row.blockedAt.toISOString() : null,
    });
  } catch (err) {
    req.log.error({ err }, "createAdmin error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admins/:telegramUserId — get single admin
router.get("/admins/:telegramUserId", async (req, res) => {
  const parsed = GetAdminParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  try {
    const [row] = await db
      .select()
      .from(admins)
      .where(eq(admins.telegramUserId, Number(parsed.data.telegramUserId)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Admin not found" });
      return;
    }
    res.json({
      id: row.id,
      telegramUserId: String(row.telegramUserId),
      username: row.username,
      firstName: row.firstName,
      isSuperAdmin: row.isSuperAdmin,
      isBlocked: row.isBlocked,
      addedBySuperAdminId: row.addedBySuperAdminId ? String(row.addedBySuperAdminId) : null,
      createdAt: row.createdAt.toISOString(),
      blockedAt: row.blockedAt ? row.blockedAt.toISOString() : null,
    });
  } catch (err) {
    req.log.error({ err }, "getAdmin error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /admins/:telegramUserId — update admin (block/unblock/rename)
router.patch("/admins/:telegramUserId", async (req, res) => {
  const paramsParsed = UpdateAdminParams.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const bodyParsed = UpdateAdminBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid body", details: bodyParsed.error.issues });
    return;
  }
  const updates: Partial<typeof admins.$inferInsert> = {};
  if (bodyParsed.data.isBlocked !== undefined) {
    updates.isBlocked = bodyParsed.data.isBlocked;
    updates.blockedAt = bodyParsed.data.isBlocked ? new Date() : null;
  }
  if (bodyParsed.data.username !== undefined) updates.username = bodyParsed.data.username;
  if (bodyParsed.data.firstName !== undefined) updates.firstName = bodyParsed.data.firstName;

  // Blocking is the only destructive state change this endpoint can make —
  // guard it the same way the bot's admin panel does.
  if (bodyParsed.data.isBlocked !== undefined) {
    const rejection = await rejectIfProtectedAdmin(Number(paramsParsed.data.telegramUserId));
    if (rejection) {
      res.status(rejection.status).json(rejection.body);
      return;
    }
  }

  try {
    const [row] = await db
      .update(admins)
      .set(updates)
      .where(eq(admins.telegramUserId, Number(paramsParsed.data.telegramUserId)))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Admin not found" });
      return;
    }
    res.json({
      id: row.id,
      telegramUserId: String(row.telegramUserId),
      username: row.username,
      firstName: row.firstName,
      isSuperAdmin: row.isSuperAdmin,
      isBlocked: row.isBlocked,
      addedBySuperAdminId: row.addedBySuperAdminId ? String(row.addedBySuperAdminId) : null,
      createdAt: row.createdAt.toISOString(),
      blockedAt: row.blockedAt ? row.blockedAt.toISOString() : null,
    });
  } catch (err) {
    req.log.error({ err }, "updateAdmin error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /admins/:telegramUserId — remove admin
router.delete("/admins/:telegramUserId", async (req, res) => {
  const parsed = DeleteAdminParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }
  const targetId = Number(parsed.data.telegramUserId);
  const rejection = await rejectIfProtectedAdmin(targetId);
  if (rejection) {
    res.status(rejection.status).json(rejection.body);
    return;
  }

  try {
    await db.delete(admins).where(eq(admins.telegramUserId, targetId));
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "deleteAdmin error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
