const $ = id => document.getElementById(id);
const num = value => Number(value).toLocaleString('en-US');
let keys = [], selected = null, renaming = false, loggedIn = false, clockOffset = 0, timezone = 'UTC', toastTimer;
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 3500); }
function showLogin() { loggedIn = false; $('login').hidden = false; $('dashboard').hidden = true; $('logout').hidden = true; $('settings').hidden = true; document.querySelectorAll('dialog[open]').forEach(d => d.close()); $('secret').value = ''; }
async function api(path, method = 'GET', body) {
  const res = await fetch('/admin/api/' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) { if (res.status === 401 && path !== 'login') showLogin(); throw new Error(data.error || 'Request failed'); }
  return data;
}
async function busy(form, work) {
  const button = form.querySelector('button[type="submit"]');
  const error = form.querySelector('.error'); if (error) error.textContent = '';
  button.disabled = true;
  try { await work(); } catch (e) { if (error) error.textContent = e.message; else $('page-error').textContent = e.message; }
  finally { button.disabled = false; }
}
function openDialog(id) { const d = $(id); const error = d.querySelector('.error'); if (error) error.textContent = ''; d.showModal(); }
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
$('secret-dialog').addEventListener('close', () => { $('secret').value = ''; $('copy-status').textContent = ''; });
$('login-form').addEventListener('submit', e => { e.preventDefault(); busy(e.currentTarget, async () => { await api('login', 'POST', { password: $('password').value }); $('password').value = ''; await refresh(); }); });
$('logout').addEventListener('click', async () => { try { await api('logout', 'POST', {}); showLogin(); } catch (e) { toast(e.message); } });
function time(ms) { return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms); }
function renderKeys() {
  const container = $('keys'); container.replaceChildren();
  const visible = keys.filter(k => k.state !== 'revoked');
  if (!visible.length) container.append(node('div', 'No API keys yet. Create a key to get started.', 'empty'));
  visible.forEach(key => {
    const active = key.state === 'open' && (key.expires_at === null || key.expires_at > Date.now() + clockOffset);
    const card = node('article', undefined, 'card'), head = node('div', undefined, 'card-head'), identity = node('div');
    identity.append(node('div', key.name, 'key-name'), node('div', '•••• ' + key.suffix, 'suffix'));
    head.append(identity, node('span', active ? (key.expires_at ? 'Timed access' : 'Always enabled') : 'Disabled', 'badge' + (active ? key.expires_at ? ' timed' : ' open' : '')));
    const status = !active ? 'New requests are blocked' : key.expires_at ? 'Remaining: ' + Math.max(1, Math.ceil((key.expires_at - Date.now() - clockOffset) / 60000)) + ' min · expires ' + time(key.expires_at) : 'Until you disable this key';
    card.append(head, node('p', status), node('div', key.last_used_at ? 'Last request: ' + time(key.last_used_at) : 'Not used yet', 'muted'));
    const actions = node('div', undefined, 'actions');
    function action(label, cls, fn) { const b = node('button', label, cls); b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (e) { toast(e.message); } finally { b.disabled = false; } }); actions.append(b); }
    const showOpen = () => { selected = key; $('open-title').textContent = 'Enable · ' + key.name; document.querySelector('[name="mode"][value="forever"]').checked = true; $('duration-box').hidden = true; $('duration').value = '3'; $('unit').value = '60'; openDialog('open-dialog'); };
    if (active) { action('Disable', 'small danger', async () => { await api('keys/' + key.id, 'PATCH', { action: 'pause' }); await refresh(); toast('Key disabled and active requests interrupted'); }); action('Adjust access', 'small', showOpen); }
    else action('Enable', 'small primary', showOpen);
    action('Rename', 'small text-button', () => { selected = key; renaming = true; $('name-title').textContent = 'Rename key'; $('key-name').value = key.name; $('create-hint').hidden = true; openDialog('name-dialog'); });
    action('Revoke', 'small text-button', () => { selected = key; $('revoke-name').textContent = key.name; openDialog('revoke-dialog'); });
    card.append(actions); container.append(card);
  });
}
$('create').addEventListener('click', () => { renaming = false; $('name-title').textContent = 'Create key'; $('key-name').value = ''; $('create-hint').hidden = false; openDialog('name-dialog'); });
$('name-form').addEventListener('submit', e => { e.preventDefault(); busy(e.currentTarget, async () => {
  const name = $('key-name').value.trim();
  if (renaming) { await api('keys/' + selected.id, 'PATCH', { action: 'rename', name }); $('name-dialog').close(); }
  else { const data = await api('keys', 'POST', { name }); $('name-dialog').close(); $('secret').value = data.token; openDialog('secret-dialog'); }
  await refresh();
}); });
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('secret').value); $('copy-status').textContent = 'Copied'; } catch { $('secret').focus(); $('secret').select(); $('copy-status').textContent = 'Press and hold, or use Ctrl/Cmd+C to copy the selected key.'; } });
document.querySelectorAll('[name="mode"]').forEach(r => r.addEventListener('change', () => $('duration-box').hidden = r.value !== 'timed'));
document.querySelectorAll('[data-minutes]').forEach(b => b.addEventListener('click', () => { const minutes = Number(b.dataset.minutes); $('unit').value = minutes % 60 ? '1' : '60'; $('duration').value = String(minutes / Number($('unit').value)); }));
$('open-form').addEventListener('submit', e => { e.preventDefault(); busy(e.currentTarget, async () => {
  const timed = document.querySelector('[name="mode"]:checked').value === 'timed';
  const durationMinutes = timed ? Number($('duration').value) * Number($('unit').value) : null;
  if (timed && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 525600)) throw new Error('Enter a duration between 1 minute and 365 days');
  await api('keys/' + selected.id, 'PATCH', { action: 'open', durationMinutes }); $('open-dialog').close(); await refresh(); toast('Key enabled');
}); });
$('revoke-form').addEventListener('submit', e => { e.preventDefault(); busy(e.currentTarget, async () => { await api('keys/' + selected.id, 'PATCH', { action: 'revoke' }); $('revoke-dialog').close(); await refresh(); toast('Key permanently revoked'); }); });
function row(values, numberFrom) { const tr = node('tr'); values.forEach((v, i) => tr.append(node('td', v, i >= numberFrom ? 'number' : ''))); return tr; }
let usageVersion = 0;
async function loadUsage() {
  const version = ++usageVersion;
  const q = new URLSearchParams({ from: $('from').value, to: $('to').value, keyId: $('key-filter').value, model: $('model-filter').value.trim() });
  const data = await api('usage?' + q);
  if (version !== usageVersion) return;
  let input = 0, output = 0, unknown = 0, pending = 0;
  $('usage').replaceChildren();
  if (!$('model-filter').value.trim()) { $('model-options').replaceChildren(); for (const name of [...new Set(data.rows.map(r => r.model))].sort()) $('model-options').append(new Option(name, name)); }
  for (const r of data.rows) {
    input += r.input_tokens; output += r.output_tokens; unknown += r.unknown; pending += r.pending;
    $('usage').append(row([r.day, r.name, r.provider + ' / ' + r.model, num(r.input_tokens), num(r.output_tokens), num(r.input_tokens + r.output_tokens), num(r.unknown)], 3));
  }
  $('input').textContent = num(input); $('output').textContent = num(output); $('total').textContent = num(input + output);
  if (!data.rows.length) { const tr = node('tr'), td = node('td', 'No requests in the selected date range', 'muted'); td.colSpan = 7; tr.append(td); $('usage').append(tr); }
  $('usage-notice').hidden = !unknown && !pending;
  $('usage-notice').textContent = [unknown ? unknown + ' requests have unknown usage. Actual consumption may exceed the recorded total.' : '', pending ? pending + ' requests in progress.' : ''].filter(Boolean).join(' ');
}
$('filters').addEventListener('submit', async e => { e.preventDefault(); $('page-error').textContent = ''; try { await loadUsage(); } catch (e) { $('page-error').textContent = e.message; } });
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = await api('keys'); keys = data.keys; timezone = data.timezone; clockOffset = data.now - Date.now();
    loggedIn = true; $('login').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false; $('settings').hidden = false; $('setup-notice').hidden = data.providersConfigured;
    $('timezone').textContent = 'Timezone: ' + timezone + '. Requests are grouped by their start date.';
    if (!$('from').value) $('from').value = data.today; if (!$('to').value) $('to').value = data.today;
    const previous = $('key-filter').value; $('key-filter').replaceChildren(new Option('All keys', ''));
    keys.forEach(k => $('key-filter').add(new Option(k.name + (k.state === 'revoked' ? ' (revoked)' : ''), k.id))); $('key-filter').value = previous;
    renderKeys(); await loadUsage(); $('page-error').textContent = '';
  } finally { refreshing = false; }
}
refresh().catch(e => { if (loggedIn) $('page-error').textContent = e.message; else { showLogin(); if (e.message !== 'Please sign in') $('page-error').textContent = e.message; } });
setInterval(() => { if (loggedIn && !document.hidden) refresh().catch(e => { if (loggedIn) $('page-error').textContent = 'Refresh failed: ' + e.message; }); }, 5000);

