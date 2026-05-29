import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IssueSummary, IssueAnalysisResult } from './types.js';

// getDb 첫 호출 전에 인메모리 DB로 지정 (싱글턴이라 import보다 먼저 설정).
process.env.DATABASE_PATH = ':memory:';

const { analyzeAndStore } = await import('./pipeline.js');
const { getDb, getDependencies, getIssue } = await import('../store/index.js');

/** analysis_log 행 (테스트에서 읽는 필드만). */
interface LogRow {
  status: string;
  deps_found: number;
  duration_ms: number | null;
  error: string | null;
}

/** 테스트용 이슈 객체를 만든다. */
function makeIssue(number: number, over: Partial<IssueSummary> = {}): IssueSummary {
  return {
    number,
    title: `issue ${number}`,
    body: '',
    state: 'open',
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    ...over,
  };
}

/** 테스트용 분석 결과를 만든다. */
function makeResult(
  repo: string,
  number: number,
  dependsOn: Array<{ number: number; reason: string; confidence: number }>
): IssueAnalysisResult {
  return {
    repo,
    analyzed_issue_number: number,
    depends_on: dependsOn,
    blocks: [],
    ready_to_start: dependsOn.length === 0,
    notes: '',
    model_used: 'test-model',
    analyzed_at: '2026-01-01T00:00:00Z',
  };
}

/** 특정 이슈의 가장 최근 analysis_log 행을 읽는다. */
function lastLog(repo: string, issueNumber: number): LogRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM analysis_log WHERE repo = ? AND issue_number = ? ORDER BY id DESC LIMIT 1`
    )
    .get(repo, issueNumber) as LogRow | undefined;
}

// ── AC #3: GitHub 조회 → 분석 → SQLite 저장 ───────────────────────────────────

test('analyzeAndStore: fetchIssue→analyze 결과를 SQLite에 저장한다', async () => {
  const repo = 'o/p3';
  await analyzeAndStore(repo, 10, 'test', {
    fetchIssue: async () => makeIssue(10, { title: 'Target' }),
    analyze: async () => makeResult(repo, 10, [{ number: 1, reason: 'needs schema', confidence: 0.9 }]),
  });

  const issue = getIssue(repo, 10);
  assert.equal(issue?.title, 'Target');
  assert.ok(issue?.last_analyzed_at, 'last_analyzed_at이 기록되어야 함');

  const deps = getDependencies(repo, 10);
  assert.equal(deps.length, 1);
  assert.equal(deps[0]!.depends_on_number, 1);
  assert.equal(deps[0]!.source, 'llm');
});

// ── AC #4: closed 이슈는 분석 skip + 'skipped' 로그 ───────────────────────────

test("analyzeAndStore: closed 이슈는 분석을 skip하고 'skipped' 로그를 남긴다", async () => {
  const repo = 'o/p4';
  let analyzeCalled = false;
  await analyzeAndStore(repo, 20, 'test', {
    fetchIssue: async () => makeIssue(20, { state: 'closed' }),
    analyze: async () => {
      analyzeCalled = true;
      return null;
    },
  });

  assert.equal(analyzeCalled, false, 'closed면 analyze를 호출하지 않아야 함');
  assert.equal(getDependencies(repo, 20).length, 0);
  assert.equal(lastLog(repo, 20)?.status, 'skipped');
});

// ── AC #5: 재분석 시 기존 deps 초기화 후 교체 ─────────────────────────────────

test('analyzeAndStore: 재분석 시 기존 deps를 초기화하고 새 결과로 교체한다', async () => {
  const repo = 'o/p5';
  const fetchIssue = async () => makeIssue(30);

  // 1차: #1, #2 의존
  await analyzeAndStore(repo, 30, 'test', {
    fetchIssue,
    analyze: async () =>
      makeResult(repo, 30, [
        { number: 1, reason: 'a', confidence: 0.9 },
        { number: 2, reason: 'b', confidence: 0.9 },
      ]),
  });
  assert.equal(getDependencies(repo, 30).length, 2);

  // 2차: #3 의존만
  await analyzeAndStore(repo, 30, 'test', {
    fetchIssue,
    analyze: async () => makeResult(repo, 30, [{ number: 3, reason: 'c', confidence: 0.9 }]),
  });
  const deps = getDependencies(repo, 30);
  assert.equal(deps.length, 1, '기존 2개가 제거되고 새 1개로 교체');
  assert.equal(deps[0]!.depends_on_number, 3);
});

// ── AC #6: analysis_log에 duration_ms + deps_found 기록 ───────────────────────

test('analyzeAndStore: 성공 시 analysis_log에 duration_ms와 deps_found를 기록한다', async () => {
  const repo = 'o/p6';
  await analyzeAndStore(repo, 40, 'test', {
    fetchIssue: async () => makeIssue(40),
    analyze: async () =>
      makeResult(repo, 40, [
        { number: 1, reason: 'a', confidence: 0.9 },
        { number: 2, reason: 'b', confidence: 0.9 },
      ]),
  });

  const log = lastLog(repo, 40);
  assert.equal(log?.status, 'success');
  assert.equal(log?.deps_found, 2);
  assert.equal(typeof log?.duration_ms, 'number');
  assert.ok((log?.duration_ms ?? -1) >= 0);
});

// ── 실패 경로: 분석 null / fetch throw ────────────────────────────────────────

test('analyzeAndStore: 분석이 null이면 error 로그를 남기고 deps를 저장하지 않는다', async () => {
  const repo = 'o/p7';
  await analyzeAndStore(repo, 50, 'test', {
    fetchIssue: async () => makeIssue(50),
    analyze: async () => null,
  });
  assert.equal(getDependencies(repo, 50).length, 0);
  assert.equal(lastLog(repo, 50)?.status, 'error');
});

test('analyzeAndStore: fetchIssue 실패 시 error 로그를 남기고 재throw한다', async () => {
  const repo = 'o/p8';
  await assert.rejects(
    analyzeAndStore(repo, 60, 'test', {
      fetchIssue: async () => {
        throw new Error('boom');
      },
      analyze: async () => null,
    }),
    /boom/
  );
  const log = lastLog(repo, 60);
  assert.equal(log?.status, 'error');
  assert.match(log?.error ?? '', /boom/);
});
