import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { buildAnalysisPrompt } from './prompt.js';
import type { IssueSummary, IssueAnalysisResult, DependencyEdge } from './types.js';

let _client: Anthropic | null = null;

/**
 * Anthropic 클라이언트 싱글턴을 lazy 초기화한다.
 * 모듈 import 시점이 아니라 첫 호출 시 생성하므로, API 키가 없는 환경에서도
 * 이 모듈을 거쳐가는 webhook 경로가 import만으로 깨지지 않는다.
 */
export function getAnthropicClient(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * 프롬프트를 LLM에 보내고 원시 텍스트 응답을 반환하는 함수 시그니처.
 * 테스트에서 mock LLM을 주입하기 위한 seam.
 */
export type CreateMessage = (prompt: string, model: string) => Promise<string>;

/** 기본 구현: Anthropic Messages API 호출 후 text 블록을 이어붙여 반환한다. */
const defaultCreateMessage: CreateMessage = async (prompt, model) => {
  const message = await getAnthropicClient().messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  return message.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { type: 'text'; text: string }).text)
    .join('');
};

/** LLM 응답 텍스트에서 markdown 코드펜스를 제거하고 trim한다. */
function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

const AnalysisResponseSchema = z.object({
  depends_on: z
    .array(z.object({ number: z.number(), reason: z.string(), confidence: z.number().min(0).max(1) }))
    .default([]),
  blocks: z
    .array(z.object({ number: z.number(), reason: z.string(), confidence: z.number().min(0).max(1) }))
    .default([]),
  ready_to_start: z.boolean().default(true),
  notes: z.string().default(''),
});

/**
 * 단일 이슈의 의존성을 LLM으로 분석한다.
 * 실패 시 1회 재시도. 그 후 null 반환.
 */
export async function analyzeIssueDependencies(
  repo: string,
  targetIssue: IssueSummary,
  allIssues: IssueSummary[],
  opts: { createMessage?: CreateMessage } = {}
): Promise<IssueAnalysisResult | null> {
  const createMessage = opts.createMessage ?? defaultCreateMessage;
  const model = process.env.ANALYSIS_MODEL ?? 'claude-haiku-4-5-20251001';
  const prompt = buildAnalysisPrompt(targetIssue, allIssues);
  const threshold = parseFloat(process.env.CONFIDENCE_THRESHOLD ?? '0.6');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rawText = stripCodeFences(await createMessage(prompt, model));
      const parsed = AnalysisResponseSchema.parse(JSON.parse(rawText));

      return {
        repo,
        analyzed_issue_number: targetIssue.number,
        depends_on: parsed.depends_on.filter((d) => d.confidence >= threshold),
        blocks: parsed.blocks.filter((b) => b.confidence >= threshold),
        ready_to_start: parsed.ready_to_start,
        notes: parsed.notes,
        model_used: model,
        analyzed_at: new Date().toISOString(),
      };
    } catch (err) {
      if (attempt === 0) {
        console.warn(`[analyzer] attempt 1 failed for #${targetIssue.number}, retrying...`);
        continue;
      }
      console.error(`[analyzer] failed for #${targetIssue.number}:`, err);
      return null;
    }
  }
  return null;
}

/**
 * 분석 결과를 DependencyEdge 배열로 변환한다.
 */
export function resultToEdges(
  result: IssueAnalysisResult
): Omit<DependencyEdge, 'source'>[] {
  return result.depends_on.map((d) => ({
    issue_number: result.analyzed_issue_number,
    depends_on_number: d.number,
    confidence: d.confidence,
    reason: d.reason,
  }));
}
