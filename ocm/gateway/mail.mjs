/**
 * Outbound mail. Exactly one message type exists: the account-recovery link.
 *
 * The SES client is imported on first use so local runs and the test suite stay
 * dependency-free; tests inject a stub through createGateway({ mailer }). Sending is
 * gated by OCM_RECOVERY_ENABLED at the gateway, and by Amazon's production-access
 * decision outside it: in the SES sandbox only verified recipients receive anything.
 */
export function createMailer({
  from = process.env.OCM_MAIL_FROM || 'Open-Compute Marketplace <no-reply@ocm.getdasha.com>',
  configurationSet = process.env.OCM_MAIL_CONFIGURATION_SET || 'ocm-transactional',
  region = process.env.OCM_REGION || 'us-west-2',
} = {}) {
  let clientPromise = null;
  const client = () => (clientPromise ||= import('@aws-sdk/client-sesv2')
    .then(({ SESv2Client, SendEmailCommand }) => ({ ses: new SESv2Client({ region }), SendEmailCommand })));
  return {
    async send({ to, subject, text }) {
      const { ses, SendEmailCommand } = await client();
      const out = await ses.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: configurationSet,
        Content: { Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Text: { Data: text, Charset: 'UTF-8' } },
        } },
      }));
      return { messageId: out.MessageId };
    },
  };
}

/**
 * The only message we send, word for word what Amazon was shown. It says why the
 * recipient got it, that the link works once and expires, that nothing changes unless
 * they act, and that ignoring it is safe.
 */
export function recoveryMessage({ link, consoleHost, minutes = 30 }) {
  return {
    subject: 'Recover access to your Open-Compute Marketplace account',
    text: `Someone asked to recover access to the account registered to this email
address at Open-Compute Marketplace.

If that was you, use the link below within ${minutes} minutes to issue a new API key:

  ${link}

The link can only be used once and expires in ${minutes} minutes. Your existing key
is not changed unless you complete this step.

If you did not request this, you can ignore this email. No change will be
made to the account, and we will not email you again unless you ask us to.

You received this because this address was used to create an account at
https://${consoleHost}. Open-Compute Marketplace.
`,
  };
}

/** "m…l@example.com": enough for the owner to recognise it, nothing for anyone else. */
export function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '…';
  const shown = local.length <= 2 ? local[0] || '' : `${local[0]}…${local[local.length - 1]}`;
  return `${shown}@${domain}`;
}
