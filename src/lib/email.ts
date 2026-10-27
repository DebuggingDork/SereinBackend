import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null;

interface Mail {
  to: string;
  subject: string;
  text: string;
}

function renderHtml(text: string): string {
  const paragraphs = text
    .split('\n\n')
    .map((paragraph) => `<p style="margin:0 0 16px">${escapeHtml(paragraph)}</p>`)
    .join('');
  return `<div style="font-family:Georgia,serif;font-size:16px;line-height:1.6;color:#14171a;max-width:480px">
    <p style="margin:0 0 24px;font-size:22px">Serein<span style="color:#10b981">.</span></p>
    ${paragraphs}
  </div>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Mail failures are logged, never thrown: a broken mail server must not block
// the security flow that triggered the message.
export async function sendMail({ to, subject, text }: Mail): Promise<void> {
  if (!transport) {
    console.info(`[mail] SMTP not configured. Would send "${subject}" to ${to}`);
    return;
  }
  try {
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text, html: renderHtml(text) });
  } catch (error) {
    console.error(`[mail] Failed to send "${subject}"`, error);
  }
}
