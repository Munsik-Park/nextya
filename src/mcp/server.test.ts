import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

process.env.DATABASE_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.DEFAULT_REPO = '';

const { setupMcpServer } = await import('./server.js');
const { upsertIssue } = await import('../store/index.js');

/** Express+MCP 서버를 임의 포트로 띄우고 base URL과 종료 함수를 반환한다. */
async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  setupMcpServer(app);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── AC #2: POST /mcp — JSON-RPC 요청 처리 (initialize + tools/list + tools/call) ─

test('POST /mcp: MCP 클라이언트로 연결해 5개 툴 목록과 호출이 동작한다', async () => {
  const repo = 'o/srv';
  upsertIssue(repo, {
    number: 1,
    title: 'first',
    body: '',
    state: 'open',
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null,
  });

  const { url, close } = await startServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));

    const { tools } = await client.listTools();
    assert.equal(tools.length, 5, '5개 툴이 등록되어야 함');
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'get_blocked_issues',
      'get_execution_order',
      'get_issue_context',
      'get_ready_issues',
      'trigger_analysis',
    ]);

    const res = await client.callTool({ name: 'get_ready_issues', arguments: { repo } });
    const content = res.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0]!.text) as { count: number };
    assert.equal(parsed.count, 1, 'blocker 없는 #1이 ready로 반환되어야 함');
  } finally {
    await client.close();
    await close();
  }
});

// ── AC #1: GET /mcp — stateless라 405 + JSON-RPC 에러 ─────────────────────────

test('GET /mcp: stateless 모드라 405와 JSON-RPC 에러를 반환한다', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(url, { method: 'GET' });
    assert.equal(res.status, 405);
    const body = (await res.json()) as { error?: { message: string } };
    assert.match(body.error?.message ?? '', /not allowed/i);
  } finally {
    await close();
  }
});
