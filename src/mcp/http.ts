import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Row } from '../db.js';
import { logger } from '../log.js';
import type { Media } from '../media.js';
import { UserError, type Store } from '../store.js';
import { createMcpServer } from './tools.js';

const log = logger('mcp');
const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** 访问令牌：只存哈希，明文只在生成时出现一次。撤销只打标记。 */
export class Tokens {
  constructor(private store: Store) {}
  list(): Row[] { return this.store.db.all('SELECT id,name,created_at,last_used_at,revoked_at FROM api_tokens ORDER BY id DESC'); }
  create(name: string): { id: number; token: string } {
    const n = name.trim();
    if (!n || n.length > 50) throw new UserError('名称不能为空且不超过 50 字');
    const token = `wlm_${crypto.randomBytes(32).toString('base64url')}`;
    return { id: this.store.db.run('INSERT INTO api_tokens(name,hash,created_at) VALUES(?,?,?)', n, hash(token), Date.now()).id, token };
  }
  revoke(id: number): void { if (!this.store.db.run('UPDATE api_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL', Date.now(), id).changes) throw new UserError('令牌不存在或已撤销', 404); }
  verify(header: string | undefined): boolean {
    const t = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
    const r = t ? this.store.db.get('SELECT id,last_used_at FROM api_tokens WHERE hash=? AND revoked_at IS NULL', hash(t)) : undefined;
    if (!r) return false;
    if (Date.now() - (r.last_used_at ?? 0) > 60_000) this.store.db.run('UPDATE api_tokens SET last_used_at=? WHERE id=?', Date.now(), r.id);
    return true;
  }
}

/** MCP Streamable HTTP，无会话：每个请求独立，服务重启对客户端无感。 */
export function registerMcp(app: FastifyInstance, deps: { store: Store; media: Media; tokens: Tokens }): void {
  const rpcError = (message: string) => ({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
  const crossSite = (req: FastifyRequest) => {
    const o = req.headers.origin;
    if (!o) return false;
    try { return new URL(o).host !== req.host; } catch { return true; }
  };
  app.route({
    method: ['GET', 'POST', 'DELETE'], url: '/mcp', bodyLimit: 256 * 1024,
    onRequest: async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (crossSite(req)) return reply.code(403).send(rpcError('非法请求来源')); // 防 DNS 重绑定
      if (!deps.tokens.verify(req.headers.authorization)) return reply.code(401).header('WWW-Authenticate', 'Bearer').send(rpcError('访问令牌无效，请到网页「设置 → AI 助手」生成'));
      if (req.method !== 'POST') return reply.code(405).header('Allow', 'POST').send(rpcError('仅支持 POST'));
    },
    handler: async (req, reply) => {
      const server = createMcpServer(deps);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.raw.on('close', () => { void transport.close(); void server.close(); });
      reply.hijack();
      try {
        await server.connect(transport as any);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (e) {
        log.error('请求处理失败', e);
        if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: '服务器内部错误' }, id: null }));
      }
    },
  });
}
