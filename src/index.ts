import 'dotenv/config';
import express from 'express';
import { verifyWebhookSignature } from './webhook/verify.js';
import { webhookHandler } from './webhook/receiver.js';
import { setupMcpServer } from './mcp/server.js';
import { getDb } from './store/index.js';
import { getOpenIssues, getAllDependencies } from './store/index.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main() {
  // DB 초기화 (스키마 생성)
  getDb();

  const app = express();

  // raw body 보존 (HMAC 검증에 필요)
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );

  // ── Routes ────────────────────────────────────────────────────

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '0.1.0', ts: new Date().toISOString() });
  });

  app.post('/webhook', verifyWebhookSignature, webhookHandler);

  // 디버그 API
  app.get('/api/repos/:owner/:repo/issues', (req, res) => {
    const repo = `${req.params['owner']}/${req.params['repo']}`;
    res.json(getOpenIssues(repo));
  });

  app.get('/api/repos/:owner/:repo/deps', (req, res) => {
    const repo = `${req.params['owner']}/${req.params['repo']}`;
    res.json(getAllDependencies(repo));
  });

  // MCP 서버 설정
  setupMcpServer(app);

  app.listen(PORT, () => {
    console.info(`[nextya] 🚀 port ${PORT}`);
    console.info(`[nextya] webhook → POST /webhook`);
    console.info(`[nextya] mcp     → /mcp`);
    console.info(`[nextya] health  → GET /health`);
  });
}

main().catch((err) => {
  console.error('[nextya] fatal:', err);
  process.exit(1);
});
