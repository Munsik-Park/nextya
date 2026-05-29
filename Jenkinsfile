// nextya CI/CD 파이프라인 (#12)
//
// - CI: PR/브랜치마다 typecheck + build + test. Jenkins 컨테이너에 Node 가 없고
//   docker-outside-of-docker 라 workspace 마운트 대신 Dockerfile 의 `test` 스테이지를
//   `docker build --target test` 로 빌드해 검증한다 (빌드 컨텍스트가 전송되므로 경로 문제 없음).
// - CD: main 머지 시 `docker compose up -d --build` 로 서버 재배포 + 헬스 체크.
// - commit status: 공유 라이브러리(ontology-pipeline)는 owner 가 connev-ontology 로
//   하드코딩돼 있어 쓸 수 없으므로 자체 구현한다 (GitHub Statuses API, owner=Munsik-Park).

def setCommitStatus(String state, String description) {
  // PR 빌드에서만 head commit 에 status 를 단다. credential 부재/실패는 비치명적.
  if (!env.CHANGE_ID) { return }
  withCredentials([string(credentialsId: 'nextya-github-token', variable: 'GH_TOKEN')]) {
    withEnv([
      "CS_STATE=${state}", "CS_DESC=${description}",
      "CS_URL=${env.BUILD_URL ?: ''}", "CS_PR=${env.CHANGE_ID}"
    ]) {
      sh '''#!/usr/bin/env python3
import json, os, sys, urllib.request, urllib.error
tok = os.environ["GH_TOKEN"]
pr  = os.environ["CS_PR"]
owner, repo = "Munsik-Park", "nextya"

def req(path, data=None, method="GET"):
    r = urllib.request.Request("https://api.github.com/repos/%s/%s%s" % (owner, repo, path),
                               data=data, method=method)
    r.add_header("Authorization", "token " + tok)
    r.add_header("Accept", "application/vnd.github+json")
    if data:
        r.add_header("Content-Type", "application/json")
    return r

# merge commit 이 아닌 PR head SHA 에 status 를 단다 (PR Checks 탭에 표시되도록).
try:
    sha = json.loads(urllib.request.urlopen(req("/pulls/" + pr)).read())["head"]["sha"]
except Exception as e:
    print("WARN: head SHA lookup failed: %s" % e, file=sys.stderr)
    sys.exit(0)

payload = json.dumps({
    "state": os.environ["CS_STATE"],
    "description": os.environ["CS_DESC"],
    "context": "jenkins/ci",
    "target_url": os.environ["CS_URL"],
}).encode()
try:
    urllib.request.urlopen(req("/statuses/" + sha, data=payload, method="POST"))
    print("commit status %s -> %s" % (os.environ["CS_STATE"], sha[:8]))
except urllib.error.HTTPError as e:
    print("WARN: set status failed (HTTP %s)" % e.code, file=sys.stderr)
'''
    }
  }
}

pipeline {
  agent any
  options {
    timeout(time: 15, unit: 'MINUTES')
    timestamps()
    buildDiscarder(logRotator(numToKeepStr: '10'))
    disableConcurrentBuilds()
  }

  stages {
    stage('Pending status') {
      when { expression { env.CHANGE_ID } }
      steps { script { setCommitStatus('pending', 'CI 실행 중...') } }
    }

    stage('CI: typecheck + build + test') {
      steps {
        // Dockerfile test 스테이지: npm ci → build → typecheck → test. 실패 시 빌드 실패.
        sh 'docker build --target test -t nextya-ci:${BUILD_NUMBER} .'
      }
      post {
        always { sh 'docker image rm -f nextya-ci:${BUILD_NUMBER} || true' }
      }
    }

    stage('Deploy (main)') {
      // main 브랜치 빌드에서만 배포 (PR 빌드 제외).
      when {
        allOf {
          branch 'main'
          not { expression { env.CHANGE_ID } }
        }
      }
      steps {
        withCredentials([
          string(credentialsId: 'nextya-github-token',  variable: 'NX_GH_TOKEN'),
          string(credentialsId: 'nextya-webhook-secret', variable: 'NX_WH_SECRET'),
          string(credentialsId: 'nextya-anthropic-key',  variable: 'NX_ANTHROPIC'),
        ]) {
          sh '''
            set -e
            # 시크릿을 .env 로 주입 (compose env_file). 이미지가 아닌 런타임 주입이라 평문이 이미지에 남지 않는다.
            umask 077
            cat > .env <<EOF
GITHUB_TOKEN=${NX_GH_TOKEN}
GITHUB_WEBHOOK_SECRET=${NX_WH_SECRET}
ANTHROPIC_API_KEY=${NX_ANTHROPIC}
DEFAULT_REPO=connev-llm/claude-autoflow
LOG_LEVEL=info
EOF
            # 워크스페이스가 detached 라도 동일 프로젝트로 배포되도록 프로젝트명 고정.
            export COMPOSE_PROJECT_NAME=nextya
            docker compose up -d --build
            rm -f .env

            # 헬스 체크 (최대 ~60s 대기)
            for i in $(seq 1 30); do
              if docker exec nextya wget -qO- http://localhost:3000/health >/dev/null 2>&1; then
                echo "health OK"; exit 0
              fi
              sleep 2
            done
            echo "health check FAILED"; docker logs --tail 50 nextya || true; exit 1
          '''
        }
      }
    }
  }

  post {
    success { script { setCommitStatus('success', '모든 검사 통과') } }
    failure { script { setCommitStatus('failure', 'CI 실패') } }
    always  { cleanWs() }
  }
}
