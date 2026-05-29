import { Octokit } from '@octokit/rest';
import { analyzeIssueDependencies, resultToEdges } from './index.js';
import {
  upsertIssue,
  upsertDependency,
  clearDependencies,
  markAnalyzed,
  getOpenIssues,
  logAnalysis,
} from '../store/index.js';
import type { IssueSummary, IssueAnalysisResult } from './types.js';

let _octokit: Octokit | null = null;

/** Octokit 싱글턴을 lazy 초기화한다 (모듈 import 시점 부수효과 방지). */
function getOctokit(): Octokit {
  if (!_octokit) _octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  return _octokit;
}

/** repo의 단일 이슈를 GitHub에서 조회해 IssueSummary로 변환하는 함수 시그니처. 테스트 주입용. */
export type FetchIssue = (repo: string, issueNumber: number) => Promise<IssueSummary>;

/** 단일 이슈를 LLM으로 분석하는 함수 시그니처. 테스트 주입용. */
export type AnalyzeIssue = (
  repo: string,
  target: IssueSummary,
  all: IssueSummary[]
) => Promise<IssueAnalysisResult | null>;

/** 기본 구현: Octokit으로 이슈를 조회해 IssueSummary로 매핑한다. */
const defaultFetchIssue: FetchIssue = async (repo, issueNumber) => {
  const [owner, repoName] = repo.split('/');
  const { data } = await getOctokit().issues.get({
    owner: owner!,
    repo: repoName!,
    issue_number: issueNumber,
  });
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    state: data.state as 'open' | 'closed',
    labels: data.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
    created_at: data.created_at,
    updated_at: data.updated_at,
    closed_at: data.closed_at ?? null,
  };
};

/**
 * 특정 이슈를 GitHub에서 조회해 캐시를 갱신하고 의존성을 분석한다.
 * webhook 이벤트 처리 및 수동 trigger_analysis 에서 호출.
 */
export async function analyzeAndStore(
  repo: string,
  issueNumber: number,
  trigger: string,
  deps: { fetchIssue?: FetchIssue; analyze?: AnalyzeIssue } = {}
): Promise<void> {
  const fetchIssue = deps.fetchIssue ?? defaultFetchIssue;
  const analyze = deps.analyze ?? analyzeIssueDependencies;
  const start = Date.now();

  try {
    // 1. GitHub에서 최신 이슈 정보 조회
    const targetIssue = await fetchIssue(repo, issueNumber);

    // 2. 이슈 캐시 업데이트
    upsertIssue(repo, targetIssue);

    // 3. 닫힌 이슈면 분석 불필요
    if (targetIssue.state === 'closed') {
      logAnalysis({ repo, trigger, issue_number: issueNumber, status: 'skipped' });
      return;
    }

    // 4. 레포 내 오픈 이슈 전체 조회 (캐시 기반)
    const allOpenIssues = getOpenIssues(repo);

    // 5. LLM 분석
    const result = await analyze(repo, targetIssue, allOpenIssues);
    if (!result) {
      logAnalysis({ repo, trigger, issue_number: issueNumber, status: 'error', error: 'analysis returned null' });
      return;
    }

    // 6. 기존 의존성 초기화 후 새 결과 저장
    clearDependencies(repo, issueNumber);
    const edges = resultToEdges(result);
    for (const edge of edges) {
      upsertDependency({ ...edge, repo, source: 'llm' });
    }
    markAnalyzed(repo, issueNumber);

    logAnalysis({
      repo,
      trigger,
      issue_number: issueNumber,
      status: 'success',
      deps_found: edges.length,
      duration_ms: Date.now() - start,
    });

    console.info(`[pipeline] #${issueNumber} → ${edges.length} deps (${Date.now() - start}ms)`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logAnalysis({ repo, trigger, issue_number: issueNumber, status: 'error', error, duration_ms: Date.now() - start });
    console.error(`[pipeline] error #${issueNumber}:`, err);
    throw err;
  }
}
