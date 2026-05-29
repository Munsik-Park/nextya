import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * GitHub Webhook HMAC-SHA256 서명 검증 미들웨어.
 * X-Hub-Signature-256 헤더가 없거나 불일치 시 401 반환.
 */
export function verifyWebhookSignature(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook] GITHUB_WEBHOOK_SECRET not configured');
    res.status(500).json({ error: 'server misconfiguration' });
    return;
  }

  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  if (!signature) {
    res.status(401).json({ error: 'missing signature' });
    return;
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    res.status(400).json({ error: 'missing raw body' });
    return;
  }

  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')}`;

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  // 길이가 다르면 timingSafeEqual이 throw하므로 먼저 비교한다.
  // (길이 노출은 보안상 무해하며, 같을 때만 상수 시간 비교를 수행한다.)
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.warn('[webhook] signature verification failed');
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  next();
}
