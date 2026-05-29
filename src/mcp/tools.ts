import { z } from 'zod';
import { getOpenIssues, getAllDependencies } from '../store/index.js';
import { analyzeAndStore } from '../analyzer/pipeline.js';
import type { ExecutionStep } from '../analyzer/types.js';

/** 위상 정렬로 실행 순서를 계산한다. */
function topoSort(repo: string): { steps: ExecutionStep[]; cycleDetected: boolean } {
  const issues = getOpenIssues(repo);
  const edges = getAllDependencies(repo);
  const openNums = new Set(issues.map((i) => i.number));

  const inDegree = new Map<number, number>();
  const adj = new Map<number, number[]>();
  for (const i of issues) {
    inDegree.set(i.number, 0);
    adj.set(i.number, []);
  }
  for (const e of edges) {
    if (!openNums.has(e.issue_number) || !openNums.has(e.depends_on_number)) continue;
    adj.get(e.depends_on_number)!.push(e.issue_number);
    inDegree.set(e.issue_number, (inDegree.get(e.issue_number) ?? 0) + 1);
  }

  const steps: ExecutionStep[] = [];
  const remaining = new Set(issues.map((i) => i.number));
  let stepNum = 1;

  while (remaining.size > 0) {
    const ready = [...remaining].filter((n) => (inDegree.get(n) ?? 0) === 0);
    if (ready.length === 0) return { steps, cycleDetected: true };
    steps.push({
      step: stepNum++,
      issues: ready.map((n) => ({ number: n, title: issues.find((i) => i.number === n)?.title ?? '' })),
      parallel: ready.length > 1,
    });
    for (const n of ready) {
      remaining.delete(n);
      for (const dep of adj.get(n) ?? []) {
        inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
      }
    }
  }
  return { steps, cycleDetected: false };
}

const repoSchema = z.object({ repo: z.string().optional() });
const getDefaultRepo = (repo?: string) => repo ?? process.env.DEFAULT_REPO ?? '';

export const mcpTools = [
  {
    name: 'get_ready_issues',
    description: '지금 바로 시작 가능한 이슈 목록 (블로킹 이슈 없음)',
    schema: repoSchema,
    handler: ({ repo }: { repo?: string }) => {
      const r = getDefaultRepo(repo);
      const issues = getOpenIssues(r);
      const edges = getAllDependencies(r);
      const blocked = new Set(edges.map((e) => e.issue_number));
      const ready = issues.filter((i) => !blocked.has(i.number));
      return { issues: ready.map((i) => ({ number: i.number, title: i.title, labels: i.labels })), count: ready.length };
    },
  },
  {
    name: 'get_execution_order',
    description: '전체 이슈 실행 순서 (위상 정렬). 같은 step은 병렬 가능',
    schema: repoSchema,
    handler: ({ repo }: { repo?: string }) => {
      const r = getDefaultRepo(repo);
      const { steps, cycleDetected } = topoSort(r);
      return { steps, total_issues: getOpenIssues(r).length, cycle_detected: cycleDetected };
    },
  },
  {
    name: 'get_issue_context',
    description: '이슈 + 의존성 + 상태 통합 조회',
    schema: z.object({ issue_number: z.number(), repo: z.string().optional() }),
    handler: ({ issue_number, repo }: { issue_number: number; repo?: string }) => {
      const r = getDefaultRepo(repo);
      const issues = getOpenIssues(r);
      const issue = issues.find((i) => i.number === issue_number);
      if (!issue) return { error: `#${issue_number} not found in ${r}` };
      const edges = getAllDependencies(r);
      const iMap = new Map(issues.map((i) => [i.number, i]));
      const blockedBy = edges.filter((e) => e.issue_number === issue_number).map((e) => ({
        number: e.depends_on_number, title: iMap.get(e.depends_on_number)?.title ?? '', state: iMap.get(e.depends_on_number)?.state ?? 'unknown', reason: e.reason,
      }));
      const blocks = edges.filter((e) => e.depends_on_number === issue_number).map((e) => ({
        number: e.issue_number, title: iMap.get(e.issue_number)?.title ?? '', state: iMap.get(e.issue_number)?.state ?? 'unknown', reason: e.reason,
      }));
      return { issue: { number: issue.number, title: issue.title, body: issue.body.slice(0, 500), state: issue.state, labels: issue.labels }, blocked_by: blockedBy, blocks, ready_to_start: blockedBy.length === 0 };
    },
  },
  {
    name: 'get_blocked_issues',
    description: '현재 블로킹된 이슈와 해제 조건',
    schema: repoSchema,
    handler: ({ repo }: { repo?: string }) => {
      const r = getDefaultRepo(repo);
      const issues = getOpenIssues(r);
      const edges = getAllDependencies(r);
      const iMap = new Map(issues.map((i) => [i.number, i]));
      const blockedNums = [...new Set(edges.map((e) => e.issue_number))];
      const blocked = blockedNums.map((num) => {
        const waitingFor = edges.filter((e) => e.issue_number === num).map((e) => ({
          number: e.depends_on_number, title: iMap.get(e.depends_on_number)?.title ?? '', state: iMap.get(e.depends_on_number)?.state ?? 'unknown',
        }));
        return { issue: { number: num, title: iMap.get(num)?.title ?? '' }, waiting_for: waitingFor, will_unblock_when: waitingFor.map((w) => `#${w.number} closes`).join(', ') };
      });
      return { blocked };
    },
  },
  {
    name: 'trigger_analysis',
    description: '수동으로 의존성 재분석을 트리거한다',
    schema: z.object({ repo: z.string().optional(), issue_number: z.number().optional() }),
    handler: async ({ repo, issue_number }: { repo?: string; issue_number?: number }) => {
      const r = getDefaultRepo(repo);
      const start = Date.now();
      if (issue_number) {
        await analyzeAndStore(r, issue_number, 'manual');
        return { analyzed: 1, duration_ms: Date.now() - start };
      }
      const issues = getOpenIssues(r);
      for (const issue of issues) await analyzeAndStore(r, issue.number, 'manual');
      return { analyzed: issues.length, duration_ms: Date.now() - start };
    },
  },
];
