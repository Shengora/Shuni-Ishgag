/**
 * Premium emoji helper.
 * Usage in HTML messages:        `${E.OK} Muvaffaqiyatli`
 * Usage in InlineKeyboard icon:  `.icon(EID.OK)`
 * Usage in InlineKeyboard style: `.primary()` | `.success()` | `.danger()`
 *
 * Animated for Telegram Premium users; plain emoji fallback for others.
 * Format: <tg-emoji emoji-id="ID">FALLBACK</tg-emoji>
 */
function e(fallback: string, id: string) {
  return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
}

/** Raw emoji IDs — pass to InlineKeyboard .icon() */
export const EID = {
  OK:       "5774022692642492953",
  NO:       "6030757850274336631",
  STAR:     "5807791714093502248",
  FIRE:     "5316924123786524990",
  DIAMOND:  "5769406891289481208",
  CROWN:    "5805553606635559688",
  SPARKLE:  "5890925363067886150",
  GLOW:     "5805331990618053402",
  BAN:      "5316538964004321334",
  SETTINGS: "5974104203688152439",
  LOCK:     "6003424016977628379",
  UNLOCK:   "6037496202990194718",
  TRASH:    "5974518878485615140",
  SHARE:    "5974192980662160632",
  LINK:     "5974492756494519709",
  ADD:      "6032924188828767321",
  INFO:     "5974193375799152241",
  QUESTION: "5974229895906069525",
  ALERT:    "5976801477509778431",
  ROBOT:    "6030400221232501136",
  SHIELD:   "5974054936118300076",
  BELL:     "6039486778597970865",
  BELL_OFF: "6039569594157371705",
  FOLDER:   "5974308936189218317",
  REFRESH:  "6010590938710152619",
  SEARCH:   "5976655487276421359",
  STATS:    "5974047364090957805",
  CHART:    "5974310710010711597",
  PHONE:    "5974098293813152457",
  USER:     "5974038293120027938",
  USERS:    "5976771524407856876",
  MONEY:    "5316711376876485361",
  EDIT:     "6010457897803189771",
  NOTE:     "6010548023396928773",
  ANNOUNCE: "6021418126061605425",
  HOME:     "5877506824378257176",
  CLOCK:    "5316575093269214796",
  KEY:      "6037249452824072506",
  CARD:     "5769126056262898415",
  GLOBE:    "5974475701179387553",
  UPLOAD:   "6028205772117118673",
  DOWNLOAD: "6037157012242960559",
  BACK:     "5960671702059848143",
} as const;

export const E = {
  // ── Status ──────────────────────────────────────────────────────────────
  OK:       e("✅",  "5774022692642492953"),  // tgiosicons
  NO:       e("❌",  "6030757850274336631"),  // tgiosicons
  STAR:     e("⭐️", "5807791714093502248"),
  FIRE:     e("🔥", "5316924123786524990"),  // AdaptiveStatus
  DIAMOND:  e("💎", "5769406891289481208"),  // tgiosicons
  CROWN:    e("👑", "5805553606635559688"),  // tgiosicons
  SPARKLE:  e("✨", "5890925363067886150"),  // tgiosicons
  GLOW:     e("🌟", "5805331990618053402"),  // tgiosicons
  BAN:      e("🚫", "5316538964004321334"),  // AdaptiveStatus

  // ── Actions / UI ─────────────────────────────────────────────────────────
  SETTINGS: e("⚙️", "5974104203688152439"),  // IconsInTg
  LOCK:     e("🔒", "6003424016977628379"),  // IconsInTg
  UNLOCK:   e("🔓", "6037496202990194718"),  // tgiosicons
  TRASH:    e("🗑", "5974518878485615140"),  // IconsInTg
  SHARE:    e("📤", "5974192980662160632"),  // IconsInTg
  LINK:     e("🔗", "5974492756494519709"),  // IconsInTg
  ADD:      e("➕", "6032924188828767321"),  // tgiosicons
  INFO:     e("ℹ️", "5974193375799152241"),  // IconsInTg
  QUESTION: e("❓", "5974229895906069525"),  // IconsInTg
  ALERT:    e("❗️", "5976801477509778431"),  // IconsInTg
  ROBOT:    e("🤖", "6030400221232501136"),  // tgiosicons
  SHIELD:   e("🛡", "5974054936118300076"),  // IconsInTg
  BELL:     e("🔔", "6039486778597970865"),  // tgiosicons
  BELL_OFF: e("🔕", "6039569594157371705"),  // tgiosicons
  FOLDER:   e("📁", "5974308936189218317"),  // IconsInTg
  EMPTY:    e("📭", "5471952986970267163"),  // EmojiStatus — empty/no-items state
  REFRESH:  e("🔄", "6010590938710152619"),  // IconsInTg
  SEARCH:   e("🔎", "5976655487276421359"),  // IconsInTg
  STATS:    e("📊", "5974047364090957805"),  // IconsInTg
  CHART:    e("📈", "5974310710010711597"),  // IconsInTg
  PHONE:    e("📱", "5974098293813152457"),  // IconsInTg
  USER:     e("👤", "5974038293120027938"),  // IconsInTg
  USERS:    e("👥", "5976771524407856876"),  // IconsInTg
  MONEY:    e("💰", "5316711376876485361"),  // AdaptiveStatus
  EDIT:     e("✏️", "6010457897803189771"),  // IconsInTg
  NOTE:     e("📝", "6010548023396928773"),  // IconsInTg
  ANNOUNCE: e("📢", "6021418126061605425"),  // tgiosicons
  HOME:     e("🏠", "5877506824378257176"),  // EmojiStatus
  CLOCK:    e("⏰", "5316575093269214796"),  // AdaptiveStatus
  KEY:      e("🔑", "6037249452824072506"),  // tgiosicons (🔒 animated as key)
  CARD:     e("💳", "5769126056262898415"),  // tgiosicons 👛 as card
  GLOBE:    e("🌐", "5974475701179387553"),  // IconsInTg
  UPLOAD:   e("⬆️", "6028205772117118673"),  // tgiosicons
  DOWNLOAD: e("⬇️", "6037157012242960559"),  // tgiosicons
};
