# CLAUDE.md

> Claude Code가 이 파일을 읽고 컨텍스트 없이도 바로 개발을 시작할 수 있어야 한다.
> 모든 아키텍처 결정, 컨벤션, 스펙이 여기에 있다.

## 프로젝트: nextya

**"야, 다음은 뭐야?"** — GitHub 이슈가 AI(Auto-Flow 등)에 의해 자동 생성되는 시대에,
이슈 간 의존성을 LLM이 분석하고 AI 클라이언트에게 "지금 뭐부터 해야 하는지"를
MCP 프로토콜로 제공하는 서버.

### 핵심 흐름

```
GitHub Webhook (issues / pull_request 이벤트)
    ↓
POST /webhook  (HMAC-SHA256 서명 검증)
    ↓
EventQueue (비동기 처리, 재시도 보장)
    ↓
GitHub API로 레포 내 오픈 이슈 전체 조회
    ↓
LLM Analyzer → 이슈 본문에서 의존 관계 추출 (structured JSON output)
    ↓
SQLite 저장 (issues, dependencies, analysis_log)
    ↓
MCP Server (Streamable HTTP) → AI 클라이언트에 실행 순서 제공
```

---

## 기술 스택

| 항목 | 선택 | 이유 |
|------|------|------|
| Runtime | Node.js 20 + TypeScript 5 | MCP SDK Node 기반, 생태계 성숙 |
| Web | Express 4 | 단순, 검증됨 |
| MCP | @modelcontextprotocol/sdk 1.x | 공식 SDK |
| MCP Transport | Streamable HTTP | 서버 기반, 원격 AI 클라이언트 연결 |
| LLM | @anthropic-ai/sdk (claude-haiku-4-5-20251001) | 비용 효율, 빠른 분석 |
| DB | better-sqlite3 | 단일 파일, 설치 없음 |
| Validation | zod 3 | TypeScript 친화적 |
| GitHub | @octokit/rest | 공식 SDK |
| Queue | p-queue | 비동기 이벤트 처리 |

---

## 환경 변수 (.env.example 참조)

```
PORT=3000                          # Webhook + health check 포트
MCP_PORT=3001                      # MCP 서버 포트 (현재 단일 포트로 통합)
GITHUB_TOKEN=ghp_...               # GitHub PAT (repo 읽기 권한)
GITHUB_WEBHOOK_SECRET=...          # Webhook HMAC 시크릿
ANTHROPIC_API_KEY=sk-ant-...       # Claude API 키
DATABASE_PATH=./data/nextya.db     # SQLite 파일 경로
DEFAULT_REPO=owner/repo            # 기본 레포 (선택)
LOG_LEVEL=info                     # debug | info | warn | error
ANALYSIS_MODEL=claude-haiku-4-5-20251001
CONFIDENCE_THRESHOLD=0.6
```

---

## 디렉터리 구조

```
src/
├── index.ts              # 진입점: Express + MCP 서버 동시 기동
├── webhook/
│   ├── receiver.ts       # POST /webhook 핸들러, 이벤트 라우팅
│   └── verify.ts         # HMAC-SHA256 서명 검증 미들웨어
├── analyzer/
│   ├── index.ts          # 분석 진입점: 이슈 목록 → 의존성 추출
│   ├── pipeline.ts       # GitHub 조회 → 분석 → 저장 오케스트레이션
│   ├── prompt.ts         # LLM 프롬프트 빌더
│   └── types.ts          # 핵심 타입 정의 (여기서 시작)
├── store/
│   ├── index.ts          # SQLite CRUD (이슈, 의존성, 로그)
│   └── schema.ts         # 스키마 초기화 (CREATE TABLE IF NOT EXISTS)
├── mcp/
│   ├── server.ts         # MCP 서버 설정, tool 등록
│   └── tools.ts          # 5개 MCP 툴 구현
└── queue/
    └── index.ts          # p-queue 기반 이벤트 처리 큐
```

