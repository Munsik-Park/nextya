import type { IssueSummary } from './types.js';

/**
 * 단일 이슈 의존성 분석 프롬프트 빌더
 */
export function buildAnalysisPrompt(
  targetIssue: IssueSummary,
  allIssues: IssueSummary[]
): string {
  const otherIssues = allIssues
    .filter((i) => i.number !== targetIssue.number)
    .map(
      (i) =>
        `### Issue #${i.number}: ${i.title} [${i.state}]\n${i.body.slice(0, 800)}${
          i.body.length > 800 ? '...' : ''
        }`
    )
    .join('\n\n');

  return `You are analyzing GitHub issues to extract dependency relationships.

Analyze the TARGET ISSUE and determine which other issues it depends on (must be completed first).

## TARGET ISSUE
### Issue #${targetIssue.number}: ${targetIssue.title}
${targetIssue.body}

## ALL OTHER OPEN ISSUES
${otherIssues || '(none)'}

## Instructions

Look for dependency signals in issue bodies:
- Explicit: "depends on #N", "after #N", "requires #N", "의존", "선행", "완료 후"
- Implicit: references to work that must exist first (schema, API, interface)
- Korean patterns: "#N 완료 후", "#N 머지 후", "#N 기반", "S3 의존"

Return a JSON object ONLY (no markdown, no explanation):
{
  "depends_on": [
    { "number": <issue_number>, "reason": "<brief reason>", "confidence": <0.0-1.0> }
  ],
  "blocks": [
    { "number": <issue_number>, "reason": "<brief reason>", "confidence": <0.0-1.0> }
  ],
  "ready_to_start": <true if no unresolved blockers>,
  "notes": "<optional additional context>"
}

Only include dependencies with confidence >= 0.5.
If no dependencies found, return empty arrays.`;
}
