import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IssueSummary } from '../analyzer/types.js';

// getDb 첫 호출 전에 인메모리 DB로 지정 (싱글턴이라 import보다 먼저 설정).
process.env.DATABASE_PATH = ':memory:';
// tools → pipeline → analyzer/index(Anthropic) 전이 의존 대비 더미 키.
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
// DEFAULT_REPO 폴백이 테스트 격리를 깨지 않도록 비운다.
process.env.DEFAULT_REPO = '';

const { mcpTools } = await import('./tools.js');
const { upsertIssue, upsertDependency, markAnalyzed } = await import('../store/index.js');

/** 이름으로 MCP 툴 핸들러를 꺼낸다. */
function handler(name: string): (args: Record<string, unknown>) => unknown | Promise<unknown> {
  const t = mcpTools.find((t) => t.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t.handler as (args: Record<string, unknown>) => unknown;
}

/** 테스트용 이슈를 만든다. */
function makeIssue(number: number, over: Partial<IssueSummary> = {}): IssueSummary {
  return {
    number,
    title: `issue ${number}`,
    body: `body ${number}`,
    state: 'open',
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    ...over,
  };
}

/** issue_number → depends_on_number 의존 엣지를 저장한다. */
function dep(repo: string, issueNumber: number, dependsOn: number, reason = ''): void {
  upsertDependency({
    repo,
    issue_number: issueNumber,
    depends_on_number: dependsOn,
    confidence: 0.9,
    reason,
    source: 'llm',
  });
}

// ── AC #3: get_ready_issues — 블로킹 엣지 있는 이슈 제외 ───────────────────────

test('get_ready_issues: 열린 선행 의존성이 있는 이슈는 제외한다', () => {
  const repo = 'o/ready';
  upsertIssue(repo, makeIssue(1));
  upsertIssue(repo, makeIssue(2));
  upsertIssue(repo, makeIssue(3));
  dep(repo, 2, 1); // #2 → #1

  const out = handler('get_ready_issues')({ repo }) as {
    issues: Array<{ number: number; reason_ready: string }>;
    count: number;
  };
  assert.deepEqual(out.issues.map((i) => i.number).sort(), [1, 3]); // #2는 #1에 막힘
  assert.equal(out.count, 2);
  assert.ok(out.issues[0]!.reason_ready, 'reason_ready 필드가 있어야 함');
});

test('get_ready_issues: closed 선행 의존성만 있는 이슈는 ready로 본다', () => {
  const repo = 'o/ready-closed';
  upsertIssue(repo, makeIssue(1, { state: 'closed' })); // 이미 닫힌 blocker
  upsertIssue(repo, makeIssue(2));
  dep(repo, 2, 1); // #2 → (closed) #1

  const out = handler('get_ready_issues')({ repo }) as { issues: Array<{ number: number }> };
  assert.deepEqual(
    out.issues.map((i) => i.number),
    [2],
    'closed blocker는 해소된 것이므로 #2는 시작 가능'
  );
});

// ── AC #4: get_execution_order — 순환 의존성 감지 ─────────────────────────────

test('get_execution_order: 순환 의존성이 있으면 cycle_detected=true', () => {
  const repo = 'o/cycle';
  upsertIssue(repo, makeIssue(1));
  upsertIssue(repo, makeIssue(2));
  dep(repo, 1, 2); // #1 → #2
  dep(repo, 2, 1); // #2 → #1 (순환)

  const out = handler('get_execution_order')({ repo }) as { cycle_detected: boolean };
  assert.equal(out.cycle_detected, true);
});

test('get_execution_order: 비순환은 위상 정렬 단계로 나누고 같은 step은 병렬 표시', () => {
  const repo = 'o/topo';
  upsertIssue(repo, makeIssue(1));
  upsertIssue(repo, makeIssue(2));
  upsertIssue(repo, makeIssue(3));
  dep(repo, 3, 1); // #3 → #1
  dep(repo, 3, 2); // #3 → #2

  const out = handler('get_execution_order')({ repo }) as {
    steps: Array<{ step: number; issues: Array<{ number: number }>; parallel: boolean }>;
    total_issues: number;
    cycle_detected: boolean;
  };
  assert.equal(out.cycle_detected, false);
  assert.equal(out.total_issues, 3);
  assert.deepEqual(out.steps[0]!.issues.map((i) => i.number).sort(), [1, 2]);
  assert.equal(out.steps[0]!.parallel, true, '#1·#2는 병렬 가능');
  assert.deepEqual(out.steps[1]!.issues.map((i) => i.number), [3]);
  assert.equal(out.steps[1]!.parallel, false);
});

// ── AC #5: get_issue_context — 없는 이슈는 error 필드 반환 ─────────────────────

test('get_issue_context: 존재하지 않는 이슈는 error 필드를 반환한다', () => {
  const repo = 'o/ctx-missing';
  const out = handler('get_issue_context')({ repo, issue_number: 999 }) as { error?: string };
  assert.ok(out.error, 'error 필드가 있어야 함');
  assert.match(out.error!, /999/);
});

test('get_issue_context: blocked_by/blocks/last_analyzed_at를 반환하고 closed blocker 상태를 표기한다', () => {
  const repo = 'o/ctx';
  upsertIssue(repo, makeIssue(1, { state: 'closed' })); // closed blocker
  upsertIssue(repo, makeIssue(2));
  upsertIssue(repo, makeIssue(3));
  dep(repo, 2, 1, 'needs #1'); // #2 → (closed) #1
  dep(repo, 3, 2, 'needs #2'); // #3 → #2
  markAnalyzed(repo, 2);

  const out = handler('get_issue_context')({ repo, issue_number: 2 }) as {
    issue: { number: number; body: string };
    blocked_by: Array<{ number: number; state: string; reason: string }>;
    blocks: Array<{ number: number }>;
    ready_to_start: boolean;
    last_analyzed_at: string | null;
  };
  assert.equal(out.issue.number, 2);
  assert.equal(out.issue.body, 'body 2', 'body 전체를 반환');
  assert.equal(out.blocked_by.length, 1);
  assert.equal(out.blocked_by[0]!.number, 1);
  assert.equal(out.blocked_by[0]!.state, 'closed');
  assert.equal(out.blocked_by[0]!.reason, 'needs #1');
  assert.deepEqual(out.blocks.map((b) => b.number), [3]);
  assert.equal(out.ready_to_start, true, '유일한 blocker #1이 closed라 시작 가능');
  assert.ok(out.last_analyzed_at, 'last_analyzed_at이 기록되어야 함');
});

test('get_issue_context: 열린 blocker가 있으면 ready_to_start=false', () => {
  const repo = 'o/ctx-blocked';
  upsertIssue(repo, makeIssue(1)); // open blocker
  upsertIssue(repo, makeIssue(2));
  dep(repo, 2, 1);

  const out = handler('get_issue_context')({ repo, issue_number: 2 }) as {
    ready_to_start: boolean;
  };
  assert.equal(out.ready_to_start, false);
});

// ── get_blocked_issues — 열린 blocker가 있는 이슈와 해제 조건 ──────────────────

test('get_blocked_issues: 열린 선행 의존성이 있는 이슈와 해제 조건을 반환한다', () => {
  const repo = 'o/blocked';
  upsertIssue(repo, makeIssue(1));
  upsertIssue(repo, makeIssue(2));
  dep(repo, 2, 1);

  const out = handler('get_blocked_issues')({ repo }) as {
    blocked: Array<{
      issue: { number: number };
      waiting_for: Array<{ number: number }>;
      will_unblock_when: string;
    }>;
  };
  assert.equal(out.blocked.length, 1);
  assert.equal(out.blocked[0]!.issue.number, 2);
  assert.deepEqual(out.blocked[0]!.waiting_for.map((w) => w.number), [1]);
  assert.match(out.blocked[0]!.will_unblock_when, /#1/);
});

test('get_blocked_issues: closed blocker만 있으면 블로킹 목록에서 제외한다', () => {
  const repo = 'o/blocked-closed';
  upsertIssue(repo, makeIssue(1, { state: 'closed' }));
  upsertIssue(repo, makeIssue(2));
  dep(repo, 2, 1);

  const out = handler('get_blocked_issues')({ repo }) as { blocked: unknown[] };
  assert.equal(out.blocked.length, 0, 'closed blocker는 해소된 것이므로 #2는 blocked가 아님');
});
