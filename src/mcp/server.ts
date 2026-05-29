import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express } from 'express';
import { mcpTools } from './tools.js';

/**
 * MCP 서버를 초기화하고 Express 앱에 /mcp 엔드포인트를 등록한다.
 */
export function setupMcpServer(app: Express): McpServer {
  const server = new McpServer({ name: 'nextya', version: '0.1.0' });

  for (const tool of mcpTools) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema.shape,
      async (args: Record<string, unknown>) => ({
        content: [{
          type: 'text' as const,
          text: JSON.stringify(await (tool.handler as (a: typeof args) => unknown)(args), null, 2),
        }],
      })
    );
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  app.post('/mcp', async (req, res) => {
    await transport.handleRequest(req, res, req.body as Record<string, unknown>);
  });
  app.get('/mcp', async (req, res) => {
    await transport.handleRequest(req, res);
  });

  server.connect(transport);
  console.info('[mcp] server ready at /mcp');
  return server;
}
