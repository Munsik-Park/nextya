import { z } from 'zod';
import {
  getOpenIssues,
  getAllIssues,
  getAllDependencies,
  getIssue,
  getDependencies,
} from '../store/index.js';
import { analyzeAndStore, analyzeRepo } from '../analyzer/pipeline.js';
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
      const openNums = new Set(issues.map((i) => i.number));
      const edges = getAllDependencies(r);
      // 아직 열려 있는 선행 의존성이 있는 이슈만 blocked로 본다.
      // closed blocker(openNums에 없음)는 이미 해소된 것이므로 블로킹하지 않는다 → topoSort step1과 일관.
      const blocked = new Set(
        edges.filter((e) => openNums.has(e.depends_on_number)).map((e) => e.issue_number)
      );
      const ready = issues.filter((i) => !blocked.has(i.number));
      return {
        issues: ready.map((i) => ({
          number: i.number,
          title: i.title,
          labels: i.labels,
          reason_ready: '열린 선행 의존성 없음',
        })),
        count: ready.length,
      };
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
      const issue = getIssue(r, issue_number);
      if (!issue) return { error: `#${issue_number} not found in ${r}` };
      // blocker/blocks 대상의 상태 표기를 위해 closed 이슈까지 포함해 맵을 구성한다.
      const iMap = new Map(getAllIssues(r).map((i) => [i.number, i]));
      const edges = getAllDependencies(r);
      const blockedBy = edges.filter((e) => e.issue_number === issue_number).map((e) => ({
        number: e.depends_on_number,
        title: iMap.get(e.depends_on_number)?.title ?? '',
        state: iMap.get(e.depends_on_number)?.state ?? 'unknown',
        reason: e.reason,
      }));
      const blocks = edges.filter((e) => e.depends_on_number === issue_number).map((e) => ({
        number: e.issue_number,
        title: iMap.get(e.issue_number)?.title ?? '',
        state: iMap.get(e.issue_number)?.state ?? 'unknown',
        reason: e.reason,
      }));
      // 모든 선행 의존성이 closed면 시작 가능 (열린 blocker가 하나도 없을 때).
      const readyToStart = blockedBy.every((b) => b.state === 'closed');
      return {
        issue: {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels,
        },
        blocked_by: blockedBy,
        blocks,
        ready_to_start: readyToStart,
        last_analyzed_at: issue.last_analyzed_at ?? null,
      };
    },
  },
  {
    name: 'get_blocked_issues',
    description: '현재 블로킹된 이슈와 해제 조건',
    schema: repoSchema,
    handler: ({ repo }: { repo?: string }) => {
      const r = getDefaultRepo(repo);
      const issues = getOpenIssues(r);
      const openNums = new Set(issues.map((i) => i.number));
      const iMap = new Map(getAllIssues(r).map((i) => [i.number, i]));
      const edges = getAllDependencies(r);
      // 열린 이슈 중, 아직 열린 선행 의존성이 있는 것만 블로킹 대상으로 본다.
      const blockedNums = [
        ...new Set(
          edges
            .filter((e) => openNums.has(e.issue_number) && openNums.has(e.depends_on_number))
            .map((e) => e.issue_number)
        ),
      ];
      const blocked = blockedNums.map((num) => {
        const waitingFor = edges
          .filter((e) => e.issue_number === num && openNums.has(e.depends_on_number))
          .map((e) => ({
            number: e.depends_on_number,
            title: iMap.get(e.depends_on_number)?.title ?? '',
            state: iMap.get(e.depends_on_number)?.state ?? 'unknown',
          }));
        return {
          issue: { number: num, title: iMap.get(num)?.title ?? '' },
          waiting_for: waitingFor,
          will_unblock_when: waitingFor.map((w) => `#${w.number} closes`).join(', '),
        };
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
        return {
          analyzed: 1,
          deps_found: getDependencies(r, issue_number).length,
          duration_ms: Date.now() - start,
        };
      }
      // issue_number 미지정: GitHub에서 오픈 이슈 전체를 받아 동기화 후 분석.
      // (캐시만 순회하면 webhook 미수신 이슈가 누락되므로 analyzeRepo로 전체 조회한다.)
      const { analyzed, depsFound } = await analyzeRepo(r, 'manual');
      return { analyzed, deps_found: depsFound, duration_ms: Date.now() - start };
    },
  },
];
