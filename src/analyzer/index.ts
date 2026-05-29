import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { buildAnalysisPrompt } from './prompt.js';
import type { IssueSummary, IssueAnalysisResult, DependencyEdge } from './types.js';

const client = new Anthropic();

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
  allIssues: IssueSummary[]
): Promise<IssueAnalysisResult | null> {
  const model = process.env.ANALYSIS_MODEL ?? 'claude-haiku-4-5-20251001';
  const prompt = buildAnalysisPrompt(targetIssue, allIssues);
  const threshold = parseFloat(process.env.CONFIDENCE_THRESHOLD ?? '0.6');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const message = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });

      const rawText = message.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { type: 'text'; text: string }).text)
        .join('')
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

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
