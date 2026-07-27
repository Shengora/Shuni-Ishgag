import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { admins, adminStats } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";

const router: IRouter = Router();

function sumAction(rows: { action: string; count: number }[], action: string): number {
  return rows.filter((r) => r.action === action).reduce((acc, r) => acc + r.count, 0);
}

// GET /stats/summary — overall stats
router.get("/stats/summary", async (req, res) => {
  try {
    const allAdmins = await db.select().from(admins);
    const totalAdmins = allAdmins.length;
    const activeAdmins = allAdmins.filter((a) => !a.isBlocked).length;
    const blockedAdmins = allAdmins.filter((a) => a.isBlocked).length;

    // Aggregate all stats
    const statsRows = await db
      .select({
        action: adminStats.action,
        count: sql<number>`sum(${adminStats.count})::int`,
      })
      .from(adminStats)
      .groupBy(adminStats.action);

    res.json({
      totalAdmins,
      activeAdmins,
      blockedAdmins,
      totalNumbersGotten: sumAction(statsRows, "getnumber"),
      totalSessionsCreated: sumAction(statsRows, "session_created"),
      totalSessionsCancelled: sumAction(statsRows, "session_cancelled"),
      totalCardsAdded: sumAction(statsRows, "card_added"),
      totalLogins: sumAction(statsRows, "login"),
    });
  } catch (err) {
    req.log.error({ err }, "getStatsSummary error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /stats/admins — per-admin aggregated stats
router.get("/stats/admins", async (req, res) => {
  try {
    const allAdmins = await db.select().from(admins);

    const statsRows = await db
      .select({
        adminTelegramUserId: adminStats.adminTelegramUserId,
        action: adminStats.action,
        count: sql<number>`sum(${adminStats.count})::int`,
      })
      .from(adminStats)
      .groupBy(adminStats.adminTelegramUserId, adminStats.action);

    const result = allAdmins.map((a) => {
      const myStats = statsRows.filter((s) => s.adminTelegramUserId === a.telegramUserId);
      return {
        telegramUserId: String(a.telegramUserId),
        username: a.username,
        firstName: a.firstName,
        isBlocked: a.isBlocked,
        isSuperAdmin: a.isSuperAdmin,
        numbersGotten: sumAction(myStats, "getnumber"),
        sessionsCreated: sumAction(myStats, "session_created"),
        sessionsCancelled: sumAction(myStats, "session_cancelled"),
        cardsAdded: sumAction(myStats, "card_added"),
        logins: sumAction(myStats, "login"),
        createdAt: a.createdAt.toISOString(),
      };
    });

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "getAdminsStats error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /stats/admin/:telegramUserId — single admin stats
router.get("/stats/admin/:telegramUserId", async (req, res) => {
  const telegramUserId = Number(req.params.telegramUserId);
  if (!telegramUserId || isNaN(telegramUserId)) {
    res.status(400).json({ error: "Invalid telegramUserId" });
    return;
  }
  try {
    const [admin] = await db
      .select()
      .from(admins)
      .where(eq(admins.telegramUserId, telegramUserId))
      .limit(1);

    if (!admin) {
      res.status(404).json({ error: "Admin not found" });
      return;
    }

    const statsRows = await db
      .select({
        action: adminStats.action,
        count: sql<number>`sum(${adminStats.count})::int`,
      })
      .from(adminStats)
      .where(eq(adminStats.adminTelegramUserId, telegramUserId))
      .groupBy(adminStats.action);

    res.json({
      telegramUserId: String(admin.telegramUserId),
      username: admin.username,
      firstName: admin.firstName,
      isBlocked: admin.isBlocked,
      isSuperAdmin: admin.isSuperAdmin,
      numbersGotten: sumAction(statsRows, "getnumber"),
      sessionsCreated: sumAction(statsRows, "session_created"),
      sessionsCancelled: sumAction(statsRows, "session_cancelled"),
      cardsAdded: sumAction(statsRows, "card_added"),
      logins: sumAction(statsRows, "login"),
      createdAt: admin.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "getAdminStats error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
