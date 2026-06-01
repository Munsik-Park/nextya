# epic-dash

`gh` CLI로 GitHub 이슈를 수집하고 LLM으로 의존성을 분석해서 HTML 대시보드를 생성하는 Claude Code 스킬.
레포 내 `.autoflow/issue-analysis/` 에 분석 결과를 저장하고 `epic_status.html` 을 생성/갱신한다.

## 사용법

```
/epic-dash                           # 현재 레포, 기본 경로
/epic-dash --output docs/dash.html   # 출력 경로 지정
/epic-dash --incremental             # 변경된 이슈만 재분석 (빠름)
/epic-dash --repo owner/repo         # 현재 디렉터리가 레포가 아닐 때
```

---

## Step 0: 사전 조건 확인

```bash
# gh 인증 확인
gh auth status

# 현재 레포 확인 (--repo 미지정 시)
gh repo view --json nameWithOwner -q '.nameWithOwner'
```

실패 시 사용자에게 `gh auth login` 실행을 안내하고 중단한다.

출력 디렉터리 생성:
```bash
mkdir -p .autoflow/issue-analysis
```

---

## Step 1: 이슈 & PR 데이터 수집

`scripts/fetch.sh` 를 실행하거나 아래 명령어를 직접 실행한다.

### 오픈 이슈 (body + labels 포함)
```bash
gh issue list \
  --state open \
  --limit 300 \
  --json number,title,body,labels,assignees,createdAt,updatedAt \
  > .autoflow/issue-analysis/issues_open.json
```

### 최근 완료 이슈 (60일, 상태 파악용)
```bash
gh issue list \
  --state closed \
  --limit 150 \
  --json number,title,labels,closedAt,stateReason \
  > .autoflow/issue-analysis/issues_closed.json
```

### 오픈 PR
```bash
gh pr list \
  --state open \
  --json number,title,body,labels,isDraft,headRefName,baseRefName \
  > .autoflow/issue-analysis/prs_open.json
```

### `--incremental` 모드
`.autoflow/issue-analysis/last-updated.txt` 의 타임스탬프를 읽어서
`updatedAt` 이 그 이후인 이슈만 재분석. 나머지는 기존 `deps.json` 값 유지.

---

## Step 2: 레이블 기반 Epic 구조 파악

`issues_open.json` 에서 다음 레이블 패턴을 분석한다:

| 패턴 | 의미 |
|------|------|
| `epic` | 이 이슈 자체가 Epic tracker (부모) |
| `epic-N` | 이슈 #N epic의 서브이슈 |
| `epic-N + epic` | mini-epic tracker (중간 계층) |
| `blocked-by-subrepo` | PR이 서브리포 머지 대기 (HANDOFF) |
| `priority:high` | 긴급, 즉시 처리 권장 |
| `bug` | 버그 수정 |
| `claude` | Auto-Flow 자동화 대상 |

Epic 그룹 맵 생성:
```json
{
  "epics": {
    "72": { "tracker": 72, "sub_issues": [210, 211, 212] },
    "73": { "tracker": 73, "sub_issues": [225, 226, 228] }
  },
  "unepiced": [62, 65, 66, 70, 76]
}
```

---

## Step 3: 의존성 추출 (LLM 분석)

각 이슈의 `body` 와 코멘트에서 의존성 신호를 추출한다.

### 명시적 패턴 (confidence 1.0)
- `Blocks #N`, `Closes #N`, `Fixes #N`
- `Blocked by #N`, `Part of #N`
- `Depends on #N`

### 한국어 패턴 (confidence 0.9)
- `#N 완료 후`, `#N 머지 후`, `#N 기반`
- `S0 완료 후`, `Wave 1 완료 후`, `파동 1`
- `선행 의존: #N`, `의존: #N`

### 슬라이스 계층 패턴 (confidence 0.8)
- 같은 epic 내 S0→S1f, S0b→S5a 같은 번호 참조
- `모든 frontend 슬라이스가 S0에 hard depends_on` 류의 서술

### 암시적 패턴 (confidence 0.7)
- `requires`, `prerequisite`, `전제`, `선행`
- 공통 스키마/인터페이스를 먼저 정의해야 하는 관계

confidence 0.6 미만은 저장하지 않는다.

결과를 `.autoflow/issue-analysis/deps.json` 으로 저장:

```json
{
  "analyzed_at": "2026-05-31T12:00:00Z",
  "repo": "owner/repo",
  "edges": [
    {
      "from": 227,
      "to": 225,
      "confidence": 1.0,
      "reason": "S5a는 S0 탭 셸 완료 후 착수"
    }
  ],
  "issue_states": {
    "225": "open",
    "226": "open"
  }
}
```

**엣지 방향:** `from` 이슈가 `to` 이슈에 의존한다. `to` 가 먼저 완료되어야 `from` 을 시작할 수 있다.

---

## Step 4: 위상 정렬 (Wave 계산)

Kahn's algorithm으로 위상 정렬한다.

1. 각 오픈 이슈의 in-degree 계산 (의존하는 오픈 이슈 수)
2. in-degree = 0 인 이슈 → Wave 1 (즉시 착수 가능)
3. Wave 1 제거 후 in-degree = 0 이 된 이슈 → Wave 2
4. 반복

