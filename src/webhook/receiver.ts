import { z } from 'zod';
import type { Request, Response } from 'express';
import { getQueue, withRetry } from '../queue/index.js';
import { analyzeAndStore } from '../analyzer/pipeline.js';
import type { WebhookEvent } from '../analyzer/types.js';

/** GitHub issues 이벤트 payload 중 분석에 필요한 필드만 검증하는 스키마. */
const issueEventSchema = z.object({
  action: z.string(),
  issue: z.object({ number: z.number() }),
  repository: z.object({ full_name: z.string() }),
});

/** 재분석을 트리거하는 issues 액션 (그 외는 무시). */
const HANDLED_ACTIONS = ['opened', 'edited', 'closed', 'reopened'];

/**
 * GitHub webhook 헤더/페이로드를 처리 대상 WebhookEvent로 변환한다.
 * 처리 대상이 아니면(다른 이벤트·액션이거나 페이로드 불충분) null을 반환한다.
 * 순수 함수 — 네트워크/큐 부수효과가 없어 단위 테스트가 가능하다.
 */
export function parseIssueEvent(
  event: string | undefined,
  payload: unknown,
  receivedAt: string
): WebhookEvent | null {
  if (event !== 'issues') return null;

  const parsed = issueEventSchema.safeParse(payload);
  if (!parsed.success) return null;
  if (!HANDLED_ACTIONS.includes(parsed.data.action)) return null;

  return {
    event_type: 'issues',
    action: parsed.data.action,
    repo: parsed.data.repository.full_name,
    issue_number: parsed.data.issue.number,
    received_at: receivedAt,
  };
}

/**
 * POST /webhook — GitHub Webhook 이벤트 수신 핸들러.
 * 서명 검증은 verifyWebhookSignature 미들웨어가 선행 처리한다.
 */
export function webhookHandler(req: Request, res: Response): void {
  const event = req.headers['x-github-event'] as string | undefined;

  // 즉시 200 응답 (GitHub 10초 타임아웃 방지)
  res.sendStatus(200);

  if (event === 'ping') {
    console.info('[webhook] ping — connected successfully');
    return;
  }

  const webhookEvent = parseIssueEvent(event, req.body, new Date().toISOString());
  if (!webhookEvent) return;

  console.info(
    `[webhook] issues.${webhookEvent.action} → ${webhookEvent.repo}#${webhookEvent.issue_number}`
  );

  // fire-and-forget: 큐에서 비동기 처리하되, 일시적 실패(GitHub/LLM 장애 등)에
  // 대비해 지수 백오프로 재시도한다. 각 시도의 상세 실패는 pipeline의 logAnalysis와
  // queue 'error' 리스너가 기록하므로, 여기서는 모든 재시도 소진 후의 최종 실패만
  // 로깅하면서 unhandled rejection을 방지한다.
  void getQueue()
    .add(() =>
      withRetry(
        () => analyzeAndStore(webhookEvent.repo, webhookEvent.issue_number, 'webhook'),
        {
          onRetry: (err, attempt) =>
            console.warn(
              `[webhook] analyze retry #${attempt} for ${webhookEvent.repo}#${webhookEvent.issue_number}:`,
              err
            ),
        }
      )
    )
    .catch((err) => console.error('[webhook] processing failed after retries:', err));
}
