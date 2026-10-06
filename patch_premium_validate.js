const fs = require('fs');
const filepath = 'artifacts/api-server/src/bot/premium.ts';
let code = fs.readFileSync(filepath, 'utf8');

// 1. Modify sendPaymentFormToTelegram signature to include cardHolderName
if (!code.includes('cardHolderName?: string')) {
  code = code.replace(
    /credentials\?: string,/,
    'credentials?: string,\n  cardHolderName?: string,'
  );
}

// 2. Add ValidateRequestedInfo before SendPaymentForm
const sendPaymentBlock = `    const result = await client.invoke(
      new Api.payments.SendPaymentForm({
        invoice: new Api.InputInvoiceMessage({
          peer: peer as any,
          msgId: invoiceMsg.id,
        }),
        formId: formId as any,
        credentials: credentialsInput,`;

const newSendPaymentBlock = `    let requestedInfoId: string | undefined;

    if (cardHolderName) {
      try {
        const validateResult = await client.invoke(
          new Api.payments.ValidateRequestedInfo({
            save: false,
            invoice: new Api.InputInvoiceMessage({
              peer: peer as any,
              msgId: invoiceMsg.id,
            }),
            info: new Api.PaymentRequestedInfo({
              name: cardHolderName,
            }),
          })
        );
        requestedInfoId = (validateResult as any).id;
        logger.info({ requestedInfoId }, "Validated requested info (name) successfully");
      } catch (err: any) {
        logger.warn({ err: err?.message }, "Failed to validate requested info, proceeding without it");
      }
    }

    const result = await client.invoke(
      new Api.payments.SendPaymentForm({
        invoice: new Api.InputInvoiceMessage({
          peer: peer as any,
          msgId: invoiceMsg.id,
        }),
        formId: formId as any,
        ...(requestedInfoId ? { requestedInfoId } : {}),
        credentials: credentialsInput,`;

if (!code.includes('requestedInfoId: string | undefined;')) {
  code = code.replace(sendPaymentBlock, newSendPaymentBlock);
}

// 3. Pass cardHolderName when calling sendPaymentFormToTelegram in runFullPremiumFlow
const callBlock = `  const payResult = await sendPaymentFormToTelegram(
    client,
    premiumBotUsername,
    invoiceMsg,
    paymentFormInfo.formId,
    credentials,
  );`;

const newCallBlock = `  const payResult = await sendPaymentFormToTelegram(
    client,
    premiumBotUsername,
    invoiceMsg,
    paymentFormInfo.formId,
    credentials,
    card.cardHolder,
  );`;

if (!code.includes('card.cardHolder,')) {
  code = code.replace(callBlock, newCallBlock);
}

fs.writeFileSync(filepath, code);