---

## MCP 툴 스펙 (구현 대상)

### 1. `get_ready_issues`
```typescript
// 지금 당장 시작 가능한 이슈 반환 (블로킹 없음 + state: open)
input: { repo?: string }
output: {
  issues: Array<{ number, title, labels, reason_ready }>
  count: number
}
```

### 2. `get_execution_order`
```typescript
// 위상 정렬 결과: 같은 step은 병렬 가능
input: { repo?: string }
output: {
  steps: Array<{
    step: number
    issues: Array<{ number, title }>
    parallel: boolean
  }>
  total_issues: number
  cycle_detected: boolean
}
```

### 3. `get_issue_context`
```typescript
input: { repo?: string, issue_number: number }
output: {
  issue: { number, title, body, state, labels }
  blocked_by: Array<{ number, title, state, reason }>
  blocks: Array<{ number, title, state, reason }>
  ready_to_start: boolean
  last_analyzed_at: string | null
}
```

### 4. `get_blocked_issues`
```typescript
input: { repo?: string }
output: {
  blocked: Array<{
    issue: { number, title }
    waiting_for: Array<{ number, title, state }>
    will_unblock_when: string
  }>
}
```

### 5. `trigger_analysis`
```typescript
input: { repo?: string, issue_number?: number }  // 없으면 전체
output: {
  analyzed: number
  deps_found: number
  duration_ms: number
}
```

---

## DB 스키마

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
  source TEXT DEFAULT 'llm',
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

---

## 코딩 컨벤션

1. **에러 처리**: 절대 swallow 금지. 항상 로그 + 적절한 재throw
2. **LLM 응답**: zod로 파싱. 실패 시 재시도 1회. 그 후 null 반환 + 로그
3. **SQLite**: 반드시 prepared statement 사용
4. **비동기**: async/await. Promise.then 사용 금지
5. **타입**: any 사용 금지. unknown → zod 파싱
6. **파일 길이**: 파일당 250줄 이하 유지
7. **주석**: 공개 함수에 JSDoc 필수 (한국어 OK)

---

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| POST | /webhook | GitHub Webhook 수신 |
| GET | /health | 헬스 체크 |
| GET | /mcp | MCP SSE 엔드포인트 |
| POST | /mcp | MCP POST 엔드포인트 |
| GET | /api/repos/:owner/:repo/issues | 분석된 이슈 목록 (디버그) |
| GET | /api/repos/:owner/:repo/deps | 의존성 그래프 (디버그) |

---

## 개발 시작

```bash
npm install
cp .env.example .env
# .env 편집 후:
npm run dev
```

## 배포 (connev.io 서버)

기존 ontology-platform 의 Traefik(`ontology-traefik`)을 재사용한다. 상세 절차는 `DEPLOY.md` 참조.

```bash
docker compose up -d --build
```

- Webhook: `https://nextya.connev.io/webhook`
- MCP: `https://nextya.connev.io/mcp`  (POST 전용 — GET·DELETE 는 405)
- Health: `https://nextya.connev.io/health`

Traefik 라우팅은 `docker-compose.yml` labels 참조. nextya 컨테이너는 외부 네트워크
`ontology-platform_ontology_prod` 에 join 한다. `/mcp` 인증(Keycloak OAuth)은 후속 이슈.

---

## 이슈 구조 (첫 스프린트)

| 이슈 | 제목 | 의존 |
|------|------|------|
| #1 | SQLite store — 스키마 + CRUD | 없음 |
| #2 | Webhook receiver — Express + HMAC | 없음 |
| #3 | LLM Analyzer — 의존성 추출 | #1, #2 |
| #4 | MCP Server — HTTP transport + 5 tools | #1, #3 |
| #5 | Docker 배포 설정 | #1, #2, #3, #4 |

#1, #2는 병렬 시작 가능. #3은 둘 다 완료 후. #4는 #3 완료 후. #5는 전부 완료 후.
