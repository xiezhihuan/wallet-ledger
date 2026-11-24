import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { boot, login, until } from './helper.js';

test('MCP 受控修改、版本冲突、幂等、复核与完整日志', async () => {
    const e = await boot({ backupKeep: 0 });
  try {
    const api = await login(e.app);
    const created = await api('/bills', { method: 'POST', body: { amount: '28.00', merchant: '合成咖啡', occurred: '2026-11-03T12:00', category_id: 2 } });
    assert.equal(created.status, 200);
    const billId = created.data.id;
    const tok = (await api('/mcp-tokens', { method: 'POST', body: { name: 'test-writer', can_see_images: false } })).data;
    const auth = (await api('/mcp-authorizations', { method: 'POST', body: { scope: 'bill', bill_id: billId, minutes: 10 } })).data;
    const c = new Client({ name: 'mcp-write-test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(e.app.url + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${tok.token}` } } }) as any);
    const call = async (name: string, args: any) => {
      const r: any = await c.callTool({ name, arguments: args });
      let data: any = null; try { data = r.content?.[0]?.text ? JSON.parse(r.content[0].text) : null; } catch { data = { text: r.content?.[0]?.text }; }
      return { raw: r, data };
    };
    const before = await call('get_bill', { id: billId });
    assert.equal(before.data.amount, '28.00');
    const preview = await call('update_bill', { id: billId, authorization_code: auth.code, expected_version: before.data.version, reason: '合成截图复核发现金额录错', amount: 30, preview: true });
    assert.ok(!preview.raw.isError, preview.data?.text ?? 'preview failed');
    assert.deepEqual(preview.data.changed_fields.amount, { before: 2800, after: 3000 });
    const write = await call('update_bill', { id: billId, authorization_code: auth.code, expected_version: before.data.version, reason: '合成截图复核发现金额录错', amount: 30, preview: false, request_id: 'test-request-1' });
    assert.equal(write.data.ok, true);
    assert.equal(write.data.detail.amount, 3000);
    await until(() => e.mock.sent.find((s) => s.content.includes(`MCP 已修改 #${billId}`)), 'MCP 修改 QQ 通知');
    const retry = await call('update_bill', { id: billId, authorization_code: auth.code, expected_version: before.data.version, reason: '合成截图复核发现金额录错', amount: 30, preview: false, request_id: 'test-request-1' });
    assert.equal(retry.data.version, write.data.version);
    const stale = await call('update_bill', { id: billId, authorization_code: auth.code, expected_version: before.data.version, reason: '过期版本', amount: 31, preview: false, request_id: 'test-request-2' });
    assert.equal(stale.raw.isError, true);
    const log = await call('get_change_log', { id: billId });
    assert.ok(log.data.changes.length >= 2);
    assert.ok(log.data.changes.some((c: any) => c.source === 'mcp' && c.fields.amount.after === 3000));
    const reviewed = await call('review_bill', { id: billId, result: 'ok', note: '金额已核对' });
    assert.equal(reviewed.data.result, 'ok');
    const queue = await call('list_review_queue', { never_reviewed: false, page_size: 20 });
    assert.equal(queue.data.total, 0);
    const changed = await api(`/bills/${billId}`, { method: 'PATCH', body: { note: '网页再次修改', reason: '测试' } });
    assert.equal(changed.status, 200);
    const queueAgain = await call('list_review_queue', { page_size: 20 });
    assert.equal(queueAgain.data.total, 1);
    const audit = e.app.store.db.all('SELECT result,reason,detail FROM mcp_audit ORDER BY id');
    assert.ok(audit.some((r: any) => r.result === 'success'));
    assert.ok(audit.some((r: any) => r.result === 'rejected'));
    assert.ok(!JSON.stringify(audit).includes(auth.code));
    await c.close();
  } finally {
    await e.stop();
  }
});
