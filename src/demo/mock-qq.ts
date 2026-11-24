/** 按官方文档实现的模拟 QQ 开放平台：鉴权、网关、心跳、RESUME 补发、被动回复限制、附件。 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface Sent { openid: string; content: string; msg_id?: string; event_id?: string; msg_seq: number }

export class MockQQ {
  sent: Sent[] = [];
  log: string[] = [];
  files = new Map<string, { body: Buffer; type?: string; fail?: number }>();
  /** 接下来若干次发消息的失败方式 */
  sendFailures: { status: number; body: any }[] = [];
  heartbeat = 60_000;
  ackHeartbeat = true;
  rejectResume = false;
  tokenFails = false;
  validToken = 'tok-1';
  private http!: http.Server;
  private wss!: WebSocketServer;
  private ws: WebSocket | null = null;
  private session = '';
  private history: { s: number; t: string; d: any; id?: string }[] = [];
  private s = 0;
  private n = 0;
  private replies = new Map<string, Set<number>>();
  base = '';

  async start(): Promise<void> {
    this.http = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (c) => (buf += c));
      req.on('end', () => this.route(req, res, buf ? JSON.parse(buf) : {}));
    });
    this.wss = new WebSocketServer({ server: this.http, path: '/websocket' });
    this.wss.on('connection', (ws) => this.onSocket(ws));
    await new Promise<void>((r) => this.http.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> { for (const c of this.wss.clients) c.terminate(); this.wss.close(); this.http.closeAllConnections(); await new Promise((r) => this.http.close(r)); }

  private route(req: http.IncomingMessage, res: http.ServerResponse, body: any): void {
    const json = (status: number, b: any) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const url = req.url!;
    if (url.startsWith('/file/')) {
      const f = this.files.get(url);
      if (!f) { res.writeHead(404); return void res.end(); }
      if (f.fail && f.fail-- > 0) { res.writeHead(500); return void res.end(); }
      res.writeHead(200, { 'content-type': f.type ?? 'application/octet-stream' });
      return void res.end(f.body);
    }
    if (url === '/app/getAppAccessToken') return json(200, this.tokenFails || body.clientSecret !== 'sec' ? { code: 100016, message: 'invalid appid or secret' } : { access_token: this.validToken, expires_in: '7200' });
    if (req.headers.authorization !== `QQBot ${this.validToken}`) return json(401, { message: 'AccessToken无效或过期', code: 11244, err_code: 40011027 });
    if (url === '/gateway') return json(200, { url: this.base.replace('http', 'ws') + '/websocket' });
    if (url === '/users/@me') return json(200, { id: '1', username: '测试机器人' });
    const m = /^\/v2\/users\/([^/]+)\/messages$/.exec(url);
    if (m && req.method === 'POST') {
      const fail = this.sendFailures.shift();
      if (fail) return json(fail.status, fail.body);
      const key = body.msg_id ?? body.event_id;
      const used = this.replies.get(key) ?? new Set();
      if (used.has(body.msg_seq)) return json(400, { err_code: 40054005, message: '消息被去重' });
      if (used.size >= 4) return json(400, { err_code: 40034025, message: '被动回复次数超限' });
      if (/https?:\/\/|\b\w+\.(com|cn)\b/.test(body.content)) return json(400, { err_code: 40054010, message: '不允许发送 url' });
      used.add(body.msg_seq); this.replies.set(key, used);
      this.sent.push({ openid: m[1]!, ...body });
      return json(200, { id: `BOT${this.sent.length}`, timestamp: new Date().toISOString(), ext_info: { ref_idx: `REFIDX_bot${this.sent.length}` } });
    }
    json(404, { message: 'not found', err_code: 404 });
  }

  private onSocket(ws: WebSocket): void {
    this.log.push('connect');
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: this.heartbeat } }));
    ws.on('message', (raw) => {
      const p = JSON.parse(raw.toString());
      if (p.op === 1) { this.log.push('heartbeat'); if (this.ackHeartbeat) ws.send('{"op":11}'); return; }
      if (p.d?.token !== `QQBot ${this.validToken}`) return ws.close(4004);
      if (p.op === 2) {
        this.log.push(`identify:${p.d.intents}`);
        this.session = `sess-${++this.n}`; this.s = 1; this.history = []; this.ws = ws;
        ws.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { version: 1, session_id: this.session, user: { username: '测试机器人' }, shard: [0, 1] } }));
      } else if (p.op === 6) {
        this.log.push(`resume:${p.d.seq}`);
        if (this.rejectResume || p.d.session_id !== this.session) { this.rejectResume = false; return void ws.send('{"op":9,"d":false}'); }
        this.ws = ws;
        for (const e of this.history.filter((x) => x.s > p.d.seq)) ws.send(JSON.stringify({ op: 0, ...e }));
        ws.send(JSON.stringify({ op: 0, s: ++this.s, t: 'RESUMED', d: '' }));
      }
    });
    ws.on('close', () => { if (this.ws === ws) this.ws = null; });
  }

  get online(): boolean { return this.ws !== null; }
  emit(t: string, d: any, id = `evt-${this.s + 1}`): void {
    const e = { id, s: ++this.s, t, d };
    this.history.push(e);
    this.ws?.send(JSON.stringify({ op: 0, ...e }));
  }
  private msgNo = 0;
  /** 模拟用户发单聊消息，返回 { id, idx }。 */
  say(openid: string, content: string, extra: Record<string, any> = {}): { id: string; idx: string; event: any } {
    const no = ++this.msgNo, id = extra.id ?? `ROBOT1.0_${no}`, idx = `REFIDX_u${no}`;
    const { ref, at, ...rest } = extra;
    const event = { id, author: { id: openid, user_openid: openid, username: '测试用户', bot: false }, content, message_type: ref ? 103 : 0, timestamp: new Date(at ?? Date.now()).toISOString(), message_scene: { source: 'default', ext: [...(ref ? [`ref_msg_idx=${ref}`] : []), `msg_idx=${idx}`] }, ...rest };
    this.emit('C2C_MESSAGE_CREATE', event);
    return { id, idx, event };
  }
  closeSocket(code: number): void { this.ws?.close(code); this.ws = null; }
  send(op: object): void { this.ws?.send(JSON.stringify(op)); }
}
