#!/usr/bin/env bash
# epic-dash fetch script
# gh CLI로 이슈/PR 데이터를 수집해서 .autoflow/issue-analysis/ 에 저장한다.
#
# 사용법: ./scripts/fetch.sh [--repo owner/repo] [--incremental]
#
# 의존: gh CLI (gh auth login 완료 상태)

set -euo pipefail

# ── 인자 파싱 ──────────────────────────────────────────────────────────────
REPO_FLAG=""
INCREMENTAL=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --repo)    REPO_FLAG="--repo $2"; shift 2 ;;
    --incremental) INCREMENTAL=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ── 사전 조건 ──────────────────────────────────────────────────────────────
if ! gh auth status &>/dev/null; then
  echo "❌ gh 인증 필요: gh auth login 을 실행하세요." >&2
  exit 1
fi

REPO=$(gh repo view $REPO_FLAG --json nameWithOwner -q '.nameWithOwner' 2>/dev/null || true)
if [[ -z "$REPO" ]]; then
  echo "❌ GitHub 레포를 인식할 수 없습니다. --repo owner/repo 를 지정하세요." >&2
  exit 1
fi

echo "📦 레포: $REPO"

# ── 출력 디렉터리 ──────────────────────────────────────────────────────────
OUT=".autoflow/issue-analysis"
mkdir -p "$OUT"

# ── 오픈 이슈 수집 ─────────────────────────────────────────────────────────
echo "📥 오픈 이슈 수집 중..."
gh issue list $REPO_FLAG \
  --state open \
  --limit 300 \
  --json number,title,body,labels,assignees,createdAt,updatedAt \
  > "$OUT/issues_open.json"

OPEN_COUNT=$(jq length "$OUT/issues_open.json")
echo "   → ${OPEN_COUNT}개 오픈 이슈"

# ── 최근 완료 이슈 (60일) ──────────────────────────────────────────────────
echo "📥 최근 완료 이슈 수집 중..."
gh issue list $REPO_FLAG \
  --state closed \
  --limit 150 \
  --json number,title,labels,closedAt,stateReason \
  > "$OUT/issues_closed.json"

CLOSED_COUNT=$(jq length "$OUT/issues_closed.json")
echo "   → ${CLOSED_COUNT}개 완료 이슈"

# ── 오픈 PR ────────────────────────────────────────────────────────────────
echo "📥 오픈 PR 수집 중..."
gh pr list $REPO_FLAG \
  --state open \
  --json number,title,body,labels,isDraft,headRefName,baseRefName \
  > "$OUT/prs_open.json"

PR_COUNT=$(jq length "$OUT/prs_open.json")
echo "   → ${PR_COUNT}개 오픈 PR"

# ── 메타 정보 저장 ─────────────────────────────────────────────────────────
FETCHED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
cat > "$OUT/meta.json" <<EOF
{
  "repo": "$REPO",
  "fetched_at": "$FETCHED_AT",
  "open_issues": $OPEN_COUNT,
  "closed_issues": $CLOSED_COUNT,
  "open_prs": $PR_COUNT,
  "incremental": $INCREMENTAL
}
EOF

echo "$FETCHED_AT" > "$OUT/last-updated.txt"

echo ""
echo "✅ 수집 완료 → $OUT/"
echo "   다음 단계: Claude Code가 의존성 분석 후 HTML 빌드"
