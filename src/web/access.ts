import fs from 'node:fs';
import os from 'node:os';
import qrcode from 'qrcode-generator';
import type { Config } from '../config.js';

const VIRTUAL = /^(bridge|utun|vmnet|vmenet|docker|br-|veth|virbr|awdl|llw|tap|tun|feth|vEthernet|VMware|VirtualBox|Hyper-V|WSL|Tailscale|ZeroTier|Loopback)/i;

export interface Access { url: string; qr: string; kind: 'public' | 'lan' }
const cache = new Map<string, string>();
function qr(url: string): string {
  let v = cache.get(url);
  if (!v) {
    const q = qrcode(0, 'M');
    q.addData(url);
    q.make();
    v = q.createDataURL(5, 10);
    if (cache.size > 50) cache.clear();
    cache.set(url, v);
  }
  return v;
}

/** 手机能打开的地址：先外网（PUBLIC_URL），再本机的局域网地址。 */
export function accessUrls(config: Pick<Config, 'publicUrl' | 'host'>, port: number | string): Access[] {
  return [
    ...(config.publicUrl ? [{ url: config.publicUrl, kind: 'public' as const }] : []),
    ...lanHosts(config.host).map((h) => ({ url: `http://${h}:${port}`, kind: 'lan' as const })),
  ].map((a) => ({ ...a, qr: qr(a.url) }));
}

function lanHosts(host: string): string[] {
  if (host !== '0.0.0.0' && host !== '::') return /^(127\.|localhost$|::1$)/.test(host) ? [] : [host];
  if (fs.existsSync('/.dockerenv')) return []; // 容器里看到的是容器地址，手机打不开
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal && !/^(169\.254|198\.1[89])\./.test(a.address)).map((a) => ({ name, ip: a.address })));
  const real = all.filter((a) => !VIRTUAL.test(a.name));
  return (real.length ? real : all).map((a) => a.ip);
}
