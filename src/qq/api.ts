import { logger } from '../log.js';

const log = logger('qq-api');

export class QQApiError extends Error {
  constructor(message: string, readonly code: number, readonly httpStatus: number) { super(message); }
}

/** QQ 机器人 OpenAPI 最小客户端。文档：https://bot.q.qq.com/wiki/develop/api-v2/ */
export class QQApi {
  private token = '';
  private expiresAt = 0;
  private pending: Promise<string> | null = null;

  constructor(private o: { appId: string; secret: string; base: string; timeoutMs?: number; retryDelayMs?: number }) {}

  private async request(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: any }> {
    const res = await fetch(this.o.base + path, {
      method, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
    });
    const text = await res.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
    return { status: res.status, data };
  }

  /** 官方约定：过期前 60 秒内重新获取会得到新 token，旧的仍可用。 */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 50_000) return this.token;
    this.pending ??= (async () => {
      try {
        const { status, data } = await this.request('POST', '/app/getAppAccessToken', { appId: this.o.appId, clientSecret: this.o.secret });
        // 该接口业务失败时 HTTP 仍为 200，以 code / access_token 判断
        if (!data.access_token) throw new QQApiError(`获取 access_token 失败：http=${status}, code=${Number(data.code ?? 0)}`, Number(data.code ?? 0), status);
        this.token = data.access_token;
        this.expiresAt = Date.now() + Number(data.expires_in ?? 7200) * 1000;
        return this.token;
      } finally { this.pending = null; }
    })();
    return this.pending;
  }
  invalidateToken(): void { this.token = ''; }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      let err: QQApiError | Error;
      let retry: boolean;
      try {
        const token = await this.getToken();
        const { status, data } = await this.request(method, path, body, { Authorization: `QQBot ${token}` });
        const code = Number(data.err_code ?? data.code ?? 0);
        if (status >= 200 && status < 300 && !code) return data;
        err = new QQApiError(`${method} ${path.replace(/users\/[^/]+\/messages/, 'users/***/messages')} 失败(code=${code}, http=${status})`, code, status);
        const auth = status === 401 || code === 11244 || code === 11243;
        if (auth) this.invalidateToken();
        retry = auth ? attempt === 0 : status === 429 || status >= 500;
      } catch (e) {
        if (e instanceof QQApiError && e.httpStatus < 500) throw e;
        err = e as Error; // 网络错误 / 超时
        retry = true;
      }
      if (!retry || attempt >= 3) throw err;
      log.warn(`第 ${attempt + 1} 次重试：${err.message}`);
      await new Promise((r) => setTimeout(r, (this.o.retryDelayMs ?? 1000) * 2 ** attempt));
    }
  }

  async gatewayUrl(): Promise<string> { return (await this.call('GET', '/gateway')).url; }
  async me(): Promise<{ id: string; username: string }> { return this.call('GET', '/users/@me'); }

  /** 单聊被动回复（60 分钟内、每条消息最多 4 次）。返回用于引用识别的 ref_idx。 */
  async replyC2C(openid: string, content: string, ref: { msgId?: string; eventId?: string; seq: number }): Promise<string | undefined> {
    const data = await this.call('POST', `/v2/users/${encodeURIComponent(openid)}/messages`, {
      msg_type: 0, content, msg_seq: ref.seq, ...(ref.msgId ? { msg_id: ref.msgId } : { event_id: ref.eventId }),
    });
    return data?.ext_info?.ref_idx;
  }

  /** 主动发送单聊通知，不依赖某条用户消息的被动回复窗口。 */
  async sendC2C(openid: string, content: string, seq: number): Promise<void> {
    await this.call('POST', `/v2/users/${encodeURIComponent(openid)}/messages`, { msg_type: 0, content, msg_seq: seq });
  }
}
