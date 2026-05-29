/**
 * nextya 핵심 타입 정의
 * 모든 모듈이 이 파일의 타입을 기반으로 동작한다.
 */

/** GitHub 이슈 요약 (분석 입력) */
export interface IssueSummary {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** 마지막으로 의존성 분석이 수행된 시각 (미분석 시 null) */
  last_analyzed_at?: string | null;
}

/** 의존성 관계 단일 엣지 */
export interface DependencyEdge {
  /** 이 이슈가 */
  issue_number: number;
  /** 이것에 의존한다 (이것이 먼저 완료되어야 함) */
  depends_on_number: number;
  /** 의존 신뢰도 0.0~1.0 */
  confidence: number;
  /** LLM이 추출한 의존 근거 */
  reason: string;
  /** 출처 */
  source: 'llm' | 'manual';
}

/** LLM 분석 결과 (단일 이슈 기준) */
export interface IssueAnalysisResult {
  repo: string;
  analyzed_issue_number: number;
  /** 이 이슈가 의존하는 이슈들 */
  depends_on: Array<{ number: number; reason: string; confidence: number }>;
  /** 이 이슈가 블로킹하는 이슈들 */
  blocks: Array<{ number: number; reason: string; confidence: number }>;
  ready_to_start: boolean;
  notes: string;
  model_used: string;
  analyzed_at: string;
}

/** 위상 정렬 결과 (실행 단계) */
export interface ExecutionStep {
  step: number;
  issues: Array<{ number: number; title: string }>;
  /** 같은 step 내 이슈들은 병렬 가능 */
  parallel: boolean;
}

/** Webhook 이벤트 (큐 입력) */
export interface WebhookEvent {
  event_type: 'issues' | 'pull_request';
  action: string;
  repo: string;
  issue_number: number;
  received_at: string;
}
