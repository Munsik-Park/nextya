# nextya 초기 컨셉 (Concept v0)

> 2026-05-31 논의 확정본. 이 문서는 "무엇을 만들 것인가(목표 기능)"와 "어떻게 만들 것인가(빌드 방법)"의
> 합의를 기록한다. 구현 스펙·컨벤션은 [CLAUDE.md](../CLAUDE.md), 현행 아키텍처는
> [architecture.md](./architecture.md) 참조.

## 1. 한 줄 정의

사람(PM·개발자)이 **"지금 뭐부터?"를 1초 만에** 알 수 있게, GitHub 이슈 의존성을 분석해
**'다음 작업' 1개를 콕 집어 추천**하는 대시보드. (AI 에이전트의 자동 착수는 2차 목표.)

## 2. 타깃 & 핵심 시나리오 (JTBD)

- **1차 사용자: 사람** (PM, 개발자). dogfooding 대상은 `connev-llm/claude-autoflow`.
- **2차 사용자: AI 에이전트** — 같은 데이터를 MCP로 소비해 자동 착수. (MVP 이후)
- 설계 원칙: **사람 먼저, 그러나 항상 사람+AI 둘 다 고려.** 뷰는 얇게, 판단 로직은
  `store`/`analyzer`에 둬서 나중에 MCP가 동일 로직을 그대로 소비할 수 있게 한다.

> **핵심 시나리오**: "오픈 이슈가 수십 개인데, 뭐부터 손대야 가장 많이 풀리지?"
> → nextya 대시보드 접속 → 🎯 추천 이슈 1개 + 근거("이걸 닫으면 N개가 풀림")
> + 전체 ready/blocked 현황을 한 화면에서 확인.

## 3. MVP 범위 (In / Out)

### In (MVP)
- **단일 레포** (`DEFAULT_REPO=connev-llm/claude-autoflow`)
- **하이브리드 의존성 추출**: 명시 신호(규칙) → LLM 보강
  - 명시 신호 출처: ① 본문 키워드 ② GitHub task list / sub-issues ③ 라벨 관계
- **임팩트 점수 = 직접 unblock 수**, 추천 **1개**
- **정적 웹 대시보드** (Express가 HTML 서빙)

### Out (2차/후속)
- AI/MCP 자동 착수 — 기존 `mcp/` 5-tool은 **동결 보존**(삭제 X, MVP에선 부차)
- 추가 점수 신호: 전이 unblock/critical path, 라벨 가중치, 정체도/나이
- 멀티 레포 / org 전체, 레포 간 의존
- 마일스톤 / GitHub Projects 순서 신호
- 인증(Keycloak OAuth) — 후속 이슈 #10

## 4. 핵심 개념 정의

### 4.1 "다음 이슈" 추천
- **ready** = 열린 선행 의존성이 하나도 없는 오픈 이슈.
- **추천** = ready 중 **직접 unblock 수가 최대**인 이슈 1개.
- tie-break = 이슈 번호 오름차순(오래된 것 우선) — 결정적·단순.

### 4.2 직접 unblock 수
이 이슈를 `depends_on`으로 가진 **열린** 이슈의 수.
(= 이 이슈를 닫으면 곧바로 ready가 될 수 있는 이슈 수.)

### 4.3 하이브리드 의존성 파이프라인
1. **명시 신호 파서**(규칙 기반): 본문 키워드 / task list·sub-issues / 라벨
   → edge `source='explicit'`, `confidence=1.0`
2. **LLM 보강**: 명시로 못 잡은 관계만 추출 → `source='llm'`, `confidence<1.0`
   (`CONFIDENCE_THRESHOLD` 필터)
3. **충돌 시 explicit 우선**.

명시 신호 키워드(초안): `depends on #N`, `blocked by #N`, `after #N`,
`선행`, `#N 완료 후`, `#N 머지 후`, `#N 기반`.

## 5. 시스템 구성 (기존 보존 + 신규)

### 보존 (변경 없음)
`webhook/` · `queue/` · `store/`(SQLite) · `mcp/`(동결) · `analyzer`의 LLM seam.

### 신규
| 모듈 | 역할 |
|------|------|
| `src/analyzer/explicit.ts` | 명시 신호 파서 (정규식 + task list + 라벨 → edges) |
| `src/analyzer/pipeline.ts` (확장) | explicit → LLM 병합 단계 추가 |
| `src/score/impact.ts` | 직접 unblock 수 계산 + 추천 1개 산출 (파생, 비저장) |
| `src/web/` | 대시보드 라우트 + HTML 템플릿 (얇은 뷰) |

### 데이터 모델 영향 (최소)
- `dependencies.source`: `'llm' | 'manual'` → **`'explicit'` 추가** (타입 확장만)
- 임팩트 점수는 **저장하지 않고 조회 시 계산** (파생값, 단순 유지)
- 스키마 DDL 변경 사실상 없음

### 콜드스타트 갭 해소 (필수)
현재 webhook 경로는 캐시만 컨텍스트로 써서, 빈 DB에 단일 이슈가 오면 의존성 0건이 된다.
→ **대시보드 첫 로드 시(또는 주기적으로) `analyzeRepo`로 레포 전체 동기화**해 갭을 닫는다.

## 6. 대시보드 화면 (v0)
- **헤더**: 레포명 · 마지막 분석 시각 · [재분석] 버튼
- **🎯 다음 작업**: 추천 이슈 1개 (번호·제목·근거 "N개 이슈를 풀어줌")
- **✅ 지금 가능 (ready)**: 목록
- **🚧 막힘 (blocked)**: 이슈 → 대기 중인 선행 이슈
- **🔗 의존 관계**: 텍스트/리스트 (그래프 시각화는 후속)

## 7. 단계별 구축 계획 (만드는 방법)
- **Phase 0** — 컨셉 확정 ✅ (이 문서)
- **Phase 1** — 하이브리드 의존성: `explicit.ts` 파서 + LLM 병합 + 콜드스타트 동기화
  *(데이터 정확도의 토대 → 가장 먼저)*
- **Phase 2** — 임팩트 점수 + 추천: 직접 unblock 수, 추천 1개 산출
- **Phase 3** — 웹 대시보드: HTML 뷰 (Phase 1·2 데이터 소비)
- **Phase 4** — dogfooding: claude-autoflow 실데이터로 추천 품질 검증
- **(2차)** MCP 활성화 + 에이전트 자동 착수, 추가 점수 신호 도입

## 8. 추후 결정 (미해결)
- 명시 신호 키워드 정확한 사전(한/영) 확정
- 재분석 트리거 정책: 주기 배치 vs webhook vs 대시보드 버튼
- 대시보드 인증 필요 여부 (현재 공개 URL)
- 추천 tie-break 정교화 (동점 다수 시)
