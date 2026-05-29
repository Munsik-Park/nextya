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

    // 4. 레포 내 오픈 이슈 전체(캐시)를 컨텍스트로 분석 후 저장
    const allOpenIssues = getOpenIssues(repo);
    await storeAnalysis(repo, targetIssue, allOpenIssues, analyze, trigger, start);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logAnalysis({ repo, trigger, issue_number: issueNumber, status: 'error', error, duration_ms: Date.now() - start });
    console.error(`[pipeline] error #${issueNumber}:`, err);
    throw err;
  }
}

/**
 * 단일 이슈를 분석하고 결과를 저장한다 (이슈는 호출 전에 upsert된 상태로 가정).
 * 성공 시 저장된 의존성 엣지 수를, 분석 실패(null) 시 0을 반환하며 각 경우 analysis_log를 남긴다.
 * analyzeAndStore(단일)와 analyzeRepo(전체)가 공유하는 저장 코어.
 */
async function storeAnalysis(
  repo: string,
  target: IssueSummary,
  allOpenIssues: IssueSummary[],
  analyze: AnalyzeIssue,
  trigger: string,
  start: number
): Promise<number> {
  const result = await analyze(repo, target, allOpenIssues);
  if (!result) {
    logAnalysis({
      repo,
      trigger,
      issue_number: target.number,
      status: 'error',
      error: 'analysis returned null',
      duration_ms: Date.now() - start,
    });
    return 0;
  }

  clearDependencies(repo, target.number);
  const edges = resultToEdges(result);
  for (const edge of edges) {
    upsertDependency({ ...edge, repo, source: 'llm' });
  }
  markAnalyzed(repo, target.number);

  logAnalysis({
    repo,
    trigger,
    issue_number: target.number,
    status: 'success',
    deps_found: edges.length,
    duration_ms: Date.now() - start,
  });

  console.info(`[pipeline] #${target.number} → ${edges.length} deps (${Date.now() - start}ms)`);
  return edges.length;
}

/** repo의 오픈 이슈 전체를 GitHub에서 조회하는 함수 시그니처. 테스트 주입용. */
export type ListOpenIssues = (repo: string) => Promise<IssueSummary[]>;

/** 기본 구현: Octokit으로 오픈 이슈 전체를 페이지네이션 조회한다 (PR은 제외). */
const defaultListOpenIssues: ListOpenIssues = async (repo) => {
  const [owner, repoName] = repo.split('/');
  const items = await getOctokit().paginate(getOctokit().issues.listForRepo, {
    owner: owner!,
    repo: repoName!,
    state: 'open',
    per_page: 100,
  });
  return items
    .filter((i) => !i.pull_request)
    .map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      state: i.state as 'open' | 'closed',
      labels: i.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
      created_at: i.created_at,
      updated_at: i.updated_at,
      closed_at: i.closed_at ?? null,
    }));
};

/**
 * 레포의 오픈 이슈 전체를 GitHub에서 받아 캐시에 upsert한 뒤 각각 분석한다.
 * trigger_analysis(issue_number 미지정) 경로에서 사용 — webhook을 한 번도 받지 못한
 * 이슈도 누락 없이 캐시에 반영되고 서로의 분석 컨텍스트가 된다.
 * 개별 이슈 분석 실패는 로그를 남기고 건너뛰며, 나머지 이슈 분석을 계속한다.
 */
export async function analyzeRepo(
  repo: string,
  trigger: string,
  deps: { listOpenIssues?: ListOpenIssues; analyze?: AnalyzeIssue } = {}
): Promise<{ analyzed: number; depsFound: number }> {
  const listOpenIssues = deps.listOpenIssues ?? defaultListOpenIssues;
  const analyze = deps.analyze ?? analyzeIssueDependencies;

  // 1. 오픈 이슈 전체를 먼저 캐시에 반영 (서로의 분석 컨텍스트가 되도록)
  const issues = await listOpenIssues(repo);
  for (const issue of issues) upsertIssue(repo, issue);

  // 2. 각 이슈를 전체 오픈 이슈 컨텍스트로 분석
  let depsFound = 0;
  for (const target of issues) {
    depsFound += await storeAnalysis(repo, target, issues, analyze, trigger, Date.now());
  }

  console.info(`[pipeline] analyzeRepo ${repo}: ${issues.length} issues, ${depsFound} deps`);
  return { analyzed: issues.length, depsFound };
}
