const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('adm') || '';

async function api(path, method = 'GET', body) {
  const r = await fetch('/admin/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { logout(); throw new Error('unauthorized'); }
  return r.json();
}

// Build table rows with textContent only (never innerHTML) so stored data cannot inject markup.
function fill(table, head, rows) {
  table.replaceChildren();
  const tr = document.createElement('tr');
  head.forEach((h) => { const th = document.createElement('th'); th.textContent = h; tr.append(th); });
  table.append(tr);
  rows.forEach((cells) => {
    const r = document.createElement('tr');
    cells.forEach((c) => { const td = document.createElement('td'); if (c instanceof Node) td.append(c); else td.textContent = c ?? ''; r.append(td); });
    table.append(r);
  });
}
function btn(label, fn, cls = 'ghost') { const b = document.createElement('button'); b.textContent = label; b.className = cls; b.onclick = fn; return b; }

async function load() {
  $('login').classList.add('hidden'); $('app').classList.remove('hidden');
  const s = await api('/stats');
  $('privacy').textContent = s.note;
  $('stats').replaceChildren(...[['Users', s.users], ['Active 7d', s.activeLast7d], ['Disabled', s.disabled], ['Requests', s.requests], ['Tool calls', s.toolCalls], ['Tool failures', s.toolFailures], ['Crop scans', s.scans], ['Products', s.products]]
    .map(([k, v]) => { const d = document.createElement('div'); d.className = 'card stat'; const b = document.createElement('b'); b.textContent = v; const t = document.createElement('span'); t.className = 'sub'; t.textContent = k; d.append(b, t); return d; }));

  const ai = await api('/ai');
  $('provider').value = ai.provider; $('model').value = ai.model;
  $('aiInfo').textContent = 'Keys configured on server — openai: ' + ai.configured.openai + ', anthropic: ' + ai.configured.anthropic + ', custom: ' + ai.configured.custom + '. Keys are never shown or editable here.';

  const u = await api('/users');
  fill($('users'), ['ID', 'Created', 'Last seen', 'Requests', 'Status', ''], u.users.map((x) => [x.id, x.createdAt, x.lastSeen, x.requests, x.disabled ? 'DISABLED' : 'active',
    btn(x.disabled ? 'Enable' : 'Disable', async () => { await api('/users/' + x.id + '/disabled', 'POST', { disabled: !x.disabled }); load(); }, x.disabled ? 'ghost' : 'danger')]));

  const p = await api('/products');
  fill($('products'), ['Name', 'Category', 'Unit', 'Price', 'Stock', ''], p.products.map((x) => [x.name, x.category, x.unit, x.price ?? 'unknown', x.inStock ? 'in stock' + (x.stockQty != null ? ' (' + x.stockQty + ')' : '') : 'out',
    btn('Toggle stock', async () => { await api('/products/' + x.id, 'PUT', { ...x, inStock: !x.inStock }); load(); }),
    btn('Delete', async () => { if (confirm('Delete ' + x.name + '?')) { await api('/products/' + x.id, 'DELETE'); load(); } }, 'danger')]));

  const n = await api('/agri-notes');
  fill($('notes'), ['Title', 'Note', ''], n.items.map((x) => [x.title, x.body, btn('Delete', async () => { await api('/agri-notes/' + x.id, 'DELETE'); load(); }, 'danger')]));

  const a = await api('/announcements');
  fill($('anns'), ['Title', 'Body', ''], a.items.map((x) => [x.title, x.body, btn('Delete', async () => { await api('/announcements/' + x.id, 'DELETE'); load(); }, 'danger')]));
}

function logout() { token = ''; sessionStorage.removeItem('adm'); $('app').classList.add('hidden'); $('login').classList.remove('hidden'); }

$('loginBtn').onclick = async () => {
  $('loginMsg').textContent = '';
  const r = await fetch('/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('u').value, password: $('p').value }) });
  if (!r.ok) { $('loginMsg').textContent = 'Sign-in failed.'; return; }
  token = (await r.json()).token; sessionStorage.setItem('adm', token); $('p').value = ''; load();
};
$('logout').onclick = logout;
$('saveAi').onclick = async () => { await api('/ai', 'PUT', { provider: $('provider').value, model: $('model').value }); load(); };
$('addProduct').onclick = async () => {
  const num = (id) => ($(id).value === '' ? null : Number($(id).value));
  await api('/products', 'POST', { name: $('pn').value, category: $('pc').value, unit: $('pu').value, description: $('pd').value, price: num('pp'), stockQty: num('pq'), inStock: $('ps').checked });
  ['pn', 'pc', 'pu', 'pd', 'pp', 'pq'].forEach((i) => ($(i).value = '')); load();
};
$('addNote').onclick = async () => { await api('/agri-notes', 'POST', { title: $('an').value, body: $('ab').value }); $('an').value = $('ab').value = ''; load(); };
$('addAnn').onclick = async () => { await api('/announcements', 'POST', { title: $('nt').value, body: $('nb').value }); $('nt').value = $('nb').value = ''; load(); };

if (token) load().catch(() => logout());
