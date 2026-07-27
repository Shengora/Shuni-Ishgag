import {
  pgTable,
  serial,
  text,
  bigint,
  timestamp,
  boolean,
  integer,
  index,
} from "drizzle-orm/pg-core";

// Admin users managed by super admin
export const admins = pgTable("admins", {
  id: serial("id").primaryKey(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull().unique(),
  username: text("username"), // Telegram @username (may be null)
  firstName: text("first_name"),
  isSuperAdmin: boolean("is_super_admin").notNull().default(false),
  isBlocked: boolean("is_blocked").notNull().default(false),
  addedBySuperAdminId: bigint("added_by_super_admin_id", { mode: "number" }), // null = env seeded
  createdAt: timestamp("created_at").defaultNow().notNull(),
  blockedAt: timestamp("blocked_at"),
});

// Statistics periods — each "restart" closes the current period and opens a new one.
// Stats from before the period system was introduced have periodId = NULL (legacy).
export const statsPeriods = pgTable("stats_periods", {
  id: serial("id").primaryKey(),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  endedAt: timestamp("ended_at"), // NULL = current active period
  note: text("note"),             // optional label set by super admin
});

// Per-admin action statistics
export const adminStats = pgTable("admin_stats", {
  id: serial("id").primaryKey(),
  adminTelegramUserId: bigint("admin_telegram_user_id", { mode: "number" }).notNull(),
  action: text("action").notNull(), // 'getnumber' | 'session_created' | 'session_cancelled' | 'login' | 'card_added'
  count: integer("count").notNull().default(1),
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
  // NULL = recorded before period system was introduced (legacy)
  periodId: integer("period_id"),
}, (t) => [
  index("admin_stats_admin_user_id_idx").on(t.adminTelegramUserId),
  index("admin_stats_period_id_idx").on(t.periodId),
  index("admin_stats_recorded_at_idx").on(t.recordedAt),
]);
