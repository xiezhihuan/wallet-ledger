import type { NewAttachment } from '../store.js';

/** 平台事件 C2C_MESSAGE_CREATE 中用到的字段。 */
export interface C2CEvent {
  id: string; content?: string; timestamp?: string; message_type?: number;
  author: { user_openid?: string; id?: string; username?: string };
  message_scene?: { ext?: string[] };
  attachments?: RawAttachment[]; ark_data?: RawArk; msg_elements?: RawElement[];
}
interface RawAttachment { url?: string; filename?: string; size?: number; content_type?: string; voice_wav_url?: string; asr_refer_text?: string }
interface RawArk { ark_name?: string; prompt?: string; fields?: Record<string, unknown> }
interface RawElement { msg_idx?: string; message_type?: number; content?: string; attachments?: RawAttachment[]; ark_data?: RawArk; msg_elements?: RawElement[] }

export interface Incoming {
  openid: string; nickname: string; msgId: string; msgIdx: string; dedupeKey: string; sentAt: number;
  text: string; attachments: NewAttachment[];
  /** 引用的消息索引 */
  refIdx: string;
  /** 被引用内容（找不到原账目时随正文一起保留） */
  quoted: string; quotedAttachments: NewAttachment[];
  messageType: number;
  /** 平台原始事件，原样存档 */
  raw: unknown;
}

/** QQ 表情标签 → [表情:微笑]；其余尖括号内容保持原样。 */
function cleanText(s: string): string {
  return s.replace(/<faceType=[^>]*?ext="([^"]*)"[^>]*>/g, (_m, ext) => {
    try { return `[表情:${String(JSON.parse(Buffer.from(ext, 'base64').toString('utf8')).text ?? '').replace(/^\[|\]$/g, '')}]`; } catch { return '[表情]'; }
  }).replace(/\r\n?/g, '\n').trim();
}

const fixUrl = (u?: string): string | undefined => (u ? (u.startsWith('//') ? 'https:' + u : u) : undefined);

function attachment(a: RawAttachment): NewAttachment {
  const ct = (a.content_type ?? '').toLowerCase(), ext = /\.([a-z0-9]+)$/i.exec(a.filename ?? '')?.[1]?.toLowerCase() ?? '';
  const kind = ct.startsWith('image') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext) ? 'image'
    : ct.startsWith('voice') || ct.startsWith('audio') || ['silk', 'amr'].includes(ext) ? 'voice'
    : ct.startsWith('video') || ['mp4', 'mov'].includes(ext) ? 'video' : 'file';
  // 语音优先取 WAV，浏览器可直接播放
  const wav = kind === 'voice' ? fixUrl(a.voice_wav_url) : undefined;
  return { kind, url: wav ?? fixUrl(a.url), filename: wav ? (a.filename ?? 'voice').replace(/\.\w+$/, '') + '.wav' : a.filename, mime: wav ? 'audio/wav' : ct.includes('/') ? ct : '', size: wav ? 0 : a.size, text: kind === 'voice' ? a.asr_refer_text?.trim() : '' };
}

function ark(a: RawArk): string {
  const f = a.fields ?? {};
  const parts = [f.title ?? a.prompt, f.desc, f.address, f.jump_url].filter((x) => typeof x === 'string' && x);
  return `[${a.ark_name ?? '卡片'}] ${[...new Set(parts)].join(' ')}`.trim();
}

/** 递归展开引用 / 聊天记录里的元素。 */
function flatten(els: RawElement[] | undefined, depth = 0): { text: string; atts: NewAttachment[] } {
  const lines: string[] = [], atts: NewAttachment[] = [];
  if (depth > 5) return { text: '', atts };
  for (const e of els ?? []) {
    const c = cleanText(e.content ?? '');
    if (c) lines.push(c);
    else if (e.ark_data) lines.push(ark(e.ark_data));
    atts.push(...(e.attachments ?? []).map(attachment));
    const sub = flatten(e.msg_elements, depth + 1);
    if (sub.text) lines.push(sub.text);
    atts.push(...sub.atts);
  }
  return { text: lines.join('\n'), atts };
}

const ext = (e: C2CEvent, key: string): string => e.message_scene?.ext?.find((x) => x.startsWith(key + '='))?.slice(key.length + 1) ?? '';

export function parseC2C(e: C2CEvent): Incoming {
  const msgIdx = ext(e, 'msg_idx');
  const el = flatten(e.msg_elements);
  const quote = e.message_type === 103 || !!ext(e, 'ref_msg_idx');
  let text = cleanText(e.content ?? '');
  const atts = (e.attachments ?? []).map(attachment);
  if (e.ark_data) { const a = ark(e.ark_data); text = !text || text.startsWith('[卡片消息]') ? a : `${text}\n${a}`; }
  if (!quote && el.text && !text.includes(el.text)) text = [text, el.text].filter(Boolean).join('\n');
  if (!quote) atts.push(...el.atts);
  // 语音转写写入附件文字；正文里若重复了同样内容则不再保留
  if (atts.some((a) => a.kind === 'voice' && a.text && a.text === text)) text = '';
  const ts = Date.parse(e.timestamp ?? '');
  return {
    openid: e.author.user_openid || e.author.id || '', nickname: e.author.username ?? '', msgId: e.id, msgIdx,
    // 官方说明：相同 msg_id 可能重复推送，需结合 msg_idx 去重
    dedupeKey: `qq:${e.id}:${msgIdx}`,
    sentAt: Number.isFinite(ts) ? ts : Date.now(), text, attachments: atts,
    refIdx: ext(e, 'ref_msg_idx') || (quote ? e.msg_elements?.[0]?.msg_idx ?? '' : ''),
    quoted: quote ? el.text : '', quotedAttachments: quote ? el.atts : [], messageType: e.message_type ?? 0, raw: e,
  };
}

/**
 * 回复文本净化：QQ 对含链接/域名的消息有限制，会整条拒发。
 * 把 http 链接和形似域名的内容替换掉，保证回执能送达。
 */
export function sanitizeReply(s: string): string {
  return s.replace(/https?:\/\/\S+/gi, '[链接]').replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|io|top|xyz|cc|vip|info|me|co|app|dev|gov|edu|site|tech)\b(?:\/\S*)?/gi, '[链接]');
}
