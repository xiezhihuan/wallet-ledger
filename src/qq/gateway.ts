import WebSocket from 'ws';
import { logger } from '../log.js';

const log = logger('qq-gateway');

/** 单聊消息、加好友等事件 */
export const INTENT_GROUP_AND_C2C = 1 << 25;
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 } as const;
const BACKOFF = [1000, 2000, 5000, 10_000, 30_000, 60_000];
const BLOCKED_DELAY = 10 * 60_000;

export interface Session { sessionId: string; seq: number }
export interface Payload { op: number; id?: string; d?: any; s?: number; t?: string }
export type GatewayState = 'stopped' | 'connecting' | 'online' | 'offline' | 'blocked';

export interface GatewayOptions {
  getToken(): Promise<string>;
  invalidateToken(): void;
  getUrl(): Promise<string>;
  loadSession(): Session | null;
  saveSession(s: Session | null): void;
  /** 同步处理（落库）。只有成功返回后 seq 才会推进，崩溃/断线后由平台从上次位置补发。 */
  onDispatch(p: Payload): void;
  onState?(s: GatewayState, reason: string): void;
  backoff?: number[];
  blockedDelayMs?: number;
}

/**
 * QQ 网关长连接。与官方 SDK 的差别：
 *  1. 先落库再推进 seq —— 进程在两者之间崩溃时，重连会补发而不是丢消息；
 *  2. 心跳没有 ACK 即判定为假死连接并重连（外网切换、休眠唤醒时常见）。
 */
export class Gateway {
  state: GatewayState = 'stopped';
  reason = '';
  lastEventAt = 0;
  private ws: WebSocket | null = null;
  private beat: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  private fails = 0;
  private stopped = true;
  private waitingAck = false;
  private session: Session | null = null;

  constructor(private o: GatewayOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.session = this.o.loadSession();
    void this.connect();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.drop();
    this.setState('stopped', '');
  }

  private setState(s: GatewayState, reason: string): void {
    if (this.state === s && this.reason === reason) return;
    this.state = s; this.reason = reason;
    this.o.onState?.(s, reason);
  }
  private setSession(s: Session | null): void { this.session = s; this.o.saveSession(s); }

  private drop(): void {
    if (this.beat) clearInterval(this.beat);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.beat = this.helloTimer = null;
    const ws = this.ws;
    this.ws = null; // 先解除归属，旧连接的迟到事件不再处理
    if (ws) { ws.on('error', () => {}); ws.terminate(); }
  }

  private reconnect(reason: string, delay?: number, state: GatewayState = 'offline'): void {
    this.drop();
    if (this.stopped) return;
    const b = this.o.backoff ?? BACKOFF;
    const wait = delay ?? b[Math.min(this.fails, b.length - 1)]!;
    this.fails++;
    this.setState(state, reason);
    log.warn(`${reason}；${Math.round(wait / 1000)} 秒后重连`);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), wait);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.drop();
    this.setState('connecting', '');
    let token: string, url: string;
    try {
      token = await this.o.getToken();
      url = await this.o.getUrl();
    } catch (e) {
      return this.reconnect(`连接准备失败：${(e as Error).message}`);
    }
    if (this.stopped) return;
    const ws = new WebSocket(url, { handshakeTimeout: 20_000 });
    this.ws = ws;
    this.helloTimer = setTimeout(() => { if (ws === this.ws) this.reconnect('等待网关握手超时'); }, 30_000);
    ws.on('message', (data) => {
      if (ws !== this.ws) return;
      let p: Payload;
      try { p = JSON.parse(data.toString()); } catch { return log.error('收到无法解析的网关数据'); }
      this.handle(ws, p, token);
    });
    ws.on('close', (code) => { if (ws === this.ws) this.onClose(code); });
    ws.on('error', (e) => { log.warn(`连接错误：${e.message}`); if (ws === this.ws) this.reconnect(`连接错误：${e.message}`); });
  }

  private handle(ws: WebSocket, p: Payload, token: string): void {
    switch (p.op) {
      case OP.HELLO: {
        if (this.helloTimer) clearTimeout(this.helloTimer);
        const auth = `QQBot ${token}`;
        ws.send(JSON.stringify(this.session
          ? { op: OP.RESUME, d: { token: auth, session_id: this.session.sessionId, seq: this.session.seq } }
          : { op: OP.IDENTIFY, d: { token: auth, intents: INTENT_GROUP_AND_C2C, shard: [0, 1], properties: {} } }));
        this.waitingAck = false;
        this.beat = setInterval(() => {
          if (ws !== this.ws) return;
          if (this.waitingAck) return this.reconnect('心跳无响应');
          this.waitingAck = true;
          ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.session?.seq ?? null }));
        }, p.d.heartbeat_interval);
        break;
      }
      case OP.HEARTBEAT_ACK: this.waitingAck = false; break;
      case OP.DISPATCH: return this.dispatch(p);
      case OP.RECONNECT: return this.reconnect('网关要求重连', 0);
      case OP.INVALID_SESSION:
        this.setSession(null);
        this.o.invalidateToken();
        return this.reconnect('会话失效，重新登录', this.o.backoff ? undefined : 3000);
    }
  }

  private dispatch(p: Payload): void {
    this.lastEventAt = Date.now();
    if (p.t === 'READY') {
      this.fails = 0;
      this.setSession({ sessionId: p.d.session_id, seq: p.s ?? 0 });
      this.setState('online', '');
      log.info('机器人已上线');
      return;
    }
    if (p.t === 'RESUMED') {
      this.fails = 0;
      this.setState('online', '');
      log.info('已恢复会话，遗漏消息补发完成');
    } else {
      try {
        this.o.onDispatch(p);
      } catch (e) {
        // 落库失败（如磁盘满）：不推进 seq，断开后从上次位置重新补发
        log.error('消息处理失败，将重连补发', e);
        return this.reconnect('消息落库失败');
      }
    }
    if (p.s && this.session) this.setSession({ ...this.session, seq: Math.max(this.session.seq, p.s) });
  }

  private onClose(code: number): void {
    if (code === 4914 || code === 4915) return this.reconnect(code === 4914 ? '机器人已下架，仅允许沙箱环境（4914）' : '机器人已被封禁（4915）', this.o.blockedDelayMs ?? BLOCKED_DELAY, 'blocked');
    if (code === 4013 || code === 4014) return this.reconnect(`没有单聊事件权限（${code}），请在开放平台开通`, this.o.blockedDelayMs ?? BLOCKED_DELAY, 'blocked');
    if (code === 4004) { this.o.invalidateToken(); this.setSession(null); }
    else if (code === 4006 || code === 4007 || (code >= 4900 && code <= 4913)) this.setSession(null);
    this.reconnect(`连接断开（${code}）`);
  }
}
