import {
  pgTable,
  serial,
  text,
  bigint,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Operator's main Telegram account (MTProto session).
// Super admin can have up to 3 slots; regular operators use slot 1 only.
export const masterSessions = pgTable("master_sessions", {
  id: serial("id").primaryKey(),
  operatorId: bigint("operator_id", { mode: "number" }).notNull(),
  slot: integer("slot").notNull().default(1), // 1, 2, or 3
  phone: text("phone").notNull(),
  sessionString: text("session_string").notNull(),
  // JSON array of operator (admin) user IDs this master session is shared with.
  // Null means not shared. e.g. [123456, 789012]
  sharedWith: text("shared_with"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("master_sessions_op_slot_idx").on(t.operatorId, t.slot),
]);

// Userbot sessions created from repream numbers
export const userbotSessions = pgTable("userbot_sessions", {
  id: serial("id").primaryKey(),
  phone: text("phone").notNull().unique(),
  sessionString: text("session_string").notNull(),
  // 'active' = usable, 'invalid' = Telegram rejected the session (revoked/
  // logged out/deactivated) and it is queued for automatic cleanup.
  status: text("status").notNull().default("active"),
  telegramLink: text("telegram_link"),
  hasPremium: boolean("has_premium").notNull().default(false),
  premiumExpiresAt: timestamp("premium_expires_at"),
  // Set when a flow detects the session is no longer valid (e.g.
  // AUTH_KEY_UNREGISTERED, SESSION_REVOKED, USER_DEACTIVATED). Rows with
  // status='invalid' older than the cleanup grace period are auto-deleted.
  lastFailedAt: timestamp("last_failed_at"),
  failReason: text("fail_reason"),
  // Which admin's /getnumber (or manual login) produced this session. Nullable
  // for legacy rows created before ownership tracking existed. Used to keep
  // each admin's "Sessiyalar" list and "Avto Premium" batch scoped to their
  // own numbers instead of mixing everyone's sessions together.
  ownerId: bigint("owner_id", { mode: "number" }),
  // JSON array of admin user IDs this login is shared with, e.g. [123456, 789012].
  // Null means not shared with anyone beyond the owner.
  sharedWith: text("shared_with"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("userbot_sessions_status_idx").on(t.status),
  index("userbot_sessions_owner_id_idx").on(t.ownerId),
]);

// Pending operator login flows (code step or 2FA step)
export const pendingAuthStates = pgTable("pending_auth_states", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  slot: integer("slot").notNull().default(1), // which slot this login flow targets
  phone: text("phone").notNull(),
  phoneCodeHash: text("phone_code_hash").notNull(),
  // 'code' = waiting for SMS code, '2fa' = waiting for 2FA password
  step: text("step").notNull().default("code"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Phone numbers received from @RePreAmooBot, awaiting code
export const pendingNumbers = pgTable("pending_numbers", {
  id: serial("id").primaryKey(),
  requestedByUserId: bigint("requested_by_user_id", { mode: "number" }).notNull(),
  phone: text("phone").notNull(),
  phoneCodeHash: text("phone_code_hash"),
  repreamMessageId: bigint("repream_message_id", { mode: "number" }),
  providerBot: text("provider_bot"), // which bot provided this number
  cancelData: text("cancel_data"),
  freezeData: text("freeze_data"),
  getCodeData: text("get_code_data"),
  status: text("status").notNull().default("waiting"),
  otpCode: text("otp_code"),
  telegramLink: text("telegram_link"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("pending_numbers_requested_by_idx").on(t.requestedByUserId),
  index("pending_numbers_status_idx").on(t.status),
]);

// Number provider bots (e.g. @RePreAmooBot and any extras)
export const providerBots = pgTable("provider_bots", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(), // without @
  isActive: boolean("is_active").notNull().default(true),
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

// Premium verifier bots — used in step 4 of the premium flow to confirm activation
// Operators can add any bot that responds to a "check premium" button
export const verifierBots = pgTable("verifier_bots", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(), // without @
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

// Card usage log — tracks how many times each card was used for premium purchases
// Enforces max 5 uses per card within any 3-day window
export const cardUsages = pgTable("card_usages", {
  id: serial("id").primaryKey(),
  cardNumber: text("card_number").notNull(), // last 4 digits or full (consistent with savedCards)
  operatorId: bigint("operator_id", { mode: "number" }).notNull(),
  phone: text("phone").notNull(), // which userbot received premium
  usedAt: timestamp("used_at").defaultNow().notNull(),
}, (t) => [
  index("card_usages_operator_id_idx").on(t.operatorId),
  index("card_usages_card_number_idx").on(t.cardNumber),
  index("card_usages_used_at_idx").on(t.usedAt),
]);

// Global proxy settings — singleton row (id=1), super admin editable
export const proxySettings = pgTable("proxy_settings", {
  id: integer("id").primaryKey().default(1), // always 1
  maxUses: integer("max_uses").notNull().default(8),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Proxy IP pool — Playwright uses these for Smart Glocal payment page
// Super admin manages: add/remove IPs, track usage, reset rotation
export const proxyIps = pgTable("proxy_ips", {
  id: serial("id").primaryKey(),
  server: text("server").notNull().unique(), // "host:port" — unique to prevent duplicates
  username: text("username"),               // optional auth
  password: text("password"),               // optional auth
  usedCount: integer("used_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at"),
  isActive: boolean("is_active").notNull().default(true),
  // Auto-retirement: consecutive connect failures. Reset to 0 on a successful
  // use; when it reaches the threshold the proxy is auto-deactivated.
  failCount: integer("fail_count").notNull().default(0),
  lastFailedAt: timestamp("last_failed_at"),
  addedAt: timestamp("added_at").defaultNow().notNull(),
}, (t) => [
  index("proxy_ips_used_count_idx").on(t.usedCount),
  index("proxy_ips_is_active_idx").on(t.isActive),
]);

// Saved payment cards per operator user
export const savedCards = pgTable("saved_cards", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  cardHolder: text("card_holder").notNull(), // bank name (used as cardholder for Stripe)
  bankName: text("bank_name"),               // display label e.g. "Kapital Bank"
  // Full card number needed for Stripe tokenization (personal/operator tool)
  cardNumber: text("card_number").notNull(),
  cardNumberMasked: text("card_number_masked").notNull(), // e.g. ****1234
  expiry: text("expiry").notNull(), // MM/YY
  cvv: text("cvv").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
