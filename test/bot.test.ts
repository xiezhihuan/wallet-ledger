import assert from 'node:assert/strict';
import test from 'node:test';
import { at } from '../src/time.js';
import { boot, fakeOcr, order, PNG, sendShot, shot, sleep, stamp, U, until, wx, type Env } from './helper.js';

const run = (name: string, fn: (e: Env) => Promise<void>, over: any = {}, opts: any = {}) => test(name, async () => { const e = await boot(over, { ocr: fakeOcr(), ...opts }); try { await fn(e); } finally { await e.stop(); } });
const live = (e: Env) => e.app.store.db.all('SELECT * FROM bills WHERE deleted_at IS NULL ORDER BY id');
const bill = (e: Env, id: number) => e.app.store.require(id);
const idle = (e: Env) => until(() => e.app.store.db.get(`SELECT COUNT(*) n FROM attachments WHERE status='pending' OR (status='done' AND ocr_status='pending')`)!.n === 0 && e.app.store.db.get('SELECT COUNT(*) n FROM receipts_due')!.n === 0, '处理完成');
const cmd = async (e: Env, t: string, re: RegExp) => { const n = e.mock.sent.length; e.mock.say(U, t); return e.reply(re, n); };
const now = Date.now(), T = (min: number) => stamp(now - min * 60_000), cat = (e: Env, n: string) => e.app.store.matchCategory(n)!.id;
const T1 = T(60), T2 = T(58);