순환 의존성 감지 시: `cycle_detected: true` + 사용자 경고.

결과를 `.autoflow/issue-analysis/execution-order.json` 으로 저장:

```json
{
  "waves": [
    { "wave": 1, "issues": [210, 211, 212, 225, 226], "parallel": true },
    { "wave": 2, "issues": [216, 227, 229], "parallel": true }
  ],
  "cycle_detected": false
}
```

---

## Step 5: 이슈 상태 판별

| 조건 | 상태 | CSS 클래스 |
|------|------|------------|
| `state = closed` | 완료 | `done` |
| `state = open` + `blocked-by-subrepo` 라벨 | 리뷰 대기 | `review` |
| `state = open` + 연결 PR + `isDraft = true` | 리뷰 대기 | `review` |
| `state = open` + in-degree = 0 | 즉시 시작 | `ready` |
| `state = open` + in-degree > 0 | 대기 | `todo` |

Epic 완료 판별: 모든 `epic-N` 라벨 이슈가 `closed` 이면 해당 epic 완료.

---

## Step 6: HTML 대시보드 생성

### 색상 (다크 테마)

```css
배경:      #0d1117
카드:      #161b22
테두리:    #30363d

즉시 시작: stroke #1f6feb,  fill #0d2a4a,  text #58a6ff
대기 중:   stroke #30363d,  fill #21262d,  text #7d8590
완료:      stroke #238636,  fill #1a4429,  text #3fb950
긴급/버그: stroke #f85149,  fill #2d0000,  text #ff7b72
리뷰 대기: stroke #bd561d,  fill #2d1f00,  text #f0883e
분리됨:    stroke #9e6a03,  fill #2d1f00,  text #d29922
```

### 페이지 구조

```
<header>    레포명 · 갱신 일시
<overall>   전체 Epic 진행률 바
<legend>    색상 범례
<section>   ✅ 완료된 Epic  (collapsed 카드, chips만 표시)
<section>   🔧 진행 중인 Epic (Wave 구조로 이슈 나열)
<section>   🔗 의존성 그래프 (Epic당 SVG, viewBox="0 0 960 N")
<section>   🚀 개발자 배분 권장 (Wave 1 이슈 3개 추천)
<footer>    갱신 요약
```

### Epic 카드 HTML 구조

```html
<div class="epic-card">
  <div class="epic-header">
    <span class="epic-icon">{아이콘}</span>
    <span class="epic-title">epic-N · {제목}</span>
    <span class="epic-badge open-badge">{완료}/{전체} 완료</span>
  </div>
  <div class="issue-list">
    <div class="divider">
      <span class="divider-label">⚡ Wave 1 — 즉시 시작 가능</span>
    </div>
    <div class="issue-row">
      <span class="status-dot ready"></span>
      <span class="issue-num">#{번호}</span>
      <span class="issue-name">{제목}</span>
      <span class="tag ready">시작 가능</span>
    </div>
    <!-- Wave 2 이후도 동일 패턴 -->
  </div>
  <div class="progress-bar-wrap">
    <div class="progress-bar">
      <div class="progress-fill" style="width:{%}%"></div>
    </div>
    <span class="progress-label">{완료}/{전체} 완료</span>
  </div>
</div>
```

### 의존성 그래프 SVG 생성 규칙

- `viewBox="0 0 960 {wave수 × 110 + 80}"`
- Wave별 가로 행: 이슈 박스를 균등 분할 배치
- 박스 크기: width ≈ 960 / 이슈수 - 10, height = 72
- S0 같은 foundation 이슈: 빨간 테두리 강조
- 화살표: `stroke-dasharray="4,2"` 회색 점선
- 범례 행을 SVG 하단에 추가

### 개발자 배분 권장 생성 규칙

1. Wave 1 이슈를 `priority:high` → `bug` → 일반 순으로 정렬
2. 같은 Epic 이슈를 같은 개발자에게 우선 배정
3. 최대 3명 기준으로 추천

---

## Step 7: 저장 및 사용자 출력

```bash
# 타임스탬프 갱신
date -u +"%Y-%m-%dT%H:%M:%SZ" > .autoflow/issue-analysis/last-updated.txt
```

사용자 출력 형식:
```
✅ epic-dash 분석 완료
   이슈: {N}개  ·  의존성 엣지: {M}개  ·  소요: {T}초

⚡ 즉시 착수 가능 (Wave 1):
   #{번호} {슬라이스} · {제목} ({epic명})
   ...

📊 대시보드: .autoflow/epic_status.html
📁 분석 데이터: .autoflow/issue-analysis/
```

---

## 주의사항

- `gh` 인증 실패 시 즉시 중단하고 `gh auth login` 안내
- 이슈 300개 초과 레포는 `--limit` 증가 권장
- `deps.json` 의 `analyzed_at` 을 HTML 헤더에 노출해 오래된 분석임을 알 수 있게 한다
- 의존성은 LLM 추론이므로 `confidence` 와 `reason` 을 HTML 툴팁/주석에 포함한다
- 순환 의존성 감지 시 HTML에 ⚠️ 경고 배지 표시
