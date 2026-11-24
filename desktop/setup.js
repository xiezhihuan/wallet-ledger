const el = id => document.getElementById(id);
window.ledger.view().then(v => { el('port').value = v.port; el('lan').checked = v.lan; el('appId').value = v.appId; if (v.saved) el('password').placeholder = '留空沿用已保存的密码'; });
async function start(demo) {
  el('msg').textContent = '正在打开账本…'; el('start').disabled = el('demo').disabled = true;
  try { el('msg').textContent = await window.ledger.start({ demo, port: el('port').value, lan: el('lan').checked, password: el('password').value, appId: el('appId').value, secret: el('secret').value }); }
  catch { el('msg').textContent = '启动失败，请重试'; }
  finally { el('start').disabled = el('demo').disabled = false; }
}
document.querySelector('form').onsubmit = e => { e.preventDefault(); start(false); };
el('demo').onclick = () => start(true);
