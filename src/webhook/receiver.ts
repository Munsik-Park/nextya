import type { Request, Response } from 'express';
import { getQueue } from '../queue/index.js';
import { analyzeAndStore } from '../analyzer/pipeline.js';
import type { WebhookEvent } from '../analyzer/types.js';

/**
 * POST /webhook — GitHub Webhook 이벤트 수신 핸들러.
 * 서명 검증은 verifyWebhookSignature 미들웨어가 선행 처리.
 */
export async function webhookHandler(
  req: Request,
  res: Response
): Promise<void> {
  const event = req.headers['x-github-event'] as string;
  const payload = req.body as Record<string, unknown>;

  // 즉시 200 응답 (GitHub 타임아웃 방지)
  res.sendStatus(200);

  if (event === 'ping') {
    console.info('[webhook] ping — connected successfully');
    return;
  }

  if (event !== 'issues') return;

  const action = payload['action'] as string;
  // opened, edited, closed, reopened 만 처리
  if (!['opened', 'edited', 'closed', 'reopened'].includes(action)) return;

  const issuePayload = payload['issue'] as Record<string, unknown> | undefined;
  const repoPayload = payload['repository'] as Record<string, unknown> | undefined;

  const repo = repoPayload?.['full_name'] as string | undefined;
  const issueNumber = issuePayload?.['number'] as number | undefined;

  if (!repo || !issueNumber) {
    console.warn('[webhook] missing repo or issue_number', { event, action });
    return;
  }

  const webhookEvent: WebhookEvent = {
    event_type: 'issues',
    action,
    repo,
    issue_number: issueNumber,
    received_at: new Date().toISOString(),
  };

  console.info(`[webhook] ${event}.${action} → ${repo}#${issueNumber}`);
  getQueue().add(() => analyzeAndStore(webhookEvent.repo, webhookEvent.issue_number, 'webhook'));
}
