import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { verifyWebhookSignature } from './verify.js';

interface MockRes {
  statusCode?: number;
  payload?: unknown;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.payload = body;
      return res;
    },
  };
  return res;
}

function mockReq(opts: { sig?: string; rawBody?: Buffer }): Request {
  const headers: Record<string, string> = {};
  if (opts.sig !== undefined) headers['x-hub-signature-256'] = opts.sig;
  return { headers, rawBody: opts.rawBody } as unknown as Request;
}

function sign(secret: string, body: Buffer): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** 미들웨어를 실행하고 next() 호출 여부를 반환한다. */
function run(req: Request, res: MockRes): boolean {
  let nextCalled = false;
  verifyWebhookSignature(req, res as unknown as Response, () => {
    nextCalled = true;
  });
  return nextCalled;
}

const SECRET = 'topsecret';
const BODY = Buffer.from(JSON.stringify({ zen: 'hi', hook_id: 1 }));

test('verify: 유효한 서명은 next()로 통과시킨다', () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const res = mockRes();
  const passed = run(mockReq({ sig: sign(SECRET, BODY), rawBody: BODY }), res);
  assert.equal(passed, true);
  assert.equal(res.statusCode, undefined);
});

test('verify: 잘못된 시크릿으로 만든 서명은 401', () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const res = mockRes();
  const passed = run(mockReq({ sig: sign('wrong-secret', BODY), rawBody: BODY }), res);
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
});

test('verify: 길이가 다른 서명도 throw 없이 401로 거부한다', () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const res = mockRes();
  const passed = run(mockReq({ sig: 'sha256=deadbeef', rawBody: BODY }), res);
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
});

test('verify: 서명 헤더가 없으면 401', () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const res = mockRes();
  const passed = run(mockReq({ rawBody: BODY }), res);
  assert.equal(passed, false);
  assert.equal(res.statusCode, 401);
});

test('verify: rawBody가 보존되지 않았으면 400', () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  const res = mockRes();
  const passed = run(mockReq({ sig: sign(SECRET, BODY) }), res);
  assert.equal(passed, false);
  assert.equal(res.statusCode, 400);
});

test('verify: 서버에 시크릿이 설정되지 않으면 500', () => {
  delete process.env.GITHUB_WEBHOOK_SECRET;
  const res = mockRes();
  const passed = run(mockReq({ sig: 'sha256=x', rawBody: BODY }), res);
  assert.equal(passed, false);
  assert.equal(res.statusCode, 500);
});
