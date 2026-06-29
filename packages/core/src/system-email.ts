/**
 * System email — transactional emails sent by the framework itself (e.g. password
 * resets). Distinct from per-client email connectors that agents use.
 *
 * The RESEND_API_KEY env var is an infra secret (Fly secret), not a DB setting.
 * If the key is absent we log a warning and return early — graceful degradation
 * keeps the app bootable in environments where email isn't configured yet.
 */

import { Resend } from 'resend';

const FROM_ADDRESS =
  process.env['FROM_EMAIL'] ?? 'noreply@frontrangesystems.com';

/**
 * Sends a password-reset email to `to` containing the `resetUrl`.
 * No-ops silently (with a warning log) when RESEND_API_KEY is not set.
 */
export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
): Promise<void> {
  const apiKey = process.env['RESEND_API_KEY'];

  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn(
      '[system-email] RESEND_API_KEY is not set — password reset email NOT sent to',
      to,
    );
    return;
  }

  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: 'Reset your password',
    html: `
      <p>You requested a password reset.</p>
      <p>
        <a href="${resetUrl}">Click here to reset your password</a>
      </p>
      <p>This link expires in 15 minutes. If you didn't request this, you can safely ignore this email.</p>
      <p style="font-size:12px;color:#666;">Or copy and paste this URL into your browser:<br>${resetUrl}</p>
    `,
  });

  if (error) {
    // Log the raw SDK error object (not interpolated into a string — Resend error.message
    // can contain the recipient address which we must not propagate into thrown messages).
    // eslint-disable-next-line no-console
    console.error('[system-email] Resend error sending password reset email:', error);
    throw new Error('Failed to send password reset email');
  }
}
