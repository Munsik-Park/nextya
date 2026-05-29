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
import type { IssueSummary } from './types.js';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

/**
 * 특정 이슈를 GitHub에서 조회해 캐시를 갱신하고 의존성을 분석한다.
 * webhook 이벤트 처리 및 수동 trigger_analysis 에서 호출.
 */
export async function analyzeAndStore(
  repo: string,
  issueNumber: number,
  trigger: string
): Promise<void> {
  const start = Date.now();
  const [owner, repoName] = repo.split('/');

  try {
    // 1. GitHub에서 최신 이슈 정보 조회
    const { data } = await octokit.issues.get({
      owner: owner!,
      repo: repoName!,
      issue_number: issueNumber,
    });

    const targetIssue: IssueSummary = {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      state: data.state as 'open' | 'closed',
      labels: data.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
      created_at: data.created_at,
      updated_at: data.updated_at,
      closed_at: data.closed_at ?? null,
    };

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
    const result = await analyzeIssueDependencies(repo, targetIssue, allOpenIssues);
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
