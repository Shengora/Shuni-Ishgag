/**
 * Batch number-fetching handlers:
 * + menu_getnumber (shows source picker or count picker)
 * + src_pick (saves selected source bot)
 * + batch_count:N (fetches N numbers fully automatically)
 */
import { Bot, InlineKeyboard } from "grammy";
import { db } from "@workspace/db";
import { pendingNumbers, providerBots } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { E, EID } from "../../lib/emoji.js";
import { recordStat } from "../super-admin.js";
import {
  getMasterClient,
  sendCommandAndWaitForNumber,
  clickRepreamButton,
  sendCodeForPhone,
  waitForRepreamCode,
  parseRepreamCodeMessage,
  signInWithCodeAndPass,
  releaseSignedInClient,
} from "../client.js";
import { getMasterClientsList } from "../client.js";
import { notifyError } from "../notify.js";
import {
  isOperator,
  batchRunning,
  operatorSelectedSource,
  operatorSelectedSlot,
  getOperatorSource,
  claimUserbotSession,
  ALLOWED_BATCH_COUNTS,
  DEFAULT_REPREAM_BOT,
  menuButton,
  countPickerKeyboard,
} from "./shared.js";

export function registerBatchHandlers(bot: Bot): void {

  // ── menu_getnumber: show slot picker (>1 slots), source picker (>1 bots), OR count picker directly ─
  bot.callbackQuery("menu_getnumber", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const uid = ctx.from.id;

    void (async () => {
      const slots = await getMasterClientsList(uid);
      if (slots.length === 0) {
        await ctx.reply(
          "❌ Operator hisob ulanmagan.\n\n🔑 Avval login qiling:",
          { reply_markup: new InlineKeyboard().text("Login", "menu_login").icon(EID.KEY).success() },
        ).catch(() => {});
        return;
      }

      if (slots.length > 1) {
        const kb = new InlineKeyboard();
        for (const slot of slots) {
          const label = slot.isShared ? `${slot.phone} (Ulashilgan)` : `${slot.phone} (slot ${slot.slot})`;
          kb.text(label, `slot_pick:${slot.ownerId}:${slot.slot}`).row();
        }
        kb.text("Bosh menyu", "menu_home").icon(EID.HOME).primary();
        await ctx.reply(
          `👤 <b>Qaysi hisobdan raqam olasiz?</b>\n\nIltimos, master hisobni tanlang:`,
          { parse_mode: "HTML", reply_markup: kb },
        ).catch(() => {});
        return;
      } else {
        const previous = operatorSelectedSlot.get(uid);
        if (previous?.ownerId !== slots[0].ownerId || previous?.slot !== slots[0].slot) {
          operatorSelectedSlot.set(uid, { ownerId: slots[0].ownerId, slot: slots[0].slot });
          const { removeMasterSession } = await import("../client.js");
          await removeMasterSession(uid);
        }
      }

      const client = await getMasterClient(uid);
      if (!client) {
        await ctx.reply(
          "❌ Master hisobga ulanib bo'lmadi.\n\n🔑 Avval login qiling:",
          { reply_markup: new InlineKeyboard().text("Login", "menu_login").icon(EID.KEY).success() },
        ).catch(() => {});
        return;
      }

      const activeBots = await db.select().from(providerBots).where(eq(providerBots.isActive, true));

      if (activeBots.length > 1) {
        const current = operatorSelectedSource.get(uid);
        const kb = new InlineKeyboard();
        for (const b of activeBots) {
          const isSelected = b.username === current;
          kb.text(`@${b.username}`, `src_pick:${b.username}`).icon(isSelected ? EID.OK : EID.ROBOT).primary().row();
        }
        kb.text("Bosh menyu", "menu_home").icon(EID.HOME).primary();
        await ctx.reply(
          `🌐 <b>Manba bot tanlang</b>\n\n` +
            (current ? `Joriy: @${current}\n\n` : "") +
            `Qaysi botdan raqam olmoqchisiz?`,
          { parse_mode: "HTML", reply_markup: kb },
        ).catch(() => {});
        return;
      }

      if (activeBots.length === 1) {
        operatorSelectedSource.set(uid, activeBots[0].username);
      }

      await ctx.reply(
        `${E.PHONE} <b>Nechta raqam olish kerak?</b>\n\nRaqam olinib, avtomatik sessiya yaratiladi.`,
        { parse_mode: "HTML", reply_markup: countPickerKeyboard() },
      ).catch(() => {});
    })();
  });

  // ── slot_pick: save selected slot + show source picker or count picker ──
  bot.callbackQuery(/^slot_pick:(\d+):(\d+)$/, async (ctx) => {
    const ownerId = parseInt(ctx.match[1], 10);
    const slot = parseInt(ctx.match[2], 10);
    const uid = ctx.from.id;

    const previous = operatorSelectedSlot.get(uid);
    if (previous?.ownerId !== ownerId || previous?.slot !== slot) {
      operatorSelectedSlot.set(uid, { ownerId, slot });
      // Invalidate master client cache to enforce the new slot selection on next `getMasterClient` call.
      const { removeMasterSession } = await import("../client.js");
      await removeMasterSession(uid);
    }

    await ctx.answerCallbackQuery(`✅ Slot tanlandi`).catch(() => {});

    void (async () => {
      const client = await getMasterClient(uid);
      if (!client) {
        await ctx.reply(
          "❌ Tanlangan master hisobga ulanib bo'lmadi.",
          { reply_markup: new InlineKeyboard().text("Login", "menu_login").icon(EID.KEY).success() },
        ).catch(() => {});
        return;
      }

      const activeBots = await db.select().from(providerBots).where(eq(providerBots.isActive, true));

      if (activeBots.length > 1) {
        const current = operatorSelectedSource.get(uid);
        const kb = new InlineKeyboard();
        for (const b of activeBots) {
          const isSelected = b.username === current;
          kb.text(`@${b.username}`, `src_pick:${b.username}`).icon(isSelected ? EID.OK : EID.ROBOT).primary().row();
        }
        kb.text("Bosh menyu", "menu_home").icon(EID.HOME).primary();
        await ctx.reply(
          `🌐 <b>Manba bot tanlang</b>\n\n` +
            (current ? `Joriy: @${current}\n\n` : "") +
            `Qaysi botdan raqam olmoqchisiz?`,
          { parse_mode: "HTML", reply_markup: kb },
        ).catch(() => {});
        return;
      }

      if (activeBots.length === 1) {
        operatorSelectedSource.set(uid, activeBots[0].username);
      }

      await ctx.reply(
        `${E.PHONE} <b>Nechta raqam olish kerak?</b>\n\nRaqam olinib, avtomatik sessiya yaratiladi.`,
        { parse_mode: "HTML", reply_markup: countPickerKeyboard() },
      ).catch(() => {});
    })();
  });

  // ── src_pick: save selected source + show count picker ───────────────────
  bot.callbackQuery(/^src_pick:(.+)$/, async (ctx) => {
    const botname = ctx.match[1];
    const uid = ctx.from.id;
    operatorSelectedSource.set(uid, botname);
    await ctx.answerCallbackQuery(`✅ @${botname} tanlandi`).catch(() => {});

    void (async () => {
      const client = await getMasterClient(uid);
      if (!client) {
        await ctx.reply(
          "❌ Operator hisob ulanmagan.",
          { reply_markup: new InlineKeyboard().text("Login", "menu_login").icon(EID.KEY).success() },
        ).catch(() => {});
        return;
      }
      await ctx.reply(
        `${E.PHONE} <b>Nechta raqam olish kerak?</b>\n\n${E.GLOBE} Manba: @${botname}`,
        { parse_mode: "HTML", reply_markup: countPickerKeyboard() },
      ).catch(() => {});
    })();
  });

  // ── batch_count:N — fetch N numbers automatically ─────────────────────────
  bot.callbackQuery(/^batch_count:(\d+)$/, async (ctx) => {
    const total = parseInt(ctx.match[1]);
    if (!ALLOWED_BATCH_COUNTS.has(total)) {
      await ctx.answerCallbackQuery("❌ Noto'g'ri son.").catch(() => {});
      return;
    }

    const uid = ctx.from.id;

    if (batchRunning.has(uid)) {
      await ctx.answerCallbackQuery("⏳ Avvalgi jarayon hali tugamagan, kuting.").catch(() => {});
      return;
    }
    batchRunning.add(uid);
    await ctx.answerCallbackQuery(`⏳ ${total} ta raqam olinmoqda...`).catch(() => {});

    const statusMsg = await ctx.reply(
      `${E.CLOCK} <b>0 / ${total}</b> sessiya yaratildi...\n\n${E.REFRESH} Boshlanmoqda...`,
      { parse_mode: "HTML" },
    );

    const chatId = ctx.chat!.id;
    const msgId = statusMsg.message_id;

    void (async () => {
      const client = await getMasterClient(uid);
      if (!client) {
        batchRunning.delete(uid);
        await ctx.api.editMessageText(
          chatId, msgId,
          "❌ Operator hisob ulanmagan. /login buyrug'ini yuboring.",
          { reply_markup: new InlineKeyboard().text("Login", "menu_login").icon(EID.KEY).success() },
        ).catch(() => {});
        return;
      }

      const srcBot = await getOperatorSource(uid);
      let success = 0;
      let failed = 0;
      const lines: string[] = [];

      const updateProgress = async (note: string) => {
        try {
          await ctx.api.editMessageText(
            chatId, msgId,
            `${E.CLOCK} <b>${success} / ${total}</b> sessiya yaratildi...\n\n${note}`,
            { parse_mode: "HTML" },
          );
        } catch (_) {}
      };

      const freezePending = async (row: { id: number; repreamMessageId: number | string | null; freezeData: string | null }) => {
        if (row.repreamMessageId && row.freezeData) {
          await clickRepreamButton(client, srcBot, Number(row.repreamMessageId), row.freezeData).catch(() => {});
        }
        await db.update(pendingNumbers).set({ status: "frozen" }).where(eq(pendingNumbers.id, row.id));
      };

      try {
        for (let i = 0; i < total; i++) {
          const step = i + 1;

          try {
            // 1. Get number
            await updateProgress(`${E.REFRESH} ${step}/${total}: @${srcBot} dan raqam olinmoqda...`);

            const numResult = await sendCommandAndWaitForNumber(client, srcBot, "/getnumber");
            if (!numResult) {
              lines.push(`${step}. ${E.NO} Raqam olinmadi`);
              failed++;
              continue;
            }

            const phone = numResult.phone;

            if (!numResult.messageId || !numResult.buttons.freeze || !numResult.buttons.getCode) {
              lines.push(`${step}. ${E.NO} <code>${phone}</code> — tugma ma'lumoti to'liq emas`);
              failed++;
              continue;
            }

            await updateProgress(`${E.PHONE} ${step}/${total}: <code>${phone}</code> → kod yuborilmoqda...`);

            await db.delete(pendingNumbers).where(
              and(eq(pendingNumbers.requestedByUserId, uid), eq(pendingNumbers.status, "waiting")),
            );
            const [pendingRow] = await db
              .insert(pendingNumbers)
              .values({
                requestedByUserId: uid,
                phone,
                providerBot: srcBot,
                repreamMessageId: numResult.messageId,
                cancelData: numResult.buttons.cancel,
                freezeData: numResult.buttons.freeze,
                getCodeData: numResult.buttons.getCode,
              })
              .returning();

            // 2. Send auth code
            let phoneCodeHash: string;
            try {
              phoneCodeHash = await sendCodeForPhone(phone);
            } catch (err: any) {
              const msg: string = err?.errorMessage ?? err?.message ?? "";
              logger.error({ err, phone }, "batch sendCodeForPhone error");
              await notifyError(err, "batch sendCodeForPhone error", { phone });
              await freezePending(pendingRow);
              lines.push(`${step}. ${E.NO} <code>${phone}</code> — kod yuborilmadi: ${msg.slice(0, 60)}`);
              failed++;
              continue;
            }

            await db.update(pendingNumbers).set({ phoneCodeHash }).where(eq(pendingNumbers.id, pendingRow.id));
            await updateProgress(`${E.PHONE} ${step}/${total}: <code>${phone}</code> → @${srcBot} dan OTP kutilmoqda...`);

            // 3. Click GetCode and wait for OTP
            let listenPromise: ReturnType<typeof waitForRepreamCode>;
            try {
              listenPromise = waitForRepreamCode(client, srcBot, Number(pendingRow.repreamMessageId), 35000, [DEFAULT_REPREAM_BOT]);
              await clickRepreamButton(client, srcBot, Number(pendingRow.repreamMessageId), pendingRow.getCodeData!);
            } catch (err: any) {
              logger.error({ err, phone }, "batch clickRepreamButton error");
              await notifyError(err, "batch clickRepreamButton error", { phone });
              await freezePending(pendingRow);
              lines.push(`${step}. ${E.NO} <code>${phone}</code> — GetCode bosilmadi`);
              failed++;
              continue;
            }

            const codeResp = await listenPromise;
            if (!codeResp) {
              await freezePending(pendingRow);
              lines.push(`${step}. ${E.NO} <code>${phone}</code> — 35s kutildi, javob kelmadi`);
              failed++;
              continue;
            }

            const parsed = parseRepreamCodeMessage(codeResp.text);
            if (!parsed.code) {
              logger.warn({ phone, rawText: codeResp.text }, "batch: code not found in repream message");
              await freezePending(pendingRow);
              lines.push(`${step}. ${E.NO} <code>${phone}</code> — kod topilmadi: <code>${codeResp.text.slice(0, 120)}</code>`);
              failed++;
              continue;
            }

            await updateProgress(`${E.PHONE} ${step}/${total}: <code>${phone}</code> → Telegram ga kirilyapti...`);

            // 4. Sign in
            let sessionString: string;
            try {
              sessionString = await signInWithCodeAndPass(phone, phoneCodeHash, parsed.code, parsed.pass ?? null);
            } catch (err: any) {
              const msg: string = err?.errorMessage ?? err?.message ?? "";
              logger.error({ err, phone }, "batch signInWithCodeAndPass error");
              await notifyError(err, "batch signInWithCodeAndPass error", { phone });
              await freezePending(pendingRow);
              lines.push(`${step}. ${E.NO} <code>${phone}</code> — sign-in xatosi: ${msg.slice(0, 60)}`);
              failed++;
              continue;
            }

            // 5. Save session
            try {
              const claim = await claimUserbotSession(phone, sessionString, uid);
              if (!claim.ok) {
                await db.update(pendingNumbers).set({ status: "frozen" }).where(eq(pendingNumbers.id, pendingRow.id));
                lines.push(`${step}. ${E.ALERT} <code>${phone}</code> — allaqachon boshqa admin tomonidan olingan, o'tkazildi`);
                failed++;
                continue;
              }
              await db.update(pendingNumbers)
                .set({ status: "completed", otpCode: parsed.code })
                .where(eq(pendingNumbers.id, pendingRow.id));

              await recordStat(uid, "getnumber");
              await recordStat(uid, "session_created");

              success++;
              lines.push(`${step}. ${E.OK} <code>${phone}</code>`);
            } finally {
              await releaseSignedInClient(phone).catch(() => {});
            }
          } catch (err: any) {
            logger.error({ err }, `batch step ${step} unexpected error`);
            await notifyError(err, `batch step ${step} unexpected error`);
            lines.push(`${step}. ${E.NO} Kutilmagan xato: ${err.message?.slice(0, 60)}`);
            failed++;
          }
        }
      } finally {
        batchRunning.delete(uid);
      }

      const summary =
        `${success > 0 ? E.OK : E.NO} <b>Jarayon tugadi!</b>\n\n` +
        `${E.OK} Muvaffaqiyat: <b>${success}</b> ta\n` +
        `${E.NO} Xato: <b>${failed}</b> ta\n\n` +
        lines.join("\n\n");

      try {
        await ctx.api.editMessageText(chatId, msgId, summary, { parse_mode: "HTML", reply_markup: menuButton() });
      } catch (_) {
        await ctx.reply(summary, { parse_mode: "HTML", reply_markup: menuButton() });
      }
    })();
  });
}
