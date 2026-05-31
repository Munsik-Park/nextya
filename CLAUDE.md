# CLAUDE.md

> Claude Code가 이 파일을 읽고 컨텍스트 없이도 바로 개발을 시작할 수 있어야 한다.
> 모든 아키텍처 결정, 컨벤션, 스펙이 여기에 있다.
> **제품 컨셉의 "왜"는 [docs/concept.md](docs/concept.md) (Concept v0)** 를 본다.

## 프로젝트: nextya

**"야, 다음은 뭐야?"** — GitHub 이슈가 AI(Auto-Flow 등)에 의해 자동 생성되는 시대에,
이슈 간 의존성을 분석해 **사람(PM·개발자)에게 "지금 뭐부터 해야 하는지" 한 개를 콕 집어**
추천하는 도구. 분석 결과는 웹 대시보드로 사람이 먼저 소비하고, MCP를 통한 AI 에이전트
자동 착수는 2차 목표다.

### 현재 단계: 사람 우선 MVP

기존 스프린트(#1~#5 + CI/CD)로 **webhook → 큐 → LLM → SQLite → MCP** 수직 슬라이스가
완성됐다. 지금은 그 위에 **판단 레이어**를 얹는 단계다 (자세한 결정 근거는 docs/concept.md):

- **소비 주체**: 사람 먼저. MCP 5-tool은 **동결 보존**(삭제 X), 에이전트 자동 착수는 2차.
- **"다음" 정의**: ready 이슈 중 **직접 unblock 수가 최대**인 이슈 1개 추천.
- **의존성 근거**: **하이브리드** — 명시 신호(본문 키워드 + task list/sub-issues + 라벨)를
  우선 적용, LLM은 빈틈만 보강.
- **범위**: 단일 레포 (`DEFAULT_REPO=connev-llm/claude-autoflow` dogfooding).
- **설계 원칙**: 뷰는 얇게, 판단 로직은 `store`/`analyzer`/`score`에 둬서 나중에 MCP가
  동일 로직을 그대로 소비하도록 한다 (사람+AI 항상 고려).

### 핵심 흐름

```
GitHub 이슈 (webhook / 수동 trigger)
    ↓
레포 오픈 이슈 전체 조회 (콜드스타트 갭 방지: analyzeRepo로 전체 동기화)
    ↓
하이브리드 의존성 추출
   ├─ 명시 신호 파서 (규칙)  → source='explicit', confidence=1.0
   └─ LLM 보강 (빈틈만)       → source='llm', confidence<1.0 (충돌 시 explicit 우선)
    ↓
SQLite 저장 (issues, dependencies, analysis_log)
    ↓
임팩트 점수(직접 unblock 수) → '다음 작업' 1개 추천
    ↓
웹 대시보드 (사람) ─── 같은 로직 ─── MCP (AI, 2차)
```

---

## 세션 운영 규칙 (중요: 1 세션 = 1 이슈)

세션이 길어지면 컨텍스트가 비대해진다. **한 세션은 GitHub 이슈 정확히 1개**만 처리한다.

1. **이슈 선택**: 마일스톤 `MVP: 사람 우선 의존성 대시보드`에서 의존성이 모두 해소된
   (선행 이슈가 닫힌) 이슈 중 번호가 가장 낮은 것을 고른다.
2. **브랜치**: `feat/s<N>-<slug>` (이슈 본문의 "세션 가이드"에 권장 이름 명시).
3. **작업**: 이슈의 "범위 / 완료 조건" 체크리스트를 모두 충족. 테스트 포함.
4. **PR**: 이슈를 닫는 PR 1개. `Closes #<N>`.
5. 한 세션에서 여러 이슈를 동시에 건드리지 않는다. 범위를 넘으면 새 이슈로 분리한다.

> 이슈 본문의 `Depends on #N` 라인은 nextya 자신의 의존성 파서가 dogfooding하는
> 대상이기도 하다. 추가 의존을 발견하면 같은 형식으로 이슈에 적어 둔다.

---

## 기술 스택

| 항목 | 선택 | 이유 |
|------|------|------|
| Runtime | Node.js 20 + TypeScript 5 | MCP SDK Node 기반, 생태계 성숙 |
| Web | Express 4 | 단순, 검증됨 (대시보드 HTML도 Express가 서빙) |
| Frontend | 정적 HTML (빌드 단계 없음) | MVP는 단일 페이지, 프레임워크 불필요 |
| MCP | @modelcontextprotocol/sdk 1.x | 공식 SDK (2차에서 활성화) |
| MCP Transport | Streamable HTTP (stateless) | 서버 기반, 원격 AI 클라이언트 연결 |
| LLM | @anthropic-ai/sdk (claude-haiku-4-5-20251001) | 비용 효율, 빠른 분석 |
| DB | better-sqlite3 | 단일 파일, 설치 없음 |
| Validation | zod 3 | TypeScript 친화적 |
| GitHub | @octokit/rest | 공식 SDK |
| Queue | p-queue | 비동기 이벤트 처리 |

---

## 환경 변수 (.env.example 참조)

```
PORT=3000                          # Webhook + health + 대시보드 + MCP (단일 포트 통합)
GITHUB_TOKEN=ghp_...               # GitHub PAT (repo 읽기 권한)
GITHUB_WEBHOOK_SECRET=...          # Webhook HMAC 시크릿
ANTHROPIC_API_KEY=sk-ant-...       # Claude API 키
DATABASE_PATH=./data/nextya.db     # SQLite 파일 경로
DEFAULT_REPO=connev-llm/claude-autoflow   # 기본 분석/추천 대상 레포
LOG_LEVEL=info                     # debug | info | warn | error
ANALYSIS_MODEL=claude-haiku-4-5-20251001
CONFIDENCE_THRESHOLD=0.6           # LLM edge에만 적용 (explicit은 항상 신뢰)
```

---

## 디렉터리 구조

```
src/
├── index.ts              # 진입점: Express(webhook + 대시보드 + MCP) 동시 기동
├── webhook/
│   ├── receiver.ts       # POST /webhook 핸들러, 이벤트 라우팅
│   └── verify.ts         # HMAC-SHA256 서명 검증 미들웨어
├── analyzer/
│   ├── index.ts          # LLM 분석 진입점 (보강용)
│   ├── explicit.ts       # ★신규 명시 신호 파서 (키워드/task list/라벨/sub-issue)
│   ├── pipeline.ts       # 조회 → (explicit + LLM 병합) → 저장 오케스트레이션
│   ├── prompt.ts         # LLM 프롬프트 빌더
│   └── types.ts          # 핵심 타입 정의 (여기서 시작)
├── score/
│   └── impact.ts         # ★신규 직접 unblock 수 계산 + '다음 작업' 추천
├── store/
│   ├── index.ts          # SQLite CRUD (이슈, 의존성, 로그)
│   └── schema.ts         # 스키마 초기화 (CREATE TABLE IF NOT EXISTS)
├── web/                  # ★신규 대시보드 라우트 + HTML (얇은 뷰)
├── mcp/                  # 동결 보존 (2차에서 활성화)
│   ├── server.ts         # MCP 서버 설정, tool 등록
│   └── tools.ts          # 5개 MCP 툴 구현
└── queue/
    └── index.ts          # p-queue 기반 이벤트 처리 큐 + withRetry
```
★ = MVP에서 신규 추가 대상.

---

## DB 스키마

`dependencies.source` 는 `'explicit' | 'llm' | 'manual'` 세 출처를 가진다
(명시 신호는 `'explicit'`, confidence=1.0). 나머지는 기존과 동일.

```sql
CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open',
  labels TEXT DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT,
  closed_at TEXT,
  last_analyzed_at TEXT,
  UNIQUE(repo, number)
);

CREATE TABLE IF NOT EXISTS dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  depends_on_number INTEGER NOT NULL,
  confidence REAL DEFAULT 1.0,
  reason TEXT DEFAULT '',
  source TEXT DEFAULT 'llm',        -- 'explicit' | 'llm' | 'manual'
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo, issue_number, depends_on_number)
);

CREATE TABLE IF NOT EXISTS analysis_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  trigger TEXT NOT NULL,
  issue_number INTEGER,
  status TEXT NOT NULL,
  deps_found INTEGER DEFAULT 0,
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

임팩트 점수는 **저장하지 않고 조회 시 계산**(파생값)한다.

---

## 핵심 로직 정의

- **ready**: 열린 선행 의존성이 하나도 없는 오픈 이슈.
- **직접 unblock 수**: 이 이슈를 `depends_on`으로 가진 **열린** 이슈의 수
  (= 닫으면 곧바로 ready가 될 수 있는 이슈 수).
- **추천**: ready 중 직접 unblock 수 최대인 1개. tie-break = 이슈 번호 오름차순.
- **하이브리드 병합**: explicit edge 먼저 → LLM은 미커버 관계만 보강 → 충돌 시 explicit 우선.
- **콜드스타트 갭**: webhook 경로가 캐시만 컨텍스트로 쓰면 빈 DB에서 의존성 0건이 된다.
  분석 시 `analyzeRepo`로 레포 오픈 이슈 전체를 동기화해 갭을 닫는다.

---

## 코딩 컨벤션

1. **에러 처리**: 절대 swallow 금지. 항상 로그 + 적절한 재throw
2. **LLM 응답**: zod로 파싱. 실패 시 재시도 1회. 그 후 null 반환 + 로그
3. **SQLite**: 반드시 prepared statement 사용
4. **비동기**: async/await. Promise.then 사용 금지
5. **타입**: any 사용 금지. unknown → zod 파싱
6. **파일 길이**: 파일당 250줄 이하 유지
7. **주석**: 공개 함수에 JSDoc 필수 (한국어 OK)
8. **테스트**: node:test + tsx (`npm test`). 네트워크/LLM은 주입 seam으로 대체

---

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| POST | /webhook | GitHub Webhook 수신 |
| GET | /health | 헬스 체크 |
| GET | / 또는 /dashboard | ★ 웹 대시보드 (사람용) |
| GET | /api/repos/:owner/:repo/dashboard | ★ 추천+ready+blocked 통합 JSON |
| GET | /api/repos/:owner/:repo/issues | 분석된 이슈 목록 (디버그) |
| GET | /api/repos/:owner/:repo/deps | 의존성 그래프 (디버그) |
| POST | /mcp | MCP POST (GET·DELETE 405) — 2차 활성화 |

---

## MCP 툴 스펙 (동결 — 2차)

구현 완료 상태로 보존한다. MVP에서는 손대지 않는다.
`get_ready_issues`, `get_execution_order`, `get_issue_context`,
`get_blocked_issues`, `trigger_analysis` (입출력 스펙은 git 이력/`src/mcp/tools.ts` 참조).

---

## 개발 시작

```bash
npm install
cp .env.example .env
# .env 편집 후:
npm run dev      # tsx watch
npm test         # node:test + tsx
npm run typecheck
```

## 배포 (connev.io 서버)

기존 ontology-platform 의 Traefik(`ontology-traefik`)을 재사용한다. 상세는 `DEPLOY.md`.
CI/CD는 GitHub Actions (`.github/workflows/`), main 머지 시 SSH 자동 배포.

- 대시보드/Webhook/MCP: `https://nextya.connev.io/` · `/webhook` · `/mcp`
- Health: `https://nextya.connev.io/health`

---

## 이슈 구조

### 완료 (스프린트 1: 수직 슬라이스)
| 이슈 | 제목 | 상태 |
|------|------|------|
| #1~#5 | SQLite / Webhook / LLM Analyzer / MCP / Docker | ✅ 완료 |
| #12, #14 | CI/CD (Jenkins → GitHub Actions) | ✅ 완료 |
| #10 | MCP OAuth 인증 (Keycloak) | ⏸ 2차 후속 |

### MVP: 사람 우선 의존성 대시보드 (마일스톤)
세션 1개 = 이슈 1개. `Depends on` 순서대로 진행.

| 이슈 | 제목 | 의존 |
|------|------|------|
| #17 [S9]  | 명시 의존 파서: 본문 키워드 (+ source='explicit') | 없음 |
| #18 [S10] | 명시 의존 파서: task list + 라벨 관계 | #17 |
| #19 [S11] | GitHub native sub-issues / tracked-by 연동 | #17 |
| #20 [S12] | explicit↔LLM 병합 + 콜드스타트 전체 동기화 | #17, #18, #19 |
| #21 [S13] | 임팩트 점수 + '다음 작업' 추천 (직접 unblock 수) | #20 |
| #22 [S14] | 대시보드 데이터 API (추천/ready/blocked 통합) | #21 |
| #23 [S15] | 웹 대시보드 HTML 뷰 | #22 |
| #24 [S16] | dogfooding: claude-autoflow 실데이터 검증 + 튜닝 | #23 |

병렬 가능: #18, #19 (둘 다 #17 완료 후, 서로 독립).
