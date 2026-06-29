import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Unit tests for system-email module.
// We mock the `resend` package so these tests run without a real API key.

describe('sendPasswordResetEmail', () => {
  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMock = vi.fn().mockResolvedValue({ data: { id: 'fake-id' }, error: null });
    vi.doMock('resend', () => ({
      Resend: vi.fn().mockImplementation(() => ({
        emails: { send: sendMock },
      })),
    }));
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('sends an email via Resend when RESEND_API_KEY is set', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key-abc');
    const { sendPasswordResetEmail } = await import('../src/system-email.js');

    await sendPasswordResetEmail('user@example.com', 'https://app.example.com/reset-password?token=abc123');

    expect(sendMock).toHaveBeenCalledOnce();
    const call = sendMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.to).toBe('user@example.com');
    expect(typeof call.subject).toBe('string');
    expect(String(call.html ?? call.text ?? '')).toContain('https://app.example.com/reset-password?token=abc123');
  });

  it('does NOT throw and does NOT call Resend when RESEND_API_KEY is absent', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const { sendPasswordResetEmail } = await import('../src/system-email.js');

    // Should resolve without throwing
    await expect(sendPasswordResetEmail('user@example.com', 'https://example.com/reset')).resolves.toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends from noreply@frontrangesystems.com', async () => {
    vi.stubEnv('RESEND_API_KEY', 'test-key-abc');
    const { sendPasswordResetEmail } = await import('../src/system-email.js');

    await sendPasswordResetEmail('user@example.com', 'https://example.com/reset');

    const call = sendMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call.from).toBe('noreply@frontrangesystems.com');
  });
});