$('settings').addEventListener('click', async () => {
  const button = $('settings'); button.disabled = true;
  try {
    const data = await api('settings');
    for (const provider of ['openai', 'anthropic']) {
      $(provider + '-url').value = data[provider].baseUrl;
      $(provider + '-key').value = '';
      $(provider + '-clear').checked = false;
      $(provider + '-status').textContent = data[provider].configured ? 'Configured' : 'Not configured';
    }
    $('anthropic-version').value = data.anthropic.version;
    $('settings-timezone').value = data.timezone;
    $('flush-minutes').value = String(data.usageFlushMinutes);
    openDialog('settings-dialog');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('settings-dialog').addEventListener('close', () => { $('openai-key').value = ''; $('anthropic-key').value = ''; });
$('settings-form').addEventListener('submit', e => {
  e.preventDefault();
  busy(e.currentTarget, async () => {
    const payload = { timezone: $('settings-timezone').value.trim(), usageFlushMinutes: Number($('flush-minutes').value) };
    for (const provider of ['openai', 'anthropic']) {
      if ($(provider + '-clear').checked && $(provider + '-key').value) throw new Error('Choose either a new API key or removal, not both.');
      payload[provider] = { baseUrl: $(provider + '-url').value.trim(), apiKey: $(provider + '-clear').checked ? null : $(provider + '-key').value };
    }
    payload.anthropic.version = $('anthropic-version').value.trim();
    await api('settings', 'PATCH', payload);
    $('settings-dialog').close();
    await refresh(); toast('Settings saved');
  });
});
