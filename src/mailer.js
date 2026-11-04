// Email delivery. With SMTP_URL set, mail goes out through that server.
// Without it (the default for local use) every message is written to
// data/outbox/*.eml so you can open it in any mail client, and logged.
import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

export function createMailer({ config, outboxDir }) {
  const smtp = config.mail.smtpUrl ? nodemailer.createTransport(config.mail.smtpUrl) : null;
  const file = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });

  async function send({ to, subject, html, text, attachments }) {
    const msg = { from: config.mail.from, to, subject, html, text, attachments, disableFileAccess: true, disableUrlAccess: true };
    if (smtp) {
      try {
        await smtp.sendMail(msg);
        console.log(`[mail] sent "${subject}" to ${to}`);
        return { delivered: true };
      } catch (err) {
        console.error(`[mail] SMTP delivery failed (${err.message}); saving to outbox instead`);
      }
    }
    const info = await file.sendMail(msg);
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 50)}.eml`;
    const out = path.join(outboxDir, name);
    fs.writeFileSync(out, info.message);
    console.log(`[mail] (no SMTP configured) "${subject}" for ${to} saved to ${path.relative(config.root, out)}`);
    return { delivered: false, file: out };
  }

  return { send, configured: !!smtp };
}
