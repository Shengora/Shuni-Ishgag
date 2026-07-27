/**
 * Super Admin module — inline keyboard panel + stat tracking helpers.
 * Imported and wired into the main bot by bot.ts.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { Bot, InlineKeyboard } from "grammy";
import { db } from "@workspace/db";
import { admins, adminStats, statsPeriods, proxyIps, proxySettings, masterSessions, userbotSessions, providerBots } from "@workspace/db";
import { eq, and, sql, desc, isNull, isNotNull, asc, lt } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { E, EID } from "../lib/emoji.js";
import { withTimeout } from "../lib/timeout.js";
import { notifyError } from "./notify.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

export async function isActiveAdmin(userId: number): Promise<boolean> {
  const [row] = await db
    .select()
    .from(admins)
    .where(and(eq(admins.telegramUserId, userId), eq(admins.isBlocked, false)))
    .limit(1);
  return !!row;
}

export function isSuperAdmin(userId: number): boolean {
  const rawId = process.env.SUPER_ADMIN_ID ?? "";
  const superAdminId = Number(rawId.trim());
  return !!superAdminId && userId === superAdminId;
}

/** Returns true if userId is root super admin (env) OR has isSuperAdmin=true in DB. */
export async function isAnySuperAdmin(userId: number): Promise<boolean> {
  if (isSuperAdmin(userId)) return true;
  const [row] = await db
    .select({ id: admins.id })
    .from(admins)
    .where(and(eq(admins.telegramUserId, userId), eq(admins.isSuperAdmin, true), eq(admins.isBlocked, false)))
    .limit(1);
  return !!row;
}

export async function ensureSuperAdminSeeded(): Promise<void> {
  const rawId = process.env.SUPER_ADMIN_ID ?? "";
  const superAdminId = Number(rawId.trim());
  if (!superAdminId) return;
  await db
    .insert(admins)
    .values({ telegramUserId: superAdminId, isSuperAdmin: true, isBlocked: false })
    .onConflictDoNothing();
}

// ── Period management ─────────────────────────────────────────────────────────

/** Returns the current active stats period, creating the initial one if needed. */
export async function getCurrentPeriod(): Promise<{ id: number; startedAt: Date }> {
  const [active] = await db
    .select()
    .from(statsPeriods)
    .where(isNull(statsPeriods.endedAt))
    .orderBy(desc(statsPeriods.id))
    .limit(1);

  if (active) return active;

  // No active period — create the initial one
  const [created] = await db
    .insert(statsPeriods)
    .values({ note: "Boshlang'ich davr" })
    .returning();
  logger.info({ periodId: created.id }, "Created initial stats period");
  return created;
}

/** Closes the current period and opens a fresh one. Returns the new period. */
async function restartStatsPeriod(note?: string): Promise<{ id: number; startedAt: Date }> {
  const now = new Date();
  // Close active period(s)
  await db
    .update(statsPeriods)
    .set({ endedAt: now })
    .where(isNull(statsPeriods.endedAt));

  // Open new period
  const [created] = await db
    .insert(statsPeriods)
    .values({ note: note ?? null })
    .returning();
  logger.info({ newPeriodId: created.id }, "Stats period restarted");
  return created;
}

/** Record a stat action, attached to the current active period. */
export async function recordStat(userId: number, action: string): Promise<void> {
  try {
    const period = await getCurrentPeriod();
    await db.insert(adminStats).values({
      adminTelegramUserId: userId,
      action,
      count: 1,
      periodId: period.id,
    });
  } catch (err) {
    logger.error({ err, userId, action }, "recordStat error");
    notifyError(err, "recordStat error", { userId, action }).catch(() => {});
  }
}

// ── Stat query helpers ────────────────────────────────────────────────────────

type StatsRow = { action: string; total: number };

/** Aggregate stats for a specific period (or all-time if periodId is null). */
async function queryStats(periodId: number | null): Promise<StatsRow[]> {
  const base = db
    .select({
      action: adminStats.action,
      total: sql<number>`sum(${adminStats.count})::int`,
    })
    .from(adminStats)
    .groupBy(adminStats.action);

  if (periodId !== null) {
    return base.where(eq(adminStats.periodId, periodId));
  }
  return base;
}

/** Per-admin stats breakdown for leaderboard */
async function queryPerAdminStats(periodId: number | null) {
  const base = db
    .select({
      adminTelegramUserId: adminStats.adminTelegramUserId,
      action: adminStats.action,
      total: sql<number>`sum(${adminStats.count})::int`,
    })
    .from(adminStats)
    .groupBy(adminStats.adminTelegramUserId, adminStats.action);

  if (periodId !== null) {
    return base.where(eq(adminStats.periodId, periodId));
  }
  return base;
}

function sumAction(rows: StatsRow[], action: string): number {
  return rows.find((r) => r.action === action)?.total ?? 0;
}

async function getGlobalStats(periodId: number | null) {
  const allAdmins = await db.select().from(admins);
  const statsRows = await queryStats(periodId);
  return {
    total: allAdmins.length,
    active: allAdmins.filter((a) => !a.isBlocked).length,
    blocked: allAdmins.filter((a) => a.isBlocked).length,
    numbersGotten:     sumAction(statsRows, "getnumber"),
    sessionsCreated:   sumAction(statsRows, "session_created"),
    sessionsCancelled: sumAction(statsRows, "session_cancelled"),
    cardsAdded:        sumAction(statsRows, "card_added"),
    logins:            sumAction(statsRows, "login"),
    premiumsObtained:  sumAction(statsRows, "premium_obtained"),
  };
}

export async function getAdminStats(userId: number, periodId: number | null = null) {
  const base = db
    .select({
      action: adminStats.action,
      total: sql<number>`sum(${adminStats.count})::int`,
    })
    .from(adminStats)
    .where(eq(adminStats.adminTelegramUserId, userId))
    .groupBy(adminStats.action);

  const rows: StatsRow[] = periodId !== null
    ? await db
        .select({
          action: adminStats.action,
          total: sql<number>`sum(${adminStats.count})::int`,
        })
        .from(adminStats)
        .where(and(eq(adminStats.adminTelegramUserId, userId), eq(adminStats.periodId, periodId)))
        .groupBy(adminStats.action)
    : await base;

  return {
    numbersGotten:     sumAction(rows, "getnumber"),
    sessionsCreated:   sumAction(rows, "session_created"),
    sessionsCancelled: sumAction(rows, "session_cancelled"),
    cardsAdded:        sumAction(rows, "card_added"),
    logins:            sumAction(rows, "login"),
    premiumsObtained:  sumAction(rows, "premium_obtained"),
  };
}

// ── Text builders ─────────────────────────────────────────────────────────────

function fmt(d: Date) {
  return d.toLocaleString("uz-UZ", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function adminDisplayName(a: { username: string | null; firstName: string | null; telegramUserId: number }): string {
  const raw = a.username ? `@${a.username}` : (a.firstName?.trim() || String(a.telegramUserId));
  return raw.length > 30 ? raw.slice(0, 29) + "…" : raw;
}

function adminLine(a: {
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  isSuperAdmin: boolean;
  isBlocked: boolean;
}) {
  const badge = a.isSuperAdmin ? "👑" : a.isBlocked ? "🚫" : "✅";
  return `${badge} ${adminDisplayName(a)} — <code>${a.telegramUserId}</code>`;
}

function statsText(
  s: Awaited<ReturnType<typeof getGlobalStats>>,
  period: { id: number; startedAt: Date; endedAt?: Date | null },
  leaderboard: string,
): string {
  const periodLabel = period.endedAt
    ? `📅 Davr: ${fmt(period.startedAt)} → ${fmt(period.endedAt)}`
    : `📅 Davr boshlanishi: ${fmt(period.startedAt)}`;

  return (
    `${E.STATS} <b>Statistika — Davr #${period.id}</b>\n${periodLabel}\n\n` +
    `${E.USERS} Jami adminlar: <b>${s.total}</b> (${E.OK} ${s.active} faol | ${E.BAN} ${s.blocked} bloklangan)\n\n` +
    `${E.PHONE} Olingan raqamlar: <b>${s.numbersGotten}</b>\n` +
    `${E.OK} Yaratilgan sessiyalar: <b>${s.sessionsCreated}</b>\n` +
    `${E.NO} Bekor qilingan: <b>${s.sessionsCancelled}</b>\n` +
    `${E.STAR} Premium olinganlar: <b>${s.premiumsObtained}</b>\n` +
    `${E.CARD} Qo'shilgan kartalar: <b>${s.cardsAdded}</b>\n` +
    `${E.KEY} Loginlar: <b>${s.logins}</b>\n\n` +
    `${E.CROWN} <b>Top (sessiya + premium bo'yicha):</b>\n${leaderboard}`
  );
}

async function buildLeaderboard(periodId: number | null): Promise<string> {
  const allAdmins = await db.select().from(admins);
  const statsRows = await queryPerAdminStats(periodId);

  // Include ALL admins — super admins shown with 👑 badge
  const perAdmin = allAdmins
    .map((a) => {
      const myStats = statsRows.filter((r) => r.adminTelegramUserId === a.telegramUserId);
      const get = (action: string) => myStats.find((r) => r.action === action)?.total ?? 0;
      return {
        name:        a.username ? `@${a.username}` : a.firstName ?? String(a.telegramUserId),
        sessions:    get("session_created"),
        numbers:     get("getnumber"),
        premiums:    get("premium_obtained"),
        isSuperAdmin: a.isSuperAdmin,
        isBlocked:   a.isBlocked,
      };
    })
    // Sort by sessions desc, then premiums desc as tiebreaker
    .sort((x, y) => y.sessions - x.sessions || y.premiums - x.premiums)
    .slice(0, 10);

  if (!perAdmin.length) return "Hali ma'lumot yo'q";
  return perAdmin
    .map((a, i) => {
      const medal   = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      const badge   = a.isSuperAdmin ? " 👑" : a.isBlocked ? " 🚫" : "";
      const premium = a.premiums > 0 ? `, ⭐ ${a.premiums}` : "";
      return `${medal} ${a.name}${badge} — ${a.sessions} sessiya, ${a.numbers} raqam${premium}`;
    })
    .join("\n");
}

// ── AI Stats Analysis ─────────────────────────────────────────────────────────

// Provider order is fixed: Anthropic → OpenAI → Gemini. Each attempt is bounded
// by a timeout so a hung provider can never freeze the stats panel; on any
// failure or empty reply we fall through to the next configured provider.
const AI_TIMEOUT_MS = 45_000;

async function runAiWithFallback(prompt: string): Promise<string> {
  const errors: string[] = [];

  const anthropicBase = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL;
  const anthropicKey  = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  if (anthropicBase && anthropicKey) {
    try {
      const client = new Anthropic({ baseURL: anthropicBase, apiKey: anthropicKey });
      const msg = await withTimeout(
        client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
        }),
        AI_TIMEOUT_MS,
        "Anthropic AI",
      );
      const text = msg.content[0]?.type === "text" ? (msg.content[0] as { type: "text"; text: string }).text : "";
      if (text) return text;
      errors.push("Anthropic: bo'sh javob");
    } catch (err: any) {
      logger.warn({ err }, "AI fallback: Anthropic failed");
      errors.push(`Anthropic: ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }

  const openaiBase = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  const openaiKey  = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (openaiBase && openaiKey) {
    try {
      const client = new OpenAI({ baseURL: openaiBase, apiKey: openaiKey });
      const resp = await withTimeout(
        client.chat.completions.create({
          model: "gpt-5.4-mini",
          max_completion_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
        }),
        AI_TIMEOUT_MS,
        "OpenAI",
      );
      const text = resp.choices[0]?.message?.content ?? "";
      if (text) return text;
      errors.push("OpenAI: bo'sh javob");
    } catch (err: any) {
      logger.warn({ err }, "AI fallback: OpenAI failed");
      errors.push(`OpenAI: ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }

  const geminiBase = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const geminiKey  = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (geminiBase && geminiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey: geminiKey, httpOptions: { apiVersion: "", baseUrl: geminiBase } });
      const resp = await withTimeout(
        ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { maxOutputTokens: 8192 },
        }),
        AI_TIMEOUT_MS,
        "Gemini",
      );
      const text = resp.text ?? "";
      if (text) return text;
      errors.push("Gemini: bo'sh javob");
    } catch (err: any) {
      logger.warn({ err }, "AI fallback: Gemini failed");
      errors.push(`Gemini: ${String(err?.message ?? err).slice(0, 80)}`);
    }
  }

  throw new Error(errors.length ? errors.join(" | ") : "Hech qanday AI provayder sozlanmagan");
}

