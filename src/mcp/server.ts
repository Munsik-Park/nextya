import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express, Request, Response } from 'express';
import { mcpTools } from './tools.js';

/**
 * MCP 서버 인스턴스를 생성하고 5개 툴을 등록한다.
 * stateless 모드라 세션을 공유하지 않으므로 매 요청마다 새 인스턴스를 만든다.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'nextya', version: '0.1.0' });

  for (const tool of mcpTools) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema.shape,
      async (args: Record<string, unknown>) => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(await (tool.handler as (a: typeof args) => unknown)(args), null, 2),
          },
        ],
      })
    );
  }

  return server;
}

/** stateless 모드에서 미지원 메서드(GET·DELETE)에 반환할 JSON-RPC 에러 본문. */
const METHOD_NOT_ALLOWED = JSON.stringify({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed.' },
  id: null,
});

/**
 * Express 앱에 stateless Streamable HTTP MCP 엔드포인트(/mcp)를 등록한다.
 *
 * - POST: 요청마다 독립 server+transport를 만들어 JSON-RPC를 처리한다 (세션 추적 없음).
 *   nextya의 툴 호출은 서로 독립적이고 서버 측 세션 상태가 없으므로 stateless가 적합하다.
 * - GET·DELETE: stateless라 SSE 스트림/세션 종료가 의미 없으므로 405를 반환한다.
 *
 * enableJsonResponse=true로 POST 응답을 SSE 대신 순수 JSON-RPC로 돌려줘
 * 단발성 툴 호출에 맞춘다.
 */
export function setupMcpServer(app: Express): void {
  app.post('/mcp', async (req: Request, res: Response) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // 요청 종료 시 리소스 정리 (stateless라 요청 단위로 생성·해제).
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const reject = (_req: Request, res: Response): void => {
    res.writeHead(405, { 'Content-Type': 'application/json' }).end(METHOD_NOT_ALLOWED);
  };
  app.get('/mcp', reject);
  app.delete('/mcp', reject);

  console.info('[mcp] stateless server ready at /mcp');
}