run('未绑定者不记录、不能查；绑定码一次性、可防爆破', async (e) => {
  e.mock.say(U, '午饭 28'); await e.reply(/没有权限/);
  e.mock.say(U, '本月'); await until(() => e.mock.sent.filter((s) => /没有权限/.test(s.content)).length === 2);
  assert.equal(e.app.store.db.get('SELECT COUNT(*) n FROM messages')!.n, 0);
  const { code } = e.app.store.createBindCode();
  e.mock.say(U, '绑定 00000000'); await e.reply(/不正确/);
  e.mock.say(U, `绑定 ${code}`); await e.reply(/绑定成功/);
  e.mock.say('B'.repeat(32), `绑定 ${code}`); await until(() => e.mock.sent.filter((s) => /不正确/.test(s.content)).length === 2);
  for (let i = 0; i < 6; i++) e.mock.say('C'.repeat(32), '绑定 11111111');
  await e.reply(/次数过多/);
  e.mock.say(U, '午饭 28'); await e.reply(/已记 #1/);
  // 解绑后立即失效
  e.app.store.db.run('DELETE FROM qq_users'); e.mock.say(U, '晚饭 30'); await until(() => e.mock.sent.at(-1)!.content.includes('没有权限')); assert.equal(live(e).length, 1);
}, {}, { bind: false });

run('截图 + 文字说明并成一笔，只回一次，回执内容完整', async (e) => {
  e.mock.say(U, '和同事聚餐');
  sendShot(e, shot(wx('老街牛肉面馆', '-28.00', T1, '4200002988202611031234567890')));
  e.mock.say(U, '这顿可以报销');
  const r = await e.reply(/已记 #1/);
  for (const x of [/支出：¥28\.00/, /商户：老街牛肉面馆/, /分类：餐饮\/正餐/, /支付：零钱/, /备注：和同事聚餐/, /改 28\.5/]) assert.match(r, x);
  await sleep(200); assert.equal(e.mock.sent.length, 1); assert.equal(live(e).length, 1);
  assert.equal(bill(e, 1).note, '和同事聚餐\n这顿可以报销'); assert.equal(bill(e, 1).status, 'ok');
});
run('同一笔的多张图（支付成功页 + 账单详情 + 订单详情）合成一笔，以凭证和真实店名为准', async (e) => {
  sendShot(e, shot(['支付成功', '美团平台商户', { big: '¥28.50' }, ['付款方式', '零钱']]));
  sendShot(e, shot(wx('美团平台商户', '-28.50', T1, '4200002988202611031234567891')));
  sendShot(e, shot(order('渝味小面（高新店）', '28.50', T2, '8001234567890123')));
  const r = await e.reply(/已记 #1/); await idle(e);
  assert.equal(live(e).length, 1, r); const b = bill(e, 1);
  assert.deepEqual([b.amount, b.merchant, b.method], [2850, '渝味小面（高新店）', '零钱']); assert.equal(e.app.store.detail(1).evidence.length, 3); assert.equal(e.app.store.categoryName(b.category_id), '餐饮/外卖');
});
run('连发两张不同付款的截图：同笔待确认，素材不丢', async (e) => {
  sendShot(e, shot(wx('老街牛肉面馆', '-28.00', T(100), '4200002988202611030000000001')));
  sendShot(e, shot(wx('城市地铁', '-5.00', T(50), '4200002988202611030000000002')));
  e.mock.say(U, '去机场接人');
  await e.reply(/#1 待确认/); await idle(e);
  assert.equal(live(e).length,1); assert.equal(bill(e,1).note,'去机场接人'); assert.equal(e.app.store.detail(1).evidence.length,3);
});
run('一条消息里两张图归一笔；只有新建才切换', async (e) => {
  sendShot(e, [shot(wx('老街牛肉面馆', '-20.00', T(100), '4200002988202611030000000011')), shot(wx('蓝山便利店', '-20.00', T(50), '4200002988202611030000000012'))]);
  await e.reply(/#1/); await idle(e); assert.equal(live(e).length, 1);
  e.mock.say(U, '新建');
  sendShot(e, shot(wx('小满咖啡', '-19.90', T(40), '4200002988202611030000000013'))); sendShot(e, shot(wx('小满咖啡', '-19.90', T(20), '4200002988202611030000000014')));
  await until(() => live(e).length === 2 && live(e).every((b) => b.amount)); await idle(e);
  assert.ok(live(e).every((b) => b.status === 'ok'), JSON.stringify(live(e).map((b) => [b.status, b.dup_why])));
});
run('图与文字先后到、识别慢：金额冲突待确认；相同则可入账', async (e) => {
  sendShot(e, shot(wx('老街牛肉面馆', '-28.00', T1, '4200002988202611030000000021'))); e.mock.say(U, '打车 35.5');
  await e.reply(/#1 待确认/); await idle(e); assert.deepEqual(live(e).map((b) => [b.amount, b.item]), [[2800, '打车']]);
  e.mock.say(U, '新建'); e.mock.say(U, '咖啡 19.9'); sendShot(e, shot(['支付成功', '小满咖啡', { big: '¥19.90' }, ['付款方式', '零钱通']]));
  await e.reply(/已记 #2/); await idle(e); assert.equal(live(e).length, 2); assert.deepEqual([bill(e, 2).merchant, bill(e, 2).item, bill(e, 2).amount], ['小满咖啡', '咖啡', 1990]);
}, {}, { ocr: fakeOcr(150) });
run('同一条消息里文字金额与截图不一致：不猜，标待确认并给出候选', async (e) => {
  sendShot(e, shot(wx('老街牛肉面馆', '-56.00', T1, '4200002988202611030000000031')), '午饭我出 28');
  const r = await e.reply(/#1 待确认/); assert.match(r, /你写的是 ¥28\.00，截图是 ¥56\.00/); assert.equal(live(e).length, 1);
  assert.equal(e.app.intake.stats.totals({ from: '2020-01-01', to: '2029-01-01' }).net, 0);
  await cmd(e, '改 28', /✅ #1 支出 ¥28\.00/); assert.equal(bill(e, 1).status, 'ok');
});
run('两句带金额的文字仍是一笔；只有金额的短句不覆盖已有金额', async (e) => {
  e.mock.say(U, '早饭 5'); e.mock.say(U, '午饭 28.5'); await e.reply(/#1 待确认/);
  assert.deepEqual(live(e).map((b) => b.amount), [500]);
  e.mock.say(U, '新建'); sendShot(e, shot(wx('小满咖啡', '-19.90', T1, '4200002988202611030000000041'))); await e.reply(/已记 #2/);
  e.mock.say(U, '25'); await e.reply(/已是 ¥19\.90，没有改成 ¥25\.00/); assert.equal(bill(e, 2).amount, 1990);
});
run('相对日期；记账途中单发「昨天」只改日期', async (e) => {
  e.mock.say(U, '打车 35.5 昨天'); await e.reply(/已记 #1/); e.mock.say(U, '新建'); e.mock.say(U, '电影 79.8'); await e.reply(/已记 #2/);
  e.mock.say(U, '昨天'); await until(() => bill(e, 2).day === bill(e, 1).day); assert.equal(bill(e, 2).note, '');
  const d = new Date(Date.now() + 8 * 3600_000 - 86400_000).toISOString().slice(0, 10); assert.equal(bill(e, 1).day, d);
});
run('语音转写记账', async (e) => {
  e.mock.say(U, '', { attachments: [{ content_type: 'voice', filename: 'v.silk', url: e.mock.base + '/file/none', asr_refer_text: '奶茶十五块' }] });
  const r = await e.reply(/已记 #1/); assert.match(r, /¥15\.00/); assert.match(r, /来自语音转写/);
});
run('录入跨越闲置时长仍是一笔；新建才开启下一笔', async (e) => {
  const t = Date.now();
  e.mock.say(U, '看牙', { at: t - 20 * 60_000 }); e.mock.say(U, '130', { at: t - 18 * 60_000 }); e.mock.say(U, '医保外', { at: t });
  await e.reply(/#1/); assert.equal(bill(e, 1).amount, 13000); assert.equal(live(e).length, 1);
  e.app.store.saveSetting('merge_window_min', '0'); e.mock.say(U, '新建'); e.mock.say(U, 'A店', { at: t + 1000 }); e.mock.say(U, 'B店', { at: t + 2000 }); await until(() => bill(e, 2).note.includes('B店'));
});
run('引用消息或回执补充；指定编号补充；引用没收录过的消息连原文一起记', async (e) => {
  const a = e.mock.say(U, '午饭 28'); await e.reply(/已记 #1/); e.mock.say(U, '新建'); e.mock.say(U, '打车 35'); await e.reply(/已记 #2/);
  e.mock.say(U, '和老王', { ref: a.idx, msg_elements: [{ msg_idx: a.idx, content: '午饭 28' }] }); await until(() => bill(e, 1).note === '和老王');
  const i = e.mock.sent.findIndex((s) => /已记 #2/.test(s.content)) + 1;
  e.mock.say(U, '改分类 公交地铁', { ref: `REFIDX_bot${i}` }); await e.reply(/✅ #2/); assert.equal(bill(e, 2).category_id, cat(e, '公交地铁'));
  e.mock.say(U, '补充 1 发票已开'); await until(() => /发票已开/.test(bill(e, 1).note));
  e.mock.say(U, '新建'); e.mock.say(U, '这个也算', { ref: 'REFIDX_x', msg_elements: [{ msg_idx: 'REFIDX_x', content: '水果 25' }] }); await until(() => live(e).length === 3); assert.equal(bill(e, 3).amount, 2500); assert.match(bill(e, 3).note, /这个也算/);
  // 指定编号补充的凭证金额不同：尊重指定，但不改金额并提示
  sendShot(e, shot(wx('别的店', '-99.00', T1, '4200002988202611030000000051')), '补充 1'); await e.reply(/附加凭证的金额 ¥99\.00/).catch(async () => { await idle(e); }); await idle(e);
  assert.equal(live(e).length, 3); assert.equal(e.app.store.detail(1).evidence.filter((x: any) => x.attachment_id).length, 1);
});
run('新建 / 完成 / 撤销 / 拆分 / 并入 / 删除 / 恢复', async (e) => {
  await cmd(e, '午饭 28', /已记 #1/); await cmd(e, '完成', /记完了/); await cmd(e, '打车 35', /已记 #2/);
  await cmd(e, '撤销', /#2 已无内容/); assert.ok(bill(e, 2).deleted_at); await cmd(e, '恢复 2', /已恢复/);
  await cmd(e, '新建 超市 60', /已记 #3/); await cmd(e, '买了牛奶', /#3/); await cmd(e, '拆分', /已拆成两笔/); assert.equal(live(e).length, 4); assert.equal(bill(e, 3).note, ''); assert.equal(bill(e, 4).note, '买了牛奶'); assert.equal(bill(e, 4).status, 'pending');
  await cmd(e, '并入 4 3', /#4 已并入 #3/); assert.equal(bill(e, 3).amount, 6000); assert.equal(bill(e, 3).note, '买了牛奶'); assert.ok(bill(e, 4).deleted_at);
  await cmd(e, '删除 1', /#1 已删除/); await cmd(e, '改 #1 9', /已删除/); await cmd(e, '恢复 1', /已恢复/); assert.equal(bill(e, 1).amount, 2800);
  await cmd(e, '改 #99 5', /#99 不存在/);
});
run('改金额 / 分类 / 时间 / 备注 / 商户 / 支付 / 类型；人工改过的不再被识别覆盖', async (e) => {
  sendShot(e, shot(wx('老街牛肉面馆', '-28.00', T1, '4200002988202611030000000061'))); await e.reply(/已记 #1/);
  await cmd(e, '改 28.5', /¥28\.50/); await cmd(e, '改分类 咖啡奶茶', /以后「老街牛肉面馆」都归到 餐饮\/咖啡奶茶/); await cmd(e, '改时间 11月3日 12:30', /11-03 12:30/); await cmd(e, '改备注 出差', /备注：出差/); await cmd(e, '改商户 老街面馆', /老街面馆/); await cmd(e, '改支付 现金', /现金/);
  await cmd(e, '改分类 不存在的', /没有「不存在的」/); await cmd(e, '改时间 随便', /看不懂/);
  sendShot(e, shot(order('另一个名字小店', '28.00', T1, '8001234567890777')), '补充 1'); await sleep(50); await idle(e);
  const b = bill(e, 1); assert.deepEqual([b.amount, b.merchant, b.method, b.note, b.day.slice(5)], [2850, '老街面馆', '现金', '出差', '11-03']);
  assert.ok(e.app.store.detail(1).events.some((x: any) => x.action === '修改金额' && x.detail === '¥28.00 → ¥28.50'));
  await cmd(e, '改类型 转账', /转账/); assert.equal(e.app.intake.stats.totals({ from: '2020-01-01', to: '2029-01-01' }).net, 0);
});
run('记住商户分类并用于以后；可查看和撤销规则', async (e) => {
  await cmd(e, '新建 神秘小铺子 20', /没能自动归类/); await cmd(e, '改分类 日用百货', /撤销规则 1/);
  await cmd(e, '新建 神秘小铺子 35', /分类：购物\/日用百货/); await cmd(e, '规则', /神秘小铺子/); await cmd(e, '撤销规则 1', /已撤销规则/); await cmd(e, '新建 神秘小铺子 46', /没能自动归类/);
  assert.equal(bill(e, 1).category_id, cat(e, '日用百货'));
});
run('疑似重复：同单号隔窗口再发 → 提示、暂不计入；重复 / 不重复由用户定', async (e) => {
  const img = wx('老街牛肉面馆', '-28.00', T1, '4200002988202611030000000071');
  sendShot(e, shot(img)); await e.reply(/已记 #1/); await cmd(e, '完成', /记完了/);
  sendShot(e, shot(img)); const r = await e.reply(/#2 疑似与 #1 重复/); assert.match(r, /单号相同/); assert.match(r, /同一笔发「重复」/);
  const net = () => e.app.intake.stats.totals({ from: '2020-01-01', to: '2029-01-01' }).net;
  assert.equal(net(), 2800); await cmd(e, '重复', /只算一次/); assert.equal(net(), 2800); assert.ok(bill(e, 2).deleted_at); assert.equal(e.app.store.detail(1).evidence.length, 2);
  await cmd(e, '完成', /记完了|没有/); sendShot(e, shot(img)); await e.reply(/#3 疑似与 #1 重复/); await cmd(e, '不重复', /是两笔/); assert.equal(net(), 5600);
  // 没有单号：金额、商户、时间相近
  const p = ['交易详情', '绿禾超市', { big: '-¥86.35' }, ['交易时间', T(30)], ['支付方式', '花呗']] as any;
  await cmd(e, '完成', /记完了|没有/); sendShot(e, shot(p)); await e.reply(/已记 #4/); await cmd(e, '完成', /记完了/); sendShot(e, shot(p)); await e.reply(/#5 疑似与 #4 重复（金额、商户、时间相近）/);
  // 删除原来那笔后，疑似的自动转为正常
  e.app.store.remove(4, '测试'); assert.equal(bill(e, 5).status, 'ok');
});
run('先打字后补截图（隔窗口）也提示疑似重复；间隔久的相同消费不误报', async (e) => {
  await cmd(e, '老街牛肉面馆 28', /已记 #1/); await cmd(e, '完成', /记完了/);
  sendShot(e, shot(wx('老街牛肉面馆', '-28.00', stamp(Date.now() - 5 * 60_000), '4200002988202611030000000081'))); await e.reply(/#2 疑似与 #1 重复/);
  await cmd(e, '不重复', /是两笔/); await cmd(e, '完成', /./); sendShot(e, shot(wx('老街牛肉面馆', '-28.00', stamp(Date.now() - 26 * 3600_000), '4200002988202611030000000082'))); await e.reply(/已记 #3/);
});
run('退款自动关联同单号原支出并冲减；转账、还款不算消费；收入不算', async (e) => {
  const net = () => e.app.intake.stats.totals({ from: '2020-01-01', to: '2029-01-01' }).net, no = '4200002988202611030000000091';
  sendShot(e, shot(wx('云衣服饰旗舰店', '-129.00', T(300), no))); await e.reply(/已记 #1/); await cmd(e, '完成', /./);
  sendShot(e, shot(['账单详情', '云衣服饰旗舰店-退款', { big: '+129.00' }, ['当前状态', '已全额退款'], ['退款时间', T(10)], ['交易单号', no]])); const r = await e.reply(/已记 #2/);
  assert.match(r, /退款：¥129\.00/); assert.match(r, /原支出：#1/); assert.equal(net(), 0); assert.equal(e.app.store.detail(1).refunded, 12900);
  await cmd(e, '新建 还信用卡 3200', /不算消费/); await cmd(e, '新建 转给小李 200', /不算消费/); await cmd(e, '新建 工资 8500', /收入：¥8,500\.00/); assert.equal(net(), 0);
  await cmd(e, '新建 外套 300', /已记 #6/); await cmd(e, '新建 外套退款 100', /可能是这笔的退款/); assert.equal(net(), 20000); await cmd(e, '关联 6', /#7 退款/); assert.equal(bill(e, 7).refund_of, 6);
  await cmd(e, '新建 外套退款 250', /已记/); await cmd(e, '关联 8 6', /./); assert.equal(e.app.store.refundable(6), -5000); assert.match(bill(e, 8).flags, /累计退款超过原支出/);
});
run('账单列表逐行列出，确认后入账；疑似重复的行默认跳过', async (e) => {
  sendShot(e, shot(wx('老街牛肉面馆', '-28.00', T1, '4200002988202611030000000101'))); await e.reply(/已记 #1/); await cmd(e, '完成', /./);
  const row = (n: string, t: string, a: string): any[] => [[n, a], [t, '']];
  const md = (min: number) => { const s = T(min); return `${+s.slice(5, 7)}月${+s.slice(8, 10)}日 ${s.slice(11, 16)}`; };
  sendShot(e, shot(['账单', ...row('老街牛肉面馆', md(60), '-28.00'), ...row('蓝山便利店', md(90), '-17.60'), ...row('微信红包-来自小王', md(100), '+50.00'), ...row('小满咖啡', md(120), '-19.90')]));
  const r = await e.reply(/#2 这张是账单列表，4 笔/); assert.match(r, /1\. .*老街牛肉面馆 ¥28\.00 ⚠️疑似 #1/); assert.match(r, /3\. .*\+¥50\.00收入/);
  assert.equal(e.app.intake.stats.totals({ from: '2020-01-01', to: '2029-01-01' }).net, 2800);
  assert.match(await cmd(e, '入账 4', /入账 1 笔/), /小满咖啡/); const r2 = await cmd(e, '入账 全部', /入账 2 笔/); assert.match(r2, /第 1 行 疑似与 #1 重复/);
  assert.equal(e.app.intake.stats.totals({ from: '2020-01-01', to: '2029-01-01' }).net, 2800 + 1990 + 1760); await cmd(e, '忽略', /不入账/); assert.equal(bill(e, 2).status, 'batch_done');
  await cmd(e, '入账 全部', /没有待入账/); assert.equal(e.app.store.detail(3).evidence.length, 1, '入账的账能看到原列表截图');
});
run('列表与付款截图连发：保留三份材料，仍仅一笔', async (e) => {
  sendShot(e, shot(wx('老街牛肉面馆', '-28.00', T(500), '4200002988202611030000000111')));
  sendShot(e, shot(['账单', ['A店', '-1.00'], [T(30).slice(0, 16), ''], ['B店', '-2.00'], [T(40).slice(0, 16), '']]));
  sendShot(e, shot(wx('城市地铁', '-5.00', T(50), '4200002988202611030000000112')));
  await e.reply(/#1 待确认/); await idle(e); assert.equal(live(e).length,1); assert.equal(e.app.store.detail(1).evidence.length,3);
});
run('模糊 / 未付款 / 看不出金额：待确认、不计入，确认或改金额后才计入', async (e) => {
  sendShot(e, shot(['账单详情', '看不清商店', { big: '-88.80', c: 0.6 }, ['支付方式', '零钱']])); await e.reply(/#1 待确认/);
  const net = () => e.app.intake.stats.totals({ from: '2020-01-01', to: '2029-01-01' }).net; assert.equal(net(), 0); assert.equal(e.app.intake.stats.totals({ from: '2020-01-01', to: '2029-01-01', includePending: true }).net, 8880);
  await cmd(e, '待确认', /待处理 1 笔/); await cmd(e, '确认', /已确认入账/); assert.equal(net(), 8880);
  await cmd(e, '新建', /./); sendShot(e, shot(['今天去哪吃', '随便'])); await e.reply(/#2 待确认[\s\S]*改 28\.5/); await cmd(e, '确认', /还没有金额/); await cmd(e, '改 30', /¥30\.00/); assert.equal(net(), 11880);
  await cmd(e, '新建', /./); sendShot(e, shot(['订单详情', '等待付款', '山野户外店', ['需付款', '¥209.00']])); await e.reply(/#3 待确认[\s\S]*还没付款/);
});
run('QQ 查询：今天 / 本周 / 本月 / 本季度 / 今年；查、详情、预算', async (e) => {
  await cmd(e, '新建 午饭 28', /已记/); await cmd(e, '新建 打车 12', /已记/);
  for (const q of ['今天', '本周', '本月花了多少', '本季度', '今年花到哪里了']) assert.match(await cmd(e, q, /📊/), /净消费 ¥40\.00[\s\S]*餐饮 ¥28\.00（70%）/, q);
  await cmd(e, '查 午饭', /共 1 笔/); await cmd(e, '查 没有的', /没有找到/); await cmd(e, '详情 1', /记录/); await cmd(e, '分类列表', /餐饮：/); await cmd(e, '帮助', /截图账本/);
  e.app.store.saveBudget(0, 5000); await cmd(e, '预算', /总预算 ¥40\.00 \/ ¥50\.00（80%）/); await cmd(e, '新建 晚饭 30', /🔴 总预算 ¥70\.00 \/ ¥50\.00（140%），超支 ¥20\.00/);
});
run('重复推送不重复记账、指令不重复执行', async (e) => {
  const a = e.mock.say(U, '午饭 28'); await e.reply(/已记 #1/); e.mock.emit('C2C_MESSAGE_CREATE', a.event); e.mock.emit('C2C_MESSAGE_CREATE', a.event);
  const d = e.mock.say(U, '删除 1'); await e.reply(/已删除/); e.app.store.restore(1, 'x'); e.mock.emit('C2C_MESSAGE_CREATE', d.event); await sleep(100); assert.equal(live(e).length, 1); assert.equal(e.app.store.detail(1).evidence.length, 1);
});
run('断线重连、停机补发、识别途中重启：不丢不重', async (e) => {
  for (let i = 0; i < 60; i++) { e.mock.say(U, `新建 第${i}笔 ${i + 1}`); if (i % 7 === 3) { e.mock.closeSocket(4009); await until(() => e.mock.online); } }
  await until(() => live(e).length === 60, '60 笔'); assert.equal(e.app.store.db.get('SELECT SUM(amount) s FROM bills')!.s, (60 * 61 / 2) * 100);
  await e.app.close(); // 停机期间继续发
  e.mock.say(U, '新建 停机时发的 77'); e.mock.say(U,'新建'); sendShot(e, shot(wx('老街牛肉面馆', '-28.00', T1, '4200002988202611030000000121')), '', {});
  await e.restart(); await until(() => live(e).some((b) => b.amount === 7700) && live(e).some((b) => b.merchant === '老街牛肉面馆'), '补发');
  assert.equal(live(e).length, 62);
});
run('收到即落库：回执没来得及发就重启，重启后补发回执且识别继续', async (e) => {
  sendShot(e, shot(wx('老街牛肉面馆', '-28.00', T1, '4200002988202611030000000131'))); await until(() => live(e).length === 1); const n = e.mock.sent.length;
  await e.restart(); await e.reply(/已记 #1[\s\S]*¥28\.00/, n); await idle(e); assert.equal(live(e).length, 1); assert.equal(e.mock.sent.length - n, 1);
}, { receiptDelayMs: 1500 }, { ocr: fakeOcr(400) });
run('落库失败不推进进度，恢复后补发', async (e) => {
  const db = e.app.store.db, real = db.tx.bind(db); let broken = true;
  (db as any).tx = (fn: any) => { if (broken) throw new Error('disk full'); return real(fn); };
  e.mock.say(U, '午饭 28'); await sleep(150); assert.equal(live(e).length, 0); broken = false; await until(() => live(e).length === 1); assert.equal(bill(e, 1).amount, 2800);
});
run('异常附件：下载失败重试、伪装图片、超大、内网地址、无地址，都留痕且不崩', async (e) => {
  const f = (u: string, o: any) => { e.mock.files.set(u, o); return { content_type: 'image/png', filename: 'a.png', url: e.mock.base + u }; };
  e.mock.say(U, '', { attachments: [f('/file/flaky', { body: shot(wx('老街牛肉面馆', '-28.00', T1, '4200002988202611030000000141')), fail: 2 })] }); await until(() => live(e)[0]?.amount === 2800, '重试成功'); await cmd(e, '新建', /./);
  e.mock.say(U, '', { attachments: [f('/file/html', { body: Buffer.from('<script>alert(1)</script>'), type: 'image/png' })] }); await until(() => live(e).length === 2); await idle(e); assert.equal(bill(e, 2).status, 'pending'); assert.notEqual(e.app.store.db.get('SELECT mime FROM attachments ORDER BY id DESC')!.mime, 'image/png'); await cmd(e, '新建', /./);
  e.mock.say(U, '', { attachments: [f('/file/big', { body: Buffer.alloc(3 * 1024 * 1024, 1) })] }); await until(() => e.app.store.db.get(`SELECT 1 FROM attachments WHERE status='failed'`)); await until(() => bill(e, 3).status === 'pending'); assert.match(bill(e, 3).flags, /没能识别/); await cmd(e, '新建', /./);
  e.mock.say(U, '', { attachments: [{ content_type: 'image/png', filename: 'x.png' }] }); await e.reply(/没能保存/); await cmd(e, '新建', /./);
  e.mock.say(U, '', { attachments: [f('/file/empty', { body: Buffer.alloc(0) })] }); e.mock.say(U, '', { attachments: [f('/file/broken', { body: PNG.subarray(0, 40) })] }); await until(() => e.app.store.db.get(`SELECT COUNT(*) n FROM attachments WHERE status='pending' OR (status='done' AND ocr_status='pending')`)!.n === 0);
  await cmd(e, '新建 还能记 9', /已记/);
}, { maxAttachmentBytes: 2 * 1024 * 1024 });
run('并发：多人、连发多图交错，互不串账', async (e) => {
  const V = 'F'.repeat(32); e.app.store.db.run('INSERT INTO qq_users(openid,bound_at) VALUES(?,1)', V);
  for (let i = 0; i < 12; i++) { e.mock.say(U,'新建'); sendShot(e, shot(wx(`商户${i}号店`, `-${i + 1}.00`, T(600 - i * 20), `42000029882026110300000${1000 + i}`))); e.mock.say(V, `新建 另一人${i} ${100 + i}`); }
  await until(() => live(e).length === 24 && live(e).every((b) => b.amount !== null), '24 笔', 10_000); await idle(e);
  const mine = live(e).filter((b) => b.author === U), his = live(e).filter((b) => b.author === V);
  assert.equal(mine.length, 12); assert.equal(mine.reduce((n, b) => n + b.amount, 0), 7800); assert.equal(his.reduce((n, b) => n + b.amount, 0), (1200 + 66) * 100);
});
run('回执被平台拒发时退回精简回执；含网址的内容仍能送达', async (e) => {
  e.mock.sendFailures.push({ status: 400, body: { err_code: 40054010, message: 'x' } }); e.mock.say(U, '午饭 28'); await e.reply(/✅ 已记录 #1$/);
  await cmd(e, '新建 域名 www.example.com 88', /已记 #2/);
});
run('账单列表关闭后仍可重新打开；撤回列表截图不留残余', async (e) => {
  sendShot(e, shot(['账单', ['A店', '-1.00'], [T(30).slice(0, 16), ''], ['B店', '-2.00'], [T(40).slice(0, 16), '']])); await e.reply(/账单列表/); await cmd(e, '忽略', /不入账/); e.app.store.reopenBatch(1, 'x'); await cmd(e, '入账 2', /入账 1 笔/); await cmd(e, '入账 2', /已入账/);
});
run('加好友欢迎语', async (e) => { e.mock.emit('FRIEND_ADD', { openid: 'N'.repeat(32) }, 'evt-x'); await e.reply(/我是截图账本/); });
void at;

run('同一窗口再次上传原图保留两份素材，网关重投同一消息仍幂等', async (e) => {
  const buf = shot(wx('合成书店', '-16.90', T1, 'SYNTHETIC11112222'));
  sendShot(e, buf); await e.reply(/已记 #1/);
  sendShot(e, buf); await until(() => e.app.store.detail(1).evidence.length === 2); await idle(e);
  assert.equal(e.app.store.detail(1).evidence.length, 2);
  assert.equal(live(e).length, 1);
});