async function analyzeStatsWithAI(periodId: number): Promise<string> {
  const hasAnthropic = !!(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL && process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY);
  const hasOpenAI    = !!(process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
  const hasGemini    = !!(process.env.AI_INTEGRATIONS_GEMINI_BASE_URL && process.env.AI_INTEGRATIONS_GEMINI_API_KEY);
  if (!hasAnthropic && !hasOpenAI && !hasGemini) {
    return "❌ AI tahlil uchun hech qanday AI integratsiya sozlanmagan.";
  }

  const [period] = await db
    .select()
    .from(statsPeriods)
    .where(eq(statsPeriods.id, periodId))
    .limit(1);
  if (!period) return "❌ Davr topilmadi.";

  const [globalStats, allAdmins, statsRows] = await Promise.all([
    getGlobalStats(periodId),
    db.select().from(admins),
    queryPerAdminStats(periodId),
  ]);

  // Previous finished period for trend comparison
  const [prevPeriod] = await db
    .select()
    .from(statsPeriods)
    .where(and(lt(statsPeriods.id, periodId), isNotNull(statsPeriods.endedAt)))
    .orderBy(desc(statsPeriods.id))
    .limit(1);
  const prevStats = prevPeriod ? await getGlobalStats(prevPeriod.id) : null;

  // Active admins with any activity
  const perAdmin = allAdmins
    .map((a) => {
      const rows = statsRows.filter((r) => r.adminTelegramUserId === a.telegramUserId);
      const get  = (action: string) => rows.find((r) => r.action === action)?.total ?? 0;
      return {
        name:      a.username ? `@${a.username}` : (a.firstName ?? `ID:${a.telegramUserId}`),
        role:      a.isSuperAdmin ? "SuperAdmin" : "Admin",
        isBlocked: a.isBlocked,
        sessions:  get("session_created"),
        cancelled: get("session_cancelled"),
        premiums:  get("premium_obtained"),
        numbers:   get("getnumber"),
        logins:    get("login"),
      };
    })
    .filter((a) => a.sessions + a.numbers + a.logins + a.premiums > 0)
    .sort((x, y) => y.sessions - x.sessions || y.premiums - x.premiums);

  const endDate      = period.endedAt ?? new Date();
  const durationDays = Math.max(1, Math.round((endDate.getTime() - period.startedAt.getTime()) / 86_400_000));

  const convRate    = globalStats.sessionsCreated > 0
    ? ((globalStats.premiumsObtained / globalStats.sessionsCreated) * 100).toFixed(1) : "0";
  const cancelRate  = globalStats.sessionsCreated > 0
    ? ((globalStats.sessionsCancelled / globalStats.sessionsCreated) * 100).toFixed(1) : "0";

  const delta = (curr: number, prev: number) =>
    prev === 0 ? "ma'lumotsiz" : `${curr > prev ? "+" : ""}${curr - prev} (${curr > prev ? "📈" : curr < prev ? "📉" : "→"})`;

  const prevBlock = prevStats
    ? `\n=== OLDINGI DAVR #${prevPeriod!.id} SOLISHTIRISH ===\n` +
      `Sessiyalar: ${prevStats.sessionsCreated} → ${delta(globalStats.sessionsCreated, prevStats.sessionsCreated)}\n` +
      `Premiumlar: ${prevStats.premiumsObtained} → ${delta(globalStats.premiumsObtained, prevStats.premiumsObtained)}\n` +
      `Konversiya: ${prevStats.sessionsCreated > 0 ? ((prevStats.premiumsObtained / prevStats.sessionsCreated) * 100).toFixed(1) : 0}% → ${convRate}%`
    : "\n(Oldingi davr yo'q — birinchi davr)";

  const adminBlock = perAdmin.length
    ? perAdmin.slice(0, 8).map((a) =>
        `${a.name} [${a.role}${a.isBlocked ? ", BLOKLANGAN" : ""}]: ` +
        `${a.sessions} sessiya | ${a.premiums} premium | ${a.numbers} raqam | ${a.cancelled} bekor | ${a.logins} login`
      ).join("\n")
    : "Hech qanday faol admin yo'q";

  const prompt =
`Siz Telegram Premium obunalarini avtomatlashtirish botining analitika yordamchisisiz.
Bot Uzbekiston telefon raqamlari uchun sessiyalar yaratadi va Telegram Premium sotib oladi.

Quyidagi statistika ma'lumotlarini tahlil qiling. Uzbek tilida, Telegram HTML formatlash bilan (<b> sarlavhalar, emoji) javob bering.

=== DAVR #${period.id}${period.note ? ` (${period.note})` : ""} ===
Boshlangan: ${fmt(period.startedAt)}
${period.endedAt ? `Tugagan: ${fmt(period.endedAt)}` : "Holat: Faol davom etmoqda"}
Davomiylik: ${durationDays} kun

=== STATISTIKA ===
Adminlar: ${globalStats.total} jami (${globalStats.active} faol, ${globalStats.blocked} bloklangan)
Olingan raqamlar: ${globalStats.numbersGotten}
Sessiyalar yaratildi: ${globalStats.sessionsCreated}
Sessiyalar bekor: ${globalStats.sessionsCancelled} (${cancelRate}%)
Premium olinganlar: ${globalStats.premiumsObtained}
Premium konversiya: ${convRate}% (premium/sessiya)
Qo'shilgan kartalar: ${globalStats.cardsAdded}
Kuniga sessiya: ${(globalStats.sessionsCreated / durationDays).toFixed(1)}
Kuniga premium: ${(globalStats.premiumsObtained / durationDays).toFixed(1)}
${prevBlock}

=== ADMIN BO'YICHA ===
${adminBlock}

Quyidagi bo'limlar bilan qisqa hisobot yozing (jami 15-20 satr):

1. 📊 <b>Umumiy baho</b> — Davr qanday o'tdi, asosiy xulosalar
2. 📈 <b>Asosiy ko'rsatkichlar</b> — Muhim raqamlar va ularning ma'nosi
3. 🏆 <b>Top adminlar</b> — Eng yaxshi natijalar, kim ajralib turdi
4. ⚠️ <b>Muammolar</b> — Bekor qilish yuqori, faolsiz adminlar, boshqa g'ayritabiiy holatlar
5. 💡 <b>Tavsiyalar</b> — 2-3 ta qisqa amaliy maslahat

Faqat HTML teglari (<b>, <i>, <code>) ishlating — markdown emas.`;

  try {
    const text = await runAiWithFallback(prompt);
    if (!text) return "❌ AI javob bermadi.";
    return `🤖 <b>AI Tahlil — Davr #${period.id}</b>\n\n${text}`;
  } catch (err: any) {
    logger.error({ err }, "analyzeStatsWithAI error");
    return `❌ AI tahlil xatosi: ${String(err.message ?? "noma'lum xato").slice(0, 200)}`;
  }
}

// ── Keyboards ─────────────────────────────────────────────────────────────────

function saMainMenu() {
  return new InlineKeyboard()
    .text("Adminlar", "sa_admins").icon(EID.USERS).primary()
    .text("Statistika", "sa_stats").icon(EID.STATS).primary()
    .row()
    .text("Admin qo'shish", "sa_add_prompt").icon(EID.ADD).success()
    .row()
    .text("Super Admin qo'shish", "sa_add_sa_prompt").icon(EID.CROWN).success()
    .row()
    .text("Manbalar", "sa_sources").icon(EID.SETTINGS).primary()
    .text("Proksi IP", "sa_proxy").icon(EID.GLOBE).primary()
    .row()
    .text("Broadcast", "sa_broadcast").icon(EID.ANNOUNCE).primary()
    .row()
    .text("Asosiy menyu", "menu_home").icon(EID.HOME).primary();
}

function saBackBtn() {
  return new InlineKeyboard()
    .text("Super Admin Panel", "sa_main").icon(EID.SHIELD).primary()
    .text("Asosiy menyu", "menu_home").icon(EID.HOME).primary();
}

function statsMainKb(isArchived = false) {
  const kb = new InlineKeyboard();
  if (!isArchived) {
    kb.text("Yangilash", "sa_stats").icon(EID.REFRESH).primary()
      .text("AI Tahlil", "sa_stats_ai").icon(EID.ROBOT).primary().row();
    kb.text("Statistikani restart qilish", "sa_stats_restart").icon(EID.REFRESH).danger().row();
  }
  kb.text("O'tgan davrlar", "sa_stats_history").icon(EID.FOLDER).primary().row();
  kb.text("Orqaga", "sa_main").icon(EID.SHIELD).primary();
  return kb;
}

// ── State: waiting for admin ID or proxy IP input ─────────────────────────────
const awaitingAdminInput = new Map<number, number>();
// SA source input: set of SA user IDs waiting to type a provider bot username
const awaitingSourceInput = new Set<number>();
const awaitingBroadcastInput = new Set<number>();
const awaitingSAInput    = new Map<number, number>(); // superAdminId → promptMsgId (add super admin)
const awaitingIpInput    = new Map<number, number>(); // superAdminId → promptMsgId
const awaitingLimitInput = new Map<number, number>(); // superAdminId → promptMsgId

// ── Register function ─────────────────────────────────────────────────────────

export function registerSuperAdminCommands(bot: Bot): void {

  const requireSA = async (ctx: any, next: () => Promise<void>) => {
    if (!ctx.from || !(await isAnySuperAdmin(ctx.from.id))) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery("❌ Faqat super admin.");
      else await ctx.reply("❌ Bu buyruq faqat super admin uchun.");
      return;
    }
    return next();
  };

  // ── /superadmin ───────────────────────────────────────────────────────────
  bot.command("superadmin", requireSA, async (ctx) => {
    await ctx.reply(
      `👑 <b>Super Admin Panel</b>\n\nBoshqaruv opsiyasini tanlang:`,
      { parse_mode: "HTML", reply_markup: saMainMenu() },
    );
  });

  // ── sa_main ───────────────────────────────────────────────────────────────
  bot.callbackQuery("sa_main", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `👑 <b>Super Admin Panel</b>\n\nBoshqaruv opsiyasini tanlang:`,
      { parse_mode: "HTML", reply_markup: saMainMenu() },
    );
  });

  // ── sa_admins ─────────────────────────────────────────────────────────────
  bot.callbackQuery("sa_admins", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const rows = await db.select().from(admins).orderBy(admins.createdAt);

    if (!rows.length) {
      await ctx.editMessageText(
        `👥 <b>Adminlar ro'yxati</b>\n\n${E.EMPTY} Hech qanday admin yo'q.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Admin qo'shish", "sa_add_prompt").icon(EID.ADD).success().row().text("Orqaga", "sa_main").icon(EID.SHIELD).primary() },
      );
      return;
    }

    const lines = rows.map((r, i) => `${i + 1}. ${adminLine(r)}`).join("\n");

    const rootSAId = Number((process.env.SUPER_ADMIN_ID ?? "").trim());
    const kb = new InlineKeyboard();
    // Super adminlar (DB da qo'shilgan, env root emas)
    for (const r of rows) {
      if (!r.isSuperAdmin) continue;
      if (r.telegramUserId === rootSAId) continue; // env root — ko'rsatilmaydi (botni kim o'rnatgan)
      const name = r.username ? `@${r.username}` : r.firstName ?? String(r.telegramUserId);
      kb.text(name, `sa_admin:${r.telegramUserId}`).icon(EID.CROWN).primary().row();
    }
    // Oddiy adminlar
    for (const r of rows) {
      if (r.isSuperAdmin) continue;
      const name = r.username ? "@" + r.username : r.firstName ?? String(r.telegramUserId);
      kb.text(name, `sa_admin:${r.telegramUserId}`).icon(r.isBlocked ? EID.BAN : EID.OK)[r.isBlocked ? "danger" : "primary"]().row();
    }
    kb.text("Admin qo'shish", "sa_add_prompt").icon(EID.ADD).success().row();
    kb.text("SA qo'shish", "sa_add_sa_prompt").icon(EID.CROWN).success().row();
    kb.text("Orqaga", "sa_main").icon(EID.SHIELD).primary();

    await ctx.editMessageText(
      `👥 <b>Adminlar ro'yxati (${rows.length} ta):</b>\n\n${lines}`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // ── sa_admin:<id> ─────────────────────────────────────────────────────────
  bot.callbackQuery(/^sa_admin:(\d+)$/, requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const targetId = Number(ctx.match[1]);

    const [row] = await db.select().from(admins).where(eq(admins.telegramUserId, targetId)).limit(1);
    if (!row) {
      await ctx.editMessageText(`❌ Admin topilmadi.`, { reply_markup: new InlineKeyboard().text("◀️ Orqaga", "sa_admins") });
      return;
    }

    const period = await getCurrentPeriod();
    const [stats, masterRow, ubSessions, allAdmins] = await Promise.all([
      getAdminStats(targetId, period.id),
      db.select().from(masterSessions).where(eq(masterSessions.operatorId, targetId)).limit(1),
      db.select({ phone: userbotSessions.phone, status: userbotSessions.status })
        .from(userbotSessions)
        .where(eq(userbotSessions.ownerId, targetId))
        .orderBy(asc(userbotSessions.phone)),
      db.select({ telegramUserId: admins.telegramUserId, username: admins.username, firstName: admins.firstName })
        .from(admins),
    ]);

    const name = adminDisplayName(row);
    const status = row.isBlocked ? `${E.BAN} Bloklangan` : `${E.OK} Faol`;

    // Master session block
    let masterBlock = `${E.KEY} <b>Operator hisob:</b> `;
    if (masterRow.length) {
      const sharedWith: number[] = masterRow[0].sharedWith ? JSON.parse(masterRow[0].sharedWith) : [];
      masterBlock += `<code>${masterRow[0].phone}</code>`;
      if (sharedWith.length) {
        const names = sharedWith.map(id => {
          const a = allAdmins.find(x => x.telegramUserId === id);
          return a ? (a.username ? `@${a.username}` : a.firstName ?? String(id)) : String(id);
        });
        masterBlock += `\n   ${E.SHARE} Ulashilgan: ${names.join(", ")}`;
      }
    } else {
      // Check if another admin shared their session with this admin
      const allMaster = await db.select().from(masterSessions);
      const sharedFrom = allMaster.find(r => {
        if (!r.sharedWith) return false;
        try { return (JSON.parse(r.sharedWith) as number[]).includes(targetId); } catch { return false; }
      });
      if (sharedFrom) {
        const owner = allAdmins.find(x => x.telegramUserId === sharedFrom.operatorId);
        const ownerName = owner ? (owner.username ? `@${owner.username}` : owner.firstName ?? String(sharedFrom.operatorId)) : String(sharedFrom.operatorId);
        masterBlock += `${E.LINK} <i>${ownerName} tomonidan ulashilgan (<code>${sharedFrom.phone}</code>)</i>`;
      } else {
        masterBlock += `${E.NO} <i>ulanmagan</i>`;
      }
    }

    // Userbot sessions block
    let ubBlock = `${E.FOLDER} <b>Userbot loginlar (${ubSessions.length}):</b>`;
    if (ubSessions.length) {
      ubBlock += "\n" + ubSessions
        .map(s => `   ${s.status === "active" ? E.OK : E.NO} <code>${s.phone}</code>`)
        .join("\n");
    } else {
      ubBlock += " <i>yo'q</i>";
    }

    const text =
      `${E.USER} <b>${name}</b>\n` +
      `🆔 <code>${row.telegramUserId}</code>\n` +
      `📅 Qo'shilgan: ${row.createdAt.toLocaleDateString("uz-UZ")}\n` +
      `Holat: ${status}\n\n` +
      masterBlock + "\n\n" +
      ubBlock + "\n\n" +
      `<b>${E.STATS} Joriy davr statistikasi (Davr #${period.id}):</b>\n` +
      `${E.PHONE} Olingan raqamlar: <b>${stats.numbersGotten}</b>\n` +
      `${E.OK} Yaratilgan sessiyalar: <b>${stats.sessionsCreated}</b>\n` +
      `${E.NO} Bekor qilingan: <b>${stats.sessionsCancelled}</b>\n` +
      `${E.STAR} Premium olinganlar: <b>${stats.premiumsObtained}</b>\n` +
      `${E.CARD} Qo'shilgan kartalar: <b>${stats.cardsAdded}</b>\n` +
      `${E.KEY} Loginlar: <b>${stats.logins}</b>`;

    const rootSAId = Number((process.env.SUPER_ADMIN_ID ?? "").trim());
    const isRootSA = targetId === rootSAId;
    const kb = new InlineKeyboard();

    if (row.isSuperAdmin && !isRootSA) {
      kb.text("Oddiy adminga tushirish", `sa_demote_sa:${targetId}`).icon(EID.CROWN).danger().row();
      kb.text("O'chirish", `sa_delete:${targetId}`).icon(EID.TRASH).danger().row();
    } else if (!row.isSuperAdmin) {
      if (row.isBlocked) kb.text("Blokdan chiqarish", `sa_unblock:${targetId}`).icon(EID.OK).success().row();
      else kb.text("Bloklash", `sa_block:${targetId}`).icon(EID.BAN).danger().row();
      kb.text("O'chirish", `sa_delete:${targetId}`).icon(EID.TRASH).danger().row();
    }
    kb.text("Adminlar", "sa_admins").icon(EID.USERS).primary()
      .text("Menyu", "menu_home").icon(EID.HOME).primary();

    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  });

  // ── sa_demote_sa:<id> — super adminni oddiy adminga tushirish ──────────────
  bot.callbackQuery(/^sa_demote_sa:(\d+)$/, requireSA, async (ctx) => {
    const targetId = Number(ctx.match[1]);
    const rootSAId = Number((process.env.SUPER_ADMIN_ID ?? "").trim());
    if (targetId === rootSAId) {
      await ctx.answerCallbackQuery({ text: "❌ Asosiy super adminni tushirib bo'lmaydi.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `⚠️ <b>Tasdiqlang</b>\n\n` +
        `<code>${targetId}</code> foydalanuvchining 👑 Super Admin darajasini\n` +
        `✅ Oddiy adminga tushirishni xohlaysizmi?\n\n` +
        `(Foydalanuvchi botdan foydalana olishda davom etadi, lekin super admin panelidan chiqariladi.)`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard()
          .text("Ha, tushirish", `sa_demote_sa_confirm:${targetId}`).icon(EID.OK).success()
          .text("Yo'q", `sa_admin:${targetId}`).icon(EID.NO).primary() },
    );
  });

  bot.callbackQuery(/^sa_demote_sa_confirm:(\d+)$/, requireSA, async (ctx) => {
    const targetId = Number(ctx.match[1]);
    const rootSAId = Number((process.env.SUPER_ADMIN_ID ?? "").trim());
    if (targetId === rootSAId) {
      await ctx.answerCallbackQuery({ text: "❌ Asosiy super adminni tushirib bo'lmaydi.", show_alert: true });
      return;
    }
    await db
      .update(admins)
      .set({ isSuperAdmin: false })
      .where(eq(admins.telegramUserId, targetId));
    await ctx.answerCallbackQuery("✅ Darajasi tushirildi");
    await ctx.editMessageText(
      `✅ <code>${targetId}</code> endi oddiy admin.\nU botdan foydalana oladi, lekin super admin paneliga kirish huquqi yo'q.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Adminlar", "sa_admins").icon(EID.USERS).primary() },
    );
  });

  // ── sa_block / sa_unblock ─────────────────────────────────────────────────
  // ── helpers for block/delete target-role guard ───────────────────────────
  async function assertNotSuperAdmin(ctx: any, targetId: number): Promise<boolean> {
    const rootSAId = Number((process.env.SUPER_ADMIN_ID ?? "").trim());
    if (targetId === rootSAId) {
      await ctx.answerCallbackQuery({ text: "❌ Asosiy super adminni o'zgartirib bo'lmaydi.", show_alert: true });
      return false;
    }
    const [row] = await db.select({ isSA: admins.isSuperAdmin })
      .from(admins).where(eq(admins.telegramUserId, targetId)).limit(1);
    if (row?.isSA) {
      await ctx.answerCallbackQuery({ text: "❌ Super adminni bloklash/o'chirishdan avval darajasini tushiring.", show_alert: true });
      return false;
    }
    return true;
  }

  bot.callbackQuery(/^sa_block:(\d+)$/, requireSA, async (ctx) => {
    const targetId = Number(ctx.match[1]);
    if (!(await assertNotSuperAdmin(ctx, targetId))) return;
    await db.update(admins).set({ isBlocked: true, blockedAt: new Date() }).where(eq(admins.telegramUserId, targetId));
    await ctx.answerCallbackQuery("🚫 Bloklandi");
    const [row] = await db.select().from(admins).where(eq(admins.telegramUserId, targetId)).limit(1);
    if (!row) return;
    const period = await getCurrentPeriod();
    const stats = await getAdminStats(targetId, period.id);
    const name = adminDisplayName(row);
    const text =
      `${E.USER} <b>${name}</b>\n🆔 <code>${row.telegramUserId}</code>\nHolat: ${E.BAN} Bloklandi\n\n` +
      `<b>${E.STATS} Davr #${period.id}:</b>\n${E.PHONE} ${stats.numbersGotten} raqam | ${E.OK} ${stats.sessionsCreated} sessiya | ${E.KEY} ${stats.logins} login`;
    const kb = new InlineKeyboard()
      .text("Blokdan chiqarish", `sa_unblock:${targetId}`).icon(EID.OK).success().row()
      .text("O'chirish", `sa_delete:${targetId}`).icon(EID.TRASH).danger().row()
      .text("Adminlar", "sa_admins").icon(EID.USERS).primary()
      .text("Menyu", "menu_home").icon(EID.HOME).primary();
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }); } catch (_) {}
  });

  bot.callbackQuery(/^sa_unblock:(\d+)$/, requireSA, async (ctx) => {
    const targetId = Number(ctx.match[1]);
    if (!(await assertNotSuperAdmin(ctx, targetId))) return;
    await db.update(admins).set({ isBlocked: false, blockedAt: null }).where(eq(admins.telegramUserId, targetId));
    await ctx.answerCallbackQuery("✅ Blokdan chiqarildi");
    const [row] = await db.select().from(admins).where(eq(admins.telegramUserId, targetId)).limit(1);
    if (!row) return;
    const period = await getCurrentPeriod();
    const stats = await getAdminStats(targetId, period.id);
    const name = adminDisplayName(row);
    const text =
      `${E.USER} <b>${name}</b>\n🆔 <code>${row.telegramUserId}</code>\nHolat: ${E.OK} Faol\n\n` +
      `<b>${E.STATS} Davr #${period.id}:</b>\n${E.PHONE} ${stats.numbersGotten} raqam | ${E.OK} ${stats.sessionsCreated} sessiya | ${E.KEY} ${stats.logins} login`;
    const kb = new InlineKeyboard()
      .text("Bloklash", `sa_block:${targetId}`).icon(EID.BAN).danger().row()
      .text("O'chirish", `sa_delete:${targetId}`).icon(EID.TRASH).danger().row()
      .text("Adminlar", "sa_admins").icon(EID.USERS).primary()
      .text("Menyu", "menu_home").icon(EID.HOME).primary();
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }); } catch (_) {}
  });

  // ── sa_delete ─────────────────────────────────────────────────────────────
  bot.callbackQuery(/^sa_delete:(\d+)$/, requireSA, async (ctx) => {
    const targetId = Number(ctx.match[1]);
    if (!(await assertNotSuperAdmin(ctx, targetId))) return;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `⚠️ <b>Tasdiqlang</b>\n\n<code>${targetId}</code> adminni o'chirishni xohlaysizmi?`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard()
          .text("Ha, o'chirish", `sa_delete_confirm:${targetId}`).icon(EID.TRASH).danger()
          .text("Yo'q", `sa_admin:${targetId}`).icon(EID.NO).primary() },
    );
  });

  bot.callbackQuery(/^sa_delete_confirm:(\d+)$/, requireSA, async (ctx) => {
    const targetId = Number(ctx.match[1]);
    if (!(await assertNotSuperAdmin(ctx, targetId))) return;
    await db.delete(admins).where(eq(admins.telegramUserId, targetId));
    await ctx.answerCallbackQuery("🗑 O'chirildi");
    await ctx.editMessageText(
      `✅ Admin <code>${targetId}</code> o'chirildi.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Adminlar", "sa_admins").icon(EID.USERS).primary() },
    );
  });

  // ── sa_stats — current period statistics ─────────────────────────────────
  bot.callbackQuery("sa_stats", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const period = await getCurrentPeriod();
    const [s, leaderboard] = await Promise.all([
      getGlobalStats(period.id),
      buildLeaderboard(period.id),
    ]);
    const text = statsText(s, period, leaderboard);
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: statsMainKb() });
    } catch (_) {}
  });

  // ── sa_stats_restart — confirm dialog ────────────────────────────────────
  bot.callbackQuery("sa_stats_restart", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const period = await getCurrentPeriod();
    await ctx.editMessageText(
      `🔁 <b>Statistikani restart qilish</b>\n\n` +
        `Joriy <b>Davr #${period.id}</b> yopiladi (boshlangan: ${fmt(period.startedAt)}).\n` +
        `Barcha adminlarning statistikasi <b>0 dan boshlanadi</b>.\n\n` +
        `O'tgan davr saqlanib qoladi va keyin ko'rish mumkin.\n\n` +
        `⚠️ Davom etishni xohlaysizmi?`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Ha, restart", "sa_stats_restart_confirm").icon(EID.REFRESH).success()
          .text("Bekor", "sa_stats").icon(EID.NO).primary(),
      },
    );
  });

  // ── sa_stats_restart_confirm — execute restart ────────────────────────────
  bot.callbackQuery("sa_stats_restart_confirm", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery("🔁 Statistika qayta boshlandi!");
    const newPeriod = await restartStatsPeriod();
    await ctx.editMessageText(
      `✅ <b>Statistika qayta boshlandi!</b>\n\n` +
        `📊 <b>Davr #${newPeriod.id}</b> boshlandi: ${fmt(newPeriod.startedAt)}\n\n` +
        `Barcha adminlar statistikasi 0 dan boshlanadi.\n` +
        `O'tgan davrlarni ko'rish uchun "📋 O'tgan davrlar" tugmasini bosing.`,
      { parse_mode: "HTML", reply_markup: statsMainKb() },
    );
  });

  // ── sa_stats_history — list all past periods ──────────────────────────────
  bot.callbackQuery("sa_stats_history", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const periods = await db
      .select()
      .from(statsPeriods)
      .orderBy(desc(statsPeriods.id));

    if (!periods.length) {
      await ctx.editMessageText(
        `📋 <b>O'tgan davrlar</b>\n\nHali davrlar yo'q.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Orqaga", "sa_stats").icon(EID.STATS).primary() },
      );
      return;
    }

    const kb = new InlineKeyboard();
    for (const p of periods) {
      const isActive = !p.endedAt;
      const label = isActive
        ? `🟢 Davr #${p.id} — ${fmt(p.startedAt)} (joriy)`
        : `📅 Davr #${p.id} — ${fmt(p.startedAt)} → ${fmt(p.endedAt!)}`;
      kb.text(label, `sa_stats_period:${p.id}`).row();
    }
    kb.text("Orqaga", "sa_stats").icon(EID.STATS).primary();

    const lines = periods.map((p) => {
      const isActive = !p.endedAt;
      const range = isActive
        ? `${fmt(p.startedAt)} → hozir (joriy)`
        : `${fmt(p.startedAt)} → ${fmt(p.endedAt!)}`;
      const note = p.note ? ` — ${p.note}` : "";
      return `${isActive ? "🟢" : "📅"} <b>Davr #${p.id}</b>${note}\n   ${range}`;
    });

    await ctx.editMessageText(
      `📋 <b>Barcha statistika davrlari (${periods.length} ta):</b>\n\n${lines.join("\n\n")}`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // ── sa_stats_period:<id> — show specific period stats ─────────────────────
  bot.callbackQuery(/^sa_stats_period:(\d+)$/, requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const periodId = Number(ctx.match[1]);

    const [period] = await db
      .select()
      .from(statsPeriods)
      .where(eq(statsPeriods.id, periodId))
      .limit(1);

    if (!period) {
      await ctx.editMessageText(`❌ Davr topilmadi.`, {
        reply_markup: new InlineKeyboard().text("Orqaga", "sa_stats_history").icon(EID.FOLDER).primary(),
      });
      return;
    }

    const [s, leaderboard] = await Promise.all([
      getGlobalStats(periodId),
      buildLeaderboard(periodId),
    ]);
    const text = statsText(s, period, leaderboard);
    const isActive = !period.endedAt;

    const kb = new InlineKeyboard();
    if (isActive) {
      kb.text("Yangilash", `sa_stats_period:${periodId}`).icon(EID.REFRESH).primary()
        .text("AI Tahlil", `sa_stats_ai:${periodId}`).icon(EID.ROBOT).primary().row();
      kb.text("Restart", "sa_stats_restart").icon(EID.REFRESH).danger().row();
    } else {
      kb.text("AI Tahlil", `sa_stats_ai:${periodId}`).icon(EID.ROBOT).primary().row();
    }
    kb.text("Davrlar", "sa_stats_history").icon(EID.FOLDER).primary();

    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } catch (_) {}
  });

  // ── sa_stats_ai — AI analysis of current period ───────────────────────────
  bot.callbackQuery("sa_stats_ai", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery("⏳ AI tahlil qilinmoqda...").catch(() => {});
    const loadingMsg = await ctx.reply(
      `🤖 <b>AI Tahlil</b>\n\n⏳ Statistika tahlil qilinmoqda, biroz kuting...`,
      { parse_mode: "HTML" },
    );
    const period = await getCurrentPeriod();
    const result = await analyzeStatsWithAI(period.id);
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        result,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("🔄 Yangilash", "sa_stats_ai").row()
            .text("◀️ Statistikaga", "sa_stats"),
        },
      );
    } catch (_) {}
  });

  // ── sa_stats_ai:<id> — AI analysis of a specific period ──────────────────
  bot.callbackQuery(/^sa_stats_ai:(\d+)$/, requireSA, async (ctx) => {
    await ctx.answerCallbackQuery("⏳ AI tahlil qilinmoqda...").catch(() => {});
    const periodId = Number(ctx.match[1]);
    const loadingMsg = await ctx.reply(
      `🤖 <b>AI Tahlil — Davr #${periodId}</b>\n\n⏳ Statistika tahlil qilinmoqda, biroz kuting...`,
      { parse_mode: "HTML" },
    );
    const result = await analyzeStatsWithAI(periodId);
    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        result,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("🔄 Yangilash", `sa_stats_ai:${periodId}`).row()
            .text("◀️ Statistikaga", `sa_stats_period:${periodId}`),
        },
      );
    } catch (_) {}
  });

  // ── sa_add_prompt ─────────────────────────────────────────────────────────
  bot.callbackQuery("sa_add_prompt", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text("❌ Bekor qilish", "sa_add_cancel");
    const msg = await ctx.reply(
      `➕ <b>Admin qo'shish</b>\n\nYangi adminning <b>Telegram user ID</b> sini yuboring:\n\n` +
        `💡 ID ni bilish uchun admin @userinfobot ga /start yuborganda ko'rsatiladi.\n` +
        `<i>Faqat raqam yuboring, masalan: <code>123456789</code></i>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
    awaitingAdminInput.set(ctx.from.id, msg.message_id);
  });

  bot.callbackQuery("sa_add_cancel", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    awaitingAdminInput.delete(ctx.from!.id);
    await ctx.editMessageText(
      `❌ Bekor qilindi.`,
      { reply_markup: new InlineKeyboard().text("◀️ Super Admin Panel", "sa_main") },
    );
  });

  // ── sa_add_sa_prompt — super admin qo'shish ──────────────────────────────
  bot.callbackQuery("sa_add_sa_prompt", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard().text("❌ Bekor qilish", "sa_add_sa_cancel");
    const msg = await ctx.reply(
      `👑 <b>Super Admin qo'shish</b>\n\n` +
        `Yangi super adminning <b>Telegram user ID</b> sini yuboring:\n\n` +
        `⚠️ Super admin barcha panel funksiyalaridan foydalana oladi.\n` +
        `💡 ID ni bilish uchun @userinfobot ga /start yuboring.\n` +
        `<i>Faqat raqam yuboring, masalan: <code>123456789</code></i>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
    awaitingSAInput.set(ctx.from.id, msg.message_id);
  });

  bot.callbackQuery("sa_add_sa_cancel", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    awaitingSAInput.delete(ctx.from!.id);
    await ctx.editMessageText(
      `❌ Bekor qilindi.`,
      { reply_markup: new InlineKeyboard().text("◀️ Super Admin Panel", "sa_main") },
    );
  });

  // ── sa_proxy_limit — show current limit + prompt to change ──────────────────
  bot.callbackQuery("sa_proxy_limit", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const maxUses = await getMaxUses();
    const msg = await ctx.reply(
      `⚙️ <b>Har IP uchun limit</b>\n\n` +
      `Hozirgi qiymat: <b>${maxUses} ta</b>\n\n` +
      `Yangi limitni raqam bilan yuboring (1–1000):`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Bekor", "sa_proxy"),
      },
    );
    awaitingLimitInput.set(ctx.from.id, msg.message_id);
  });

  // ── Unified text handler — admin ID add OR proxy IP add OR limit set ──────────
  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || !(await isAnySuperAdmin(ctx.from.id))) return next();
    const uid = ctx.from.id;

    // ── Branch A: awaiting proxy IP input (checked first — cancels admin flow) ──
    if (awaitingIpInput.has(uid)) {
      const promptMsgId = awaitingIpInput.get(uid)!;
      awaitingIpInput.delete(uid);
      // Cancel any stale flows so there's no leftover state
      awaitingAdminInput.delete(uid);
      awaitingLimitInput.delete(uid);
      awaitingSAInput.delete(uid);

      const input = ctx.message.text.trim();
      const parts = input.split(":");
      if (parts.length < 2 || parts.length === 3) {
        await ctx.reply(
          `❌ Noto'g'ri format.\n\nTo'g'ri:\n<code>host:port</code>\n<code>host:port:user:pass</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }
      const server   = `${parts[0]}:${parts[1]}`;
      const username = parts.length >= 4 ? parts[2] : null;
      const password = parts.length >= 4 ? parts.slice(3).join(":") : null;
      try {
        await ctx.api.deleteMessage(ctx.chat.id, promptMsgId).catch(() => {});
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
        const existing = await db.select().from(proxyIps).where(eq(proxyIps.server, server)).limit(1);
        if (existing.length > 0) {
          await ctx.reply(`⚠️ <code>${server}</code> allaqachon mavjud.`, {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("◀️ Orqaga", "sa_proxy"),
          });
          return;
        }
        await db.insert(proxyIps).values({ server, username, password, isActive: true });
        const { text, kb } = await buildProxyPanel();
        await ctx.reply(`✅ <b>${server}</b> qo'shildi!\n\n` + text, { parse_mode: "HTML", reply_markup: kb });
      } catch (err: any) {
        logger.error({ err }, "sa proxy add error");
        await notifyError(err, "sa proxy add error");
        await ctx.reply(`❌ Xato: ${err.message}`);
      }
      return; // consumed — do not call next()
    }

    // ── Branch B: awaiting limit input ────────────────────────────────────────
    if (awaitingLimitInput.has(uid)) {
      const promptMsgId = awaitingLimitInput.get(uid)!;
      awaitingLimitInput.delete(uid);
      awaitingAdminInput.delete(uid);
      awaitingIpInput.delete(uid);
      awaitingSAInput.delete(uid);

      const val = parseInt(ctx.message.text.trim(), 10);
      if (isNaN(val) || val < 1 || val > 1000) {
        await ctx.reply(
          `❌ Noto'g'ri qiymat. 1 dan 1000 gacha raqam kiriting.`,
          { parse_mode: "HTML" },
        );
        return;
      }
      try {
        await ctx.api.deleteMessage(ctx.chat.id, promptMsgId).catch(() => {});
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
        await db
          .insert(proxySettings)
          .values({ id: 1, maxUses: val })
          .onConflictDoUpdate({ target: proxySettings.id, set: { maxUses: val, updatedAt: new Date() } });
        const { text, kb } = await buildProxyPanel();
        await ctx.reply(`✅ Limit <b>${val} ta</b> ga o'zgartirildi!\n\n` + text, { parse_mode: "HTML", reply_markup: kb });
      } catch (err: any) {
        logger.error({ err }, "sa proxy limit set error");
        await notifyError(err, "sa proxy limit set error");
        await ctx.reply(`❌ Xato: ${err.message}`);
      }
      return;
    }

    // ── Branch D: awaiting super admin ID input ───────────────────────────────
    if (awaitingSAInput.has(uid)) {
      const promptMsgId = awaitingSAInput.get(uid)!;
      awaitingSAInput.delete(uid);
      awaitingAdminInput.delete(uid);
      awaitingIpInput.delete(uid);
      awaitingLimitInput.delete(uid);

      const targetId = Number(ctx.message.text.trim());
      if (!targetId || isNaN(targetId) || targetId < 1) {
        await ctx.reply(
          `❌ Noto'g'ri format. Faqat raqam yuboring:\n<code>123456789</code>`,
          { parse_mode: "HTML" },
        );
        return;
      }

      try {
        await ctx.api.deleteMessage(ctx.chat.id, promptMsgId).catch(() => {});
        await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});

        const rootSAId = Number((process.env.SUPER_ADMIN_ID ?? "").trim());
        if (targetId === rootSAId) {
          await ctx.reply(
            `⚠️ <code>${targetId}</code> allaqachon asosiy super admin (env).`,
            { parse_mode: "HTML", reply_markup: saMainMenu() },
          );
          return;
        }

        const [existing] = await db
          .select()
          .from(admins)
          .where(eq(admins.telegramUserId, targetId))
          .limit(1);

        if (existing?.isSuperAdmin) {
          await ctx.reply(
            `⚠️ <code>${targetId}</code> allaqachon super admin.`,
            { parse_mode: "HTML", reply_markup: saMainMenu() },
          );
          return;
        }

        if (existing) {
          // Upgrade existing admin → super admin
          await db
            .update(admins)
            .set({ isSuperAdmin: true, isBlocked: false, blockedAt: null })
            .where(eq(admins.telegramUserId, targetId));
          await ctx.reply(
            `✅ <b>Super Admin darajasi berildi!</b>\n\n` +
              `🆔 <code>${targetId}</code> endi super admin.\n` +
              `(Avval oddiy admin edi — darajasi ko'tarildi.)`,
            { parse_mode: "HTML", reply_markup: saMainMenu() },
          );
        } else {
          // Insert as new super admin
          await db.insert(admins).values({
            telegramUserId: targetId,
            isSuperAdmin: true,
            isBlocked: false,
            addedBySuperAdminId: uid,
          });
          await ctx.reply(
            `✅ <b>Yangi Super Admin qo'shildi!</b>\n\n` +
              `🆔 <code>${targetId}</code> endi super admin sifatida botdan foydalana oladi.\n` +
              `👑 /superadmin buyrug'i orqali panelga kira oladi.`,
            { parse_mode: "HTML", reply_markup: saMainMenu() },
          );
        }
      } catch (err: any) {
        logger.error({ err }, "sa add super admin error");
        await notifyError(err, "sa add super admin error");
        await ctx.reply(`❌ Xato: ${err.message}`, { reply_markup: saMainMenu() });
      }
      return;
    }

    // ── Branch B: awaiting admin ID input ─────────────────────────────────────
    if (!awaitingAdminInput.has(uid)) return next();

    const promptMsgId = awaitingAdminInput.get(uid)!;
    const targetId = Number(ctx.message.text.trim());

    if (!targetId || isNaN(targetId) || targetId < 1) {
      await ctx.reply(
        `❌ Noto'g'ri format. Faqat raqam yuboring:\n<code>123456789</code>`,
        { parse_mode: "HTML" },
      );
      return;
    }

    awaitingAdminInput.delete(uid);

    try {
      await ctx.api.deleteMessage(ctx.chat.id, promptMsgId).catch(() => {});
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});

      const [existing] = await db.select().from(admins).where(eq(admins.telegramUserId, targetId)).limit(1);

      if (existing) {
        if (existing.isBlocked) {
          await db.update(admins).set({ isBlocked: false, blockedAt: null }).where(eq(admins.telegramUserId, targetId));
          await ctx.reply(
            `✅ Admin <code>${targetId}</code> allaqachon mavjud edi, blokdan chiqarildi.`,
            { parse_mode: "HTML", reply_markup: saMainMenu() },
          );
        } else {
          await ctx.reply(
            `⚠️ Admin <code>${targetId}</code> allaqachon mavjud va faol.`,
            { parse_mode: "HTML", reply_markup: saMainMenu() },
          );
        }
        return;
      }

      await db.insert(admins).values({
        telegramUserId: targetId,
        isSuperAdmin: false,
        isBlocked: false,
        addedBySuperAdminId: uid,
      });

      await ctx.reply(
        `✅ <b>Admin qo'shildi!</b>\n\n🆔 ID: <code>${targetId}</code>\n\n` +
          `Bu foydalanuvchi endi botdan foydalana oladi.`,
        { parse_mode: "HTML", reply_markup: saMainMenu() },
      );
    } catch (err: any) {
      logger.error({ err }, "sa add admin error");
      await notifyError(err, "sa add admin error");
      await ctx.reply(`❌ Xato: ${err.message}`, { reply_markup: saMainMenu() });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ── 🌐 PROKSI IP BOSHQARUV ────────────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════════════════

  // Helper: read global maxUses from DB
  async function getMaxUses(): Promise<number> {
    const [row] = await db.select().from(proxySettings).where(eq(proxySettings.id, 1)).limit(1);
    return row?.maxUses ?? 8;
  }

  // Helper: build proxy overview text + keyboard
  async function buildProxyPanel() {
    const [rows, maxUses] = await Promise.all([
      db.select().from(proxyIps).orderBy(asc(proxyIps.usedCount)),
      getMaxUses(),
    ]);
    const active   = rows.filter((r) => r.isActive);
    const exhausted = active.filter((r) => r.usedCount >= maxUses).length;
    const available = active.filter((r) => r.usedCount < maxUses).length;
    const disabled  = rows.filter((r) => !r.isActive).length;

    // Telegram caps messages at 4096 chars and inline keyboards get unwieldy past
    // a few dozen rows, so cap how many proxies we render in the panel itself.
    const MAX_LIST = 40;
    const shown = rows.slice(0, MAX_LIST);
    const hiddenCount = rows.length - shown.length;

    const list = shown.map((r, i) => {
      const full   = r.isActive && r.usedCount >= maxUses;
      const status = !r.isActive ? "🚫" : full ? "🔴" : r.usedCount === 0 ? "🟢" : "🟡";
      const last   = r.lastUsedAt ? ` | oxirgi: ${fmt(r.lastUsedAt)}` : "";
      return `${i + 1}. ${status} <code>${r.server}</code> — ${r.usedCount}/${maxUses}${last}`;
    });

    const text =
      `🌐 <b>Proksi IP boshqaruv</b>\n` +
      `⚙️ Har IP limiti: <b>${maxUses} ta</b>\n\n` +
      `📊 Jami: <b>${rows.length}</b> ta` +
      (disabled ? ` (${disabled} ta o'chirilgan)` : "") + `\n` +
      `🟢 Bo'sh: <b>${available}</b> ta\n` +
      `🔴 To'lgan: <b>${exhausted}</b> ta\n\n` +
      (list.length
        ? `<b>IP ro'yxati:</b>\n${list.join("\n")}` +
          (hiddenCount > 0 ? `\n\n… va yana <b>${hiddenCount}</b> ta (ro'yxat qisqartirildi)` : "")
        : `${E.EMPTY} Hali IP qo'shilmagan.\n\nQuyidagi formatda yuboring:\n<code>host:port</code> yoki <code>host:port:user:pass</code>`);

    const kb = new InlineKeyboard();
    if (active.length > 0) {
      kb.text("🔄 Hammasini qayta boshlash", "sa_proxy_reset").row();
    }
    kb.text(`⚙️ Limit: ${maxUses} ta`, "sa_proxy_limit").row();
    for (const r of shown) {
      const full  = r.isActive && r.usedCount >= maxUses;
      const badge = !r.isActive ? "🚫" : full ? "🔴" : r.usedCount === 0 ? "🟢" : "🟡";
      kb.text(`${badge} ${r.server}`, `sa_proxy_detail:${r.id}`).row();
    }
    kb.text("➕ IP qo'shish", "sa_proxy_add").row();
    kb.text("📥 Webshare dan yuklash", "sa_proxy_ws_sync").row();
    kb.text("◀️ Super Admin Panel", "sa_main");
    return { text, kb };
  }

  // ── sa_proxy — overview ───────────────────────────────────────────────────
  bot.callbackQuery("sa_proxy", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    // Clear any stale awaiting-input state so stray text messages aren't misinterpreted
    const uid = ctx.from.id;
    awaitingIpInput.delete(uid);
    awaitingLimitInput.delete(uid);
    const { text, kb } = await buildProxyPanel();
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } catch (_) {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
    }
  });

  // ── sa_proxy_ws_sync — import all IPs from Webshare API ─────────────────
  bot.callbackQuery("sa_proxy_ws_sync", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Webshare dan yuklanmoqda...");

    const apiKey = process.env.WEBSHARE_API_KEY;
    if (!apiKey) {
      await ctx.reply(
        "❌ <b>WEBSHARE_API_KEY</b> topilmadi. Secrets ga qo'shing.",
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Orqaga", "sa_proxy") },
      );
      return;
    }

    let added = 0;
    let skipped = 0;
    let errors = 0;
    let page = 1;
    const PAGE_SIZE = 100;
    const MAX_PAGES = 100; // safety cap: 100 pages × 100 = 10k proxies per sync

    try {
      // Webshare paginates — fetch all pages (bounded by MAX_PAGES)
      while (page <= MAX_PAGES) {
        const controller = new AbortController();
        const tmout = setTimeout(() => controller.abort(), 15_000);
        let res: Response;
        try {
          res = await fetch(
            `https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=${page}&page_size=${PAGE_SIZE}`,
            { headers: { Authorization: `Token ${apiKey}` }, signal: controller.signal },
          );
        } finally {
          clearTimeout(tmout);
        }

        if (!res.ok) {
          logger.warn({ status: res.status }, "Webshare proxy list non-200");
          break;
        }

        const data = await res.json() as {
          count: number;
          next: string | null;
          results: Array<{ username: string; password: string; proxy_address: string; port: number; valid: boolean }>;
        };

        for (const p of data.results) {
          const server = `${p.proxy_address}:${p.port}`;
          try {
            // ON CONFLICT DO NOTHING — skip duplicates silently
            await db
              .insert(proxyIps)
              .values({
                server,
                username: p.username || null,
                password: p.password || null,
                isActive: p.valid,
              })
              .onConflictDoNothing();
            added++;
          } catch (_) {
            // duplicate or other constraint — count as skipped
            skipped++;
          }
        }

        if (!data.next) break; // no more pages
        page++;
      }
    } catch (err: any) {
      logger.error({ err }, "Webshare sync error");
      await notifyError(err, "Webshare sync error");
      errors++;
    }

    const { text, kb } = await buildProxyPanel();
    const summary =
      `✅ <b>Webshare sync tugadi</b>\n\n` +
      `➕ Yangi qo'shildi: <b>${added}</b> ta\n` +
      `⏭ Mavjud (o'tkazildi): <b>${skipped}</b> ta` +
      (errors ? `\n❌ Xato: <b>${errors}</b> ta` : "") +
      `\n\n` + text;

    try {
      await ctx.editMessageText(summary, { parse_mode: "HTML", reply_markup: kb });
    } catch (_) {
      await ctx.reply(summary, { parse_mode: "HTML", reply_markup: kb });
    }
  });

  // ── sa_proxy_reset — confirm ──────────────────────────────────────────────
  bot.callbackQuery("sa_proxy_reset", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🔄 <b>Proksi IP larni qayta boshlash</b>\n\n` +
      `Barcha IP larning ishlatilish soni <b>0 ga</b> qaytariladi.\n` +
      `Keyingi obunalar eng kam ishlatilgan IP dan boshlanadi.\n\n` +
      `⚠️ Davom etishni xohlaysizmi?`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("✅ Ha, qayta boshlash", "sa_proxy_reset_confirm")
          .text("❌ Bekor", "sa_proxy"),
      },
    );
  });

  // ── sa_proxy_reset_confirm — execute ─────────────────────────────────────
  bot.callbackQuery("sa_proxy_reset_confirm", requireSA, async (ctx) => {
    await db.update(proxyIps).set({ usedCount: 0, lastUsedAt: null });
    await ctx.answerCallbackQuery("🔄 Qayta boshlandi!");
    const { text, kb } = await buildProxyPanel();
    try {
      await ctx.editMessageText(
        `✅ <b>Barcha IP lar qayta boshlandi!</b>\n\nHammasi 0 dan boshlanadi.\n\n` + text,
        { parse_mode: "HTML", reply_markup: kb },
      );
    } catch (_) {}
  });

  // ── sa_proxy_detail:<id> ──────────────────────────────────────────────────
  bot.callbackQuery(/^sa_proxy_detail:(\d+)$/, requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = Number(ctx.match[1]);
    const [row] = await db.select().from(proxyIps).where(eq(proxyIps.id, id)).limit(1);
    if (!row) {
      await ctx.editMessageText("❌ IP topilmadi.", { reply_markup: new InlineKeyboard().text("◀️ Orqaga", "sa_proxy") });
      return;
    }
    const status = !row.isActive ? "🚫 O'chirilgan" : row.usedCount === 0 ? "🟢 Yangi" : "🟡 Ishlatilgan";
    const text =
      `🌐 <b>Proksi IP tafsiloti</b>\n\n` +
      `🖥 Server: <code>${row.server}</code>\n` +
      `👤 Login: <code>${row.username ?? "yo'q"}</code>\n` +
      `📊 Ishlatildi: <b>${row.usedCount}</b> marta\n` +
      `⏰ Oxirgi: ${row.lastUsedAt ? fmt(row.lastUsedAt) : "hali yo'q"}\n` +
      `Holat: ${status}\n` +
      `📅 Qo'shilgan: ${fmt(row.addedAt)}`;

    const kb = new InlineKeyboard();
    if (row.isActive) {
      kb.text("⚡ Usageни 0 ga qaytarish", `sa_proxy_zero:${id}`).row();
      kb.text("🚫 O'chirish (vaqtincha)", `sa_proxy_toggle:${id}`).row();
    } else {
      kb.text("✅ Yoqish", `sa_proxy_toggle:${id}`).row();
    }
    kb.text("🗑 O'chirish (butunlay)", `sa_proxy_delete:${id}`).row();
    kb.text("◀️ Orqaga", "sa_proxy");

    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } catch (_) {}
  });

  // ── sa_proxy_zero:<id> — reset single IP usage to 0 ──────────────────────
  bot.callbackQuery(/^sa_proxy_zero:(\d+)$/, requireSA, async (ctx) => {
    const id = Number(ctx.match[1]);
    await db.update(proxyIps).set({ usedCount: 0, lastUsedAt: null }).where(eq(proxyIps.id, id));
    await ctx.answerCallbackQuery("✅ 0 ga qaytarildi");
    // Refresh detail view
    const [row] = await db.select().from(proxyIps).where(eq(proxyIps.id, id)).limit(1);
    if (!row) return;
    const text =
      `🌐 <b>Proksi IP tafsiloti</b>\n\n` +
      `🖥 Server: <code>${row.server}</code>\n` +
      `📊 Ishlatildi: <b>0</b> marta\n` +
      `Holat: 🟢 Yangi`;
    const kb = new InlineKeyboard()
      .text("🚫 O'chirish (vaqtincha)", `sa_proxy_toggle:${id}`).row()
      .text("🗑 O'chirish (butunlay)", `sa_proxy_delete:${id}`).row()
      .text("◀️ Orqaga", "sa_proxy");
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }); } catch (_) {}
  });

  // ── sa_proxy_toggle:<id> — enable/disable ────────────────────────────────
  bot.callbackQuery(/^sa_proxy_toggle:(\d+)$/, requireSA, async (ctx) => {
    const id = Number(ctx.match[1]);
    const [row] = await db.select().from(proxyIps).where(eq(proxyIps.id, id)).limit(1);
    if (!row) { await ctx.answerCallbackQuery("❌ Topilmadi"); return; }
    await db.update(proxyIps).set({ isActive: !row.isActive }).where(eq(proxyIps.id, id));
    await ctx.answerCallbackQuery(row.isActive ? "🚫 O'chirildi" : "✅ Yoqildi");
    // Re-render detail
    const [updated] = await db.select().from(proxyIps).where(eq(proxyIps.id, id)).limit(1);
    if (!updated) return;
    const status = !updated.isActive ? "🚫 O'chirilgan" : updated.usedCount === 0 ? "🟢 Yangi" : "🟡 Ishlatilgan";
    const text =
      `🌐 <b>Proksi IP tafsiloti</b>\n\n` +
      `🖥 Server: <code>${updated.server}</code>\n` +
      `📊 Ishlatildi: <b>${updated.usedCount}</b> marta\n` +
      `Holat: ${status}`;
    const kb = new InlineKeyboard();
    if (updated.isActive) {
      kb.text("⚡ Usage ni 0 ga qaytarish", `sa_proxy_zero:${id}`).row();
      kb.text("🚫 O'chirish (vaqtincha)", `sa_proxy_toggle:${id}`).row();
    } else {
      kb.text("✅ Yoqish", `sa_proxy_toggle:${id}`).row();
    }
    kb.text("🗑 O'chirish (butunlay)", `sa_proxy_delete:${id}`).row();
    kb.text("◀️ Orqaga", "sa_proxy");
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }); } catch (_) {}
  });

  // ── sa_proxy_delete:<id> — confirm ────────────────────────────────────────
  bot.callbackQuery(/^sa_proxy_delete:(\d+)$/, requireSA, async (ctx) => {
    const id = Number(ctx.match[1]);
    await ctx.answerCallbackQuery();
    const [row] = await db.select().from(proxyIps).where(eq(proxyIps.id, id)).limit(1);
    await ctx.editMessageText(
      `⚠️ <b>Tasdiqlang</b>\n\n<code>${row?.server ?? id}</code> IP ni o'chirishni xohlaysizmi?`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("✅ Ha, o'chirish", `sa_proxy_delete_confirm:${id}`)
          .text("❌ Yo'q", `sa_proxy_detail:${id}`),
      },
    );
  });

  // ── sa_proxy_delete_confirm:<id> — execute ────────────────────────────────
  bot.callbackQuery(/^sa_proxy_delete_confirm:(\d+)$/, requireSA, async (ctx) => {
    const id = Number(ctx.match[1]);
    await db.delete(proxyIps).where(eq(proxyIps.id, id));
    await ctx.answerCallbackQuery("🗑 O'chirildi");
    const { text, kb } = await buildProxyPanel();
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }); } catch (_) {}
  });

  // ── sa_proxy_add — prompt for IP input ───────────────────────────────────
  bot.callbackQuery("sa_proxy_add", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    const msg = await ctx.reply(
      `➕ <b>Yangi proksi IP qo'shish</b>\n\n` +
      `Quyidagi formatlardan birida yuboring:\n\n` +
      `Auth bilan:\n<code>host:port:username:password</code>\n\n` +
      `Auth siz:\n<code>host:port</code>\n\n` +
      `Misol:\n<code>185.22.154.10:8080:user123:pass456</code>\n<code>185.22.154.10:8080</code>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Bekor qilish", "sa_proxy_add_cancel"),
      },
    );
    awaitingIpInput.set(ctx.from.id, msg.message_id);
  });

  bot.callbackQuery("sa_proxy_add_cancel", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery();
    awaitingIpInput.delete(ctx.from!.id);
    const { text, kb } = await buildProxyPanel();
    try { await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }); } catch (_) {}
  });

  // (IP input is handled in the unified text handler above)

  // ── /mystats — personal stats for current period ──────────────────────────
  bot.command("mystats", async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const isAdmin = await isActiveAdmin(userId);
    if (!isAdmin && !isSuperAdmin(userId)) {
      await ctx.reply("❌ Bu buyruq faqat adminlar uchun.");
      return;
    }
    try {
      const period = await getCurrentPeriod();
      const stats = await getAdminStats(userId, period.id);
      const [row] = await db.select().from(admins).where(eq(admins.telegramUserId, userId)).limit(1);
      const name = row?.username ? `@${row.username}` : row?.firstName ?? `ID: ${userId}`;
      await ctx.reply(
        `📊 <b>${name} — Joriy davr statistikasi</b>\n` +
          `📅 Davr #${period.id} — ${fmt(period.startedAt)}\n\n` +
          `📱 Olingan raqamlar: <b>${stats.numbersGotten}</b>\n` +
          `✅ Yaratilgan sessiyalar: <b>${stats.sessionsCreated}</b>\n` +
          `❌ Bekor qilingan: <b>${stats.sessionsCancelled}</b>\n` +
          `💳 Qo'shilgan kartalar: <b>${stats.cardsAdded}</b>\n` +
          `🔑 Loginlar: <b>${stats.logins}</b>`,
        { parse_mode: "HTML" },
      );
    } catch (err: any) {
      logger.error({ err }, "mystats error");
      await notifyError(err, "mystats error");
      await ctx.reply(`❌ Xato: ${err.message}`);
    }
  });

  // ── sa_sources — Raqam manbalari boshqaruvi ──────────────────────────────

  async function buildSourcesKb() {
    const bots = await db.select().from(providerBots).orderBy(providerBots.addedAt);
    const kb = new InlineKeyboard();
    for (const b of bots) {
      kb.text(
        `${b.isActive ? "✅" : "❌"} @${b.username}`,
        `sa_src_toggle:${b.id}`,
      )[b.isActive ? "success" : "primary"]()
        .text("O'chirish", `sa_src_del_confirm:${b.id}`).icon(EID.TRASH).danger()
        .row();
    }
    kb.text("Yangi qo'shish", "sa_src_add").icon(EID.ADD).success().row();
    kb.text("Orqaga", "sa_main").icon(EID.SHIELD).primary();
    return { bots, kb };
  }

  function sourcesText(bots: { username: string; isActive: boolean }[]) {
    return (
      `${E.SETTINGS} <b>Raqam manbalari (${bots.length} ta)</b>\n\n` +
      (bots.length
        ? bots.map((b, i) => `${i + 1}. ${b.isActive ? E.OK : E.NO} @${b.username}`).join("\n")
        : "Hech qanday manba yo'q.")
    );
  }

  bot.callbackQuery("sa_sources", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const { bots, kb } = await buildSourcesKb();
    await ctx.editMessageText(sourcesText(bots), { parse_mode: "HTML", reply_markup: kb })
      .catch(() => ctx.reply(sourcesText(bots), { parse_mode: "HTML", reply_markup: kb }));
  });

  bot.callbackQuery("sa_src_add", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    awaitingSourceInput.add(ctx.from.id);
    await ctx.reply(
      `${E.ADD} <b>Manba qo'shish</b>\n\nBot username kiriting (@ bilan yoki usiz):\n\nMisol: <code>RePreAmooBot</code>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Bekor", "sa_sources").icon(EID.NO).danger() },
    );
  });

  bot.callbackQuery(/^sa_src_toggle:(\d+)$/, requireSA, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    const [row] = await db.select().from(providerBots).where(eq(providerBots.id, id)).limit(1);
    if (!row) {
      await ctx.answerCallbackQuery({ text: "❌ Manba topilmadi.", show_alert: true }).catch(() => {});
      return;
    }
    await db.update(providerBots).set({ isActive: !row.isActive }).where(eq(providerBots.id, id));
    const { bots, kb } = await buildSourcesKb();
    await ctx.editMessageText(sourcesText(bots), { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(/^sa_src_del_confirm:(\d+)$/, requireSA, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    const [row] = await db.select().from(providerBots).where(eq(providerBots.id, id)).limit(1);
    if (!row) return;
    const kb = new InlineKeyboard()
      .text("Ha, o'chir", `sa_src_del_do:${id}`).icon(EID.TRASH).danger()
      .text("Bekor", "sa_sources").icon(EID.NO).primary();
    await ctx.editMessageText(
      `${E.ALERT} <b>@${row.username} manbasini o'chirmoqchimisiz?</b>\n\nO'chirilgan manba qayta tiklanmaydi.`,
      { parse_mode: "HTML", reply_markup: kb },
    ).catch(() => {});
  });

  bot.callbackQuery(/^sa_src_del_do:(\d+)$/, requireSA, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const id = parseInt(ctx.match[1]);
    const [deleted] = await db.select({ username: providerBots.username }).from(providerBots)
      .where(eq(providerBots.id, id)).limit(1);
    await db.delete(providerBots).where(eq(providerBots.id, id));
    const { bots, kb } = await buildSourcesKb();
    await ctx.editMessageText(
      `${E.OK} <b>@${deleted?.username ?? "bot"} o'chirildi.</b>\n\n` + sourcesText(bots),
      { parse_mode: "HTML", reply_markup: kb },
    ).catch(() => {});
  });

  // Text handler for awaitingSourceInput (SA panel source username entry)
  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || !awaitingSourceInput.has(ctx.from.id)) return next();
    awaitingSourceInput.delete(ctx.from.id);
    const username = ctx.message.text.replace(/^@/, "").trim();
    if (!username || !/^[A-Za-z0-9_]{3,32}$/.test(username)) {
      await ctx.reply(`${E.NO} Noto'g'ri username. Qaytadan urinib ko'ring.`, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("Manbalar", "sa_sources").icon(EID.SETTINGS).primary(),
      });
      return;
    }
    await db.insert(providerBots).values({ username, isActive: true }).onConflictDoNothing();
    await ctx.reply(
      `${E.OK} <b>@${username}</b> manba sifatida qo'shildi!`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Manbalar", "sa_sources").icon(EID.SETTINGS).primary() },
    );
  });

  // ── sa_broadcast — Broadcast xabar ────────────────────────────────────────

  bot.callbackQuery("sa_broadcast", requireSA, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    awaitingBroadcastInput.add(ctx.from.id);
    const allAdmins = await db.select({ id: admins.telegramUserId }).from(admins)
      .where(eq(admins.isBlocked, false));
    await ctx.reply(
      `${E.ANNOUNCE} <b>Broadcast</b>\n\n` +
        `Xabar yuboriladigan adminlar: <b>${allAdmins.length} ta</b>\n\n` +
        `Yuboriladigan xabarni yozing (HTML parse_mode qo'llab-quvvatlanadi):\n\n` +
        `<i>Bekor qilish uchun /cancel yuboring.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("Bekor", "sa_main").icon(EID.NO).danger(),
      },
    );
  });

  // Text handler for broadcast input
  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || !awaitingBroadcastInput.has(ctx.from.id)) return next();
    const text = ctx.message.text;
    if (text === "/cancel") {
      awaitingBroadcastInput.delete(ctx.from.id);
      await ctx.reply(`${E.NO} Bekor qilindi.`, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("SA Panel", "sa_main").icon(EID.SHIELD).primary(),
      });
      return;
    }
    awaitingBroadcastInput.delete(ctx.from.id);

    const allAdmins = await db.select({ id: admins.telegramUserId }).from(admins)
      .where(eq(admins.isBlocked, false));

    const statusMsg = await ctx.reply(
      `${E.CLOCK} Broadcast yuborilmoqda... <b>0 / ${allAdmins.length}</b>`,
      { parse_mode: "HTML" },
    );

    let sent = 0;
    let failed = 0;
    for (const admin of allAdmins) {
      try {
        await ctx.api.sendMessage(admin.id, text, { parse_mode: "HTML" });
        sent++;
      } catch {
        failed++;
      }
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `${E.OK} <b>Broadcast tugadi!</b>\n\n` +
        `${E.OK} Yuborildi: <b>${sent}</b> ta\n` +
        `${E.NO} Xato: <b>${failed}</b> ta`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("SA Panel", "sa_main").icon(EID.SHIELD).primary(),
      },
    ).catch(() => {});
  });

  // ── /globalstats — overall stats for current period ──────────────────────
  bot.command("globalstats", async (ctx) => {
    if (!ctx.from || !isSuperAdmin(ctx.from.id)) {
      await ctx.reply("❌ Bu buyruq faqat super admin uchun.");
      return;
    }
    const period = await getCurrentPeriod();
    const s = await getGlobalStats(period.id);
    await ctx.reply(
      `📊 <b>Umumiy statistika — Davr #${period.id}</b>\n` +
        `📅 ${fmt(period.startedAt)}\n\n` +
        `👥 Jami adminlar: <b>${s.total}</b>\n` +
        `✅ Faol: <b>${s.active}</b> | 🚫 Bloklangan: <b>${s.blocked}</b>\n\n` +
        `📱 Olingan raqamlar: <b>${s.numbersGotten}</b>\n` +
        `✅ Yaratilgan sessiyalar: <b>${s.sessionsCreated}</b>\n` +
        `❌ Bekor qilingan: <b>${s.sessionsCancelled}</b>\n` +
        `💳 Qo'shilgan kartalar: <b>${s.cardsAdded}</b>\n` +
        `🔑 Loginlar: <b>${s.logins}</b>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("📊 Panel", "sa_stats")
          .text("📋 O'tgan davrlar", "sa_stats_history")
          .row()
          .text("◀️ Panel", "sa_main"),
      },
    );
  });
}
