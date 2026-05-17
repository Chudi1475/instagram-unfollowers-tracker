'use strict';

const IG_APP_ID = '936619743392459';
const ASBD_ID = '129477';
const API = 'https://www.instagram.com/api/v1';

const baseHeaders = {
  'X-IG-App-ID': IG_APP_ID,
  'X-ASBD-ID': ASBD_ID,
  'Accept': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
};

const $ = id => document.getElementById(id);
const qsa = (s, root = document) => Array.from(root.querySelectorAll(s));

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function initialsOf(u) {
  const full = (u.fullName || u.full_name || '').trim();
  if (full) {
    const parts = full.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (u.username || '?').slice(0, 2).toUpperCase();
}

function pluralize(n, single, plural) {
  return n === 1 ? single : (plural || single + 's');
}

const storage = {
  get: keys => new Promise(r => chrome.storage.local.get(keys, r)),
  set: data => new Promise(r => chrome.storage.local.set(data, r)),
  remove: keys => new Promise(r => chrome.storage.local.remove(keys, r)),
};

async function getTrackedList() {
  return (await storage.get('tracked_list')).tracked_list || [];
}
async function setTrackedList(list) { await storage.set({ tracked_list: list }); }
async function getAccount(username) {
  const key = `acct:${username.toLowerCase()}`;
  return (await storage.get(key))[key] || null;
}
async function setAccount(account) {
  await storage.set({ [`acct:${account.canonical}`]: account });
}
async function removeAccount(username) {
  const canonical = username.toLowerCase();
  const list = await getTrackedList();
  await setTrackedList(list.filter(u => u !== canonical));
  await storage.remove(`acct:${canonical}`);
}

async function igFetch(url) {
  const res = await fetch(url, { headers: baseHeaders, credentials: 'include' });
  if (res.status === 429) throw new Error('Rate-limited by Instagram. Wait a few minutes.');
  if (res.status === 401) throw new Error('Not logged in. Log into instagram.com first.');
  if (res.status === 404) { const e = new Error('Not found.'); e.code = 404; throw e; }
  if (res.status === 403) throw new Error('Forbidden. Account may be private.');
  if (!res.ok) throw new Error(`Request failed (HTTP ${res.status}).`);
  return res.json();
}

async function fetchUser(username) {
  const json = await igFetch(`${API}/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  const user = json && json.data && json.data.user;
  if (!user) throw new Error('User not found.');
  return user;
}

async function userStillExists(username) {
  try {
    const res = await fetch(`${API}/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
      headers: baseHeaders, credentials: 'include'
    });
    if (res.status === 404) return false;
    if (!res.ok) return true;
    const json = await res.json();
    return !!(json && json.data && json.data.user);
  } catch {
    return true;
  }
}

async function fetchFriendList(userId, type, onProgress) {
  const all = [];
  const seen = new Set();
  let maxId = '';
  while (true) {
    const url = new URL(`${API}/friendships/${userId}/${type}/`);
    url.searchParams.set('count', '100');
    if (maxId) url.searchParams.set('max_id', maxId);
    const json = await igFetch(url.toString());
    const users = json.users || [];
    for (const u of users) {
      const id = String(u.pk);
      if (seen.has(id)) continue;
      seen.add(id);
      all.push({ id, username: u.username, fullName: u.full_name || '' });
    }
    onProgress && onProgress(all.length, type);
    if (!json.next_max_id) break;
    maxId = json.next_max_id;
  }
  return all;
}

async function pLimit(items, fn, concurrency = 4) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); }
      catch (e) { out[i] = { __error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

const viewStack = [{ view: 'home', params: {} }];
const currentView = () => viewStack[viewStack.length - 1];

function navigate(view, params = {}) {
  viewStack.push({ view, params });
  render();
}
function back() {
  if (viewStack.length > 1) { viewStack.pop(); render(); }
}
function resetToHome() {
  viewStack.length = 0;
  viewStack.push({ view: 'home', params: {} });
  render();
}

async function render() {
  qsa('.view').forEach(v => v.classList.add('hidden'));
  const { view, params } = currentView();
  $(`view-${view}`).classList.remove('hidden');
  if (view === 'home') await renderHome();
  else if (view === 'account') await renderAccount(params);
  else if (view === 'list') await renderList(params);
}

function showProgress(pct, text) {
  const p = $('progress');
  p.classList.remove('hidden');
  p.querySelector('.progress-bar').style.setProperty('--w', `${pct}%`);
  p.querySelector('.progress-text').textContent = text;
}
function hideProgress() { $('progress').classList.add('hidden'); }

function toast(msg, opts = {}) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!opts.error);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), opts.duration || 1700);
}

function showInlineError(containerId, msg) {
  $(containerId).innerHTML = `<div class="error">${escapeHtml(msg)}</div>`;
}
function clearInline(containerId) { $(containerId).innerHTML = ''; }

async function renderHome() {
  const list = await getTrackedList();
  const container = $('tracked-list');

  if (!list.length) {
    container.innerHTML = `<div class="tracked-empty">No accounts tracked yet. Search a username above to start.</div>`;
    return;
  }

  const accounts = (await Promise.all(list.map(u => getAccount(u)))).filter(Boolean);
  container.innerHTML = accounts.map(a => `
    <div class="tracked-item" data-username="${escapeHtml(a.canonical)}">
      <div class="name">@${escapeHtml(a.username)}</div>
      <div class="actions">
        <button class="action-btn primary" data-act="sync" title="Re-sync">Sync</button>
        <button class="action-btn danger" data-act="remove" title="Untrack">×</button>
      </div>
    </div>
  `).join('');

  qsa('#tracked-list .tracked-item').forEach(item => {
    const username = item.dataset.username;
    item.querySelector('[data-act="sync"]').addEventListener('click', e => {
      e.stopPropagation();
      syncTracked(username, e.currentTarget);
    });
    item.querySelector('[data-act="remove"]').addEventListener('click', e => {
      e.stopPropagation();
      removeTracked(username);
    });
    item.addEventListener('click', () => navigate('account', { username }));
  });
}

async function removeTracked(username) {
  if (!confirm(`Stop tracking @${username}? All stored data for this account will be deleted.`)) return;
  await removeAccount(username);
  render();
  toast(`Untracked @${username}`);
}

async function handleSearch() {
  clearInline('search-status');
  const raw = $('search-input').value.trim().replace(/^@/, '');
  if (!raw) return;
  const canonical = raw.toLowerCase();

  const existing = await getAccount(canonical);
  if (existing) {
    $('search-input').value = '';
    navigate('account', { username: canonical });
    return;
  }

  $('search-btn').disabled = true;
  try {
    showProgress(0, `Looking up @${raw}...`);
    const user = await fetchUser(raw);
    if (user.is_private && !user.followed_by_viewer) {
      throw new Error(`@${user.username} is private and you don't follow it.`);
    }
    await syncAccountData(user, true);
    $('search-input').value = '';
    hideProgress();
    navigate('account', { username: user.username.toLowerCase() });
    toast(`Tracking @${user.username}`);
  } catch (e) {
    hideProgress();
    showInlineError('search-status', e.message || 'Search failed.');
  } finally {
    $('search-btn').disabled = false;
  }
}

async function syncTracked(username, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    const user = await fetchUser(username);
    await syncAccountData(user, false);
    hideProgress();
    if (currentView().view === 'home') render();
    toast(`Synced @${user.username}`);
  } catch (e) {
    hideProgress();
    toast(e.message || 'Sync failed', { error: true, duration: 2500 });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sync'; }
  }
}

async function syncFromDetail(username) {
  const view = $('view-account');
  const syncBtn = view.querySelector('[data-sync]');
  const lastSync = view.querySelector('.last-sync');
  if (syncBtn) { syncBtn.disabled = true; syncBtn.textContent = 'Syncing...'; }
  if (lastSync) lastSync.textContent = 'Syncing...';

  try {
    const user = await fetchUser(username);
    await syncAccountData(user, false);
    hideProgress();
    await render();
    toast(`Synced @${user.username}`);
  } catch (e) {
    hideProgress();
    toast(e.message || 'Sync failed', { error: true, duration: 2500 });
    if (syncBtn) { syncBtn.disabled = false; syncBtn.textContent = 'Sync now'; }
  }
}

async function syncAccountData(user, isInitial) {
  const expF = (user.edge_followed_by && user.edge_followed_by.count) || 0;
  const expG = (user.edge_follow && user.edge_follow.count) || 0;
  const total = expF + expG;

  let doneF = 0, doneG = 0;
  const onP = (n, type) => {
    if (type === 'followers') doneF = n; else doneG = n;
    const pct = total ? Math.min(96, Math.round((doneF + doneG) / total * 96)) : 0;
    showProgress(pct, `${doneF.toLocaleString()}/${expF.toLocaleString()} followers · ${doneG.toLocaleString()}/${expG.toLocaleString()} following`);
  };

  showProgress(0, `Fetching @${user.username}...`);

  const [followers, following] = await Promise.all([
    fetchFriendList(user.id, 'followers', onP),
    fetchFriendList(user.id, 'following', onP),
  ]);

  const canonical = user.username.toLowerCase();
  const existing = await getAccount(canonical);
  const now = Date.now();

  let recent = { unfollowers: [], blocked: [], newFollowers: [], youUnfollowed: [] };
  let history = { unfollowers: [], blocked: [] };

  if (existing && !isInitial) {
    const oldFollowerIds = new Set(existing.followers.map(u => u.id));
    const oldFollowingIds = new Set(existing.following.map(u => u.id));
    const newFollowerIds = new Set(followers.map(u => u.id));
    const newFollowingIds = new Set(following.map(u => u.id));

    const lostFollowers = existing.followers.filter(u => !newFollowerIds.has(u.id));
    const gainedFollowers = followers.filter(u => !oldFollowerIds.has(u.id));
    const lostFollowing = existing.following.filter(u => !newFollowingIds.has(u.id));

    let checked = 0;
    const checks = await pLimit(lostFollowers, async (u) => {
      const exists = await userStillExists(u.username);
      checked++;
      showProgress(97, `Detecting blocks ${checked}/${lostFollowers.length}...`);
      return { user: u, exists };
    }, 4);

    const unfollowers = [];
    const blocked = [];
    for (const r of checks) {
      if (r.__error) continue;
      if (r.exists) unfollowers.push({ ...r.user, date: now });
      else blocked.push({ ...r.user, date: now });
    }

    recent = {
      unfollowers,
      blocked,
      newFollowers: gainedFollowers.map(u => ({ ...u, date: now })),
      youUnfollowed: lostFollowing.map(u => ({ ...u, date: now })),
    };

    history = {
      unfollowers: [...(existing.recent && existing.recent.unfollowers || []), ...(existing.history && existing.history.unfollowers || [])],
      blocked: [...(existing.recent && existing.recent.blocked || []), ...(existing.history && existing.history.blocked || [])],
    };
  }

  showProgress(100, `Saved.`);

  const account = {
    canonical,
    username: user.username,
    fullName: user.full_name || '',
    profilePicUrl: user.profile_pic_url || '',
    isPrivate: !!user.is_private,
    isVerified: !!user.is_verified,
    followersCount: expF,
    followingCount: expG,
    lastSync: now,
    followers: followers.map(u => ({ id: u.id, username: u.username, fullName: u.fullName })),
    following: following.map(u => ({ id: u.id, username: u.username, fullName: u.fullName })),
    recent,
    history,
  };

  await setAccount(account);

  const list = await getTrackedList();
  if (!list.includes(canonical)) {
    list.unshift(canonical);
    await setTrackedList(list);
  }

  return account;
}

async function renderAccount({ username }) {
  const account = await getAccount(username);
  if (!account) { resetToHome(); return; }

  const followerIds = new Set(account.followers.map(u => u.id));
  const followingIds = new Set(account.following.map(u => u.id));
  const dontFollowBack = account.following.filter(u => !followerIds.has(u.id));
  const youDontFollowBack = account.followers.filter(u => !followingIds.has(u.id));

  const stats = [
    { id: 'unfollowers',       label: 'Unfollowers',           count: account.recent.unfollowers.length },
    { id: 'dontFollowBack',    label: "Don't Follow Back",     count: dontFollowBack.length },
    { id: 'blocked',           label: 'Blocked You',           count: account.recent.blocked.length },
    { id: 'youDontFollowBack', label: "You Don't Follow Back", count: youDontFollowBack.length },
    { id: 'newFollowers',      label: 'New Followers',         count: account.recent.newFollowers.length },
    { id: 'youUnfollowed',     label: 'You Unfollowed',        count: account.recent.youUnfollowed.length },
  ];

  const recentCount =
    account.recent.unfollowers.length +
    account.recent.blocked.length +
    account.recent.newFollowers.length;

  const view = $('view-account');
  view.innerHTML = `
    <header class="detail-header">
      <button class="back-btn" data-back>← Back</button>
      <div class="sync-info">
        <span class="last-sync">Last sync: ${formatDate(account.lastSync)}</span>
        <button class="sync-btn" data-sync>Sync now</button>
      </div>
    </header>
    <div class="account-info">
      <div class="username">@${escapeHtml(account.username)}</div>
      <div class="counts"><strong>${account.followersCount.toLocaleString()}</strong> followers · <strong>${account.followingCount.toLocaleString()}</strong> following</div>
    </div>
    <div class="recent-updates">
      <h3>Recent Updates (${recentCount})</h3>
      <div class="stat-grid">
        ${stats.map(s => `
          <div class="stat-card" data-stat="${s.id}">
            <div class="value">${s.count}</div>
            <div class="label">${escapeHtml(s.label)}</div>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="tracked-badge">Tracked</div>
  `;

  view.querySelector('[data-back]').addEventListener('click', back);
  view.querySelector('[data-sync]').addEventListener('click', () => syncFromDetail(username));
  view.querySelectorAll('.stat-card').forEach(card => {
    card.addEventListener('click', () => navigate('list', { username, stat: card.dataset.stat }));
  });
}

async function renderList({ username, stat }) {
  const account = await getAccount(username);
  if (!account) { resetToHome(); return; }

  const followerIds = new Set(account.followers.map(u => u.id));
  const followingIds = new Set(account.following.map(u => u.id));

  const config = {
    unfollowers: {
      title: 'Unfollowers',
      recent: account.recent.unfollowers,
      older: account.history.unfollowers,
      recentLabelSingular: 'unfollower',
      olderTitle: 'Older unfollowers',
    },
    blocked: {
      title: 'Blocked You',
      recent: account.recent.blocked,
      older: account.history.blocked,
      recentLabelSingular: 'user blocked you',
      recentLabelPlural: 'users blocked you',
      hint: 'Inferred when a former follower\'s profile is no longer reachable (could also indicate deactivation).',
      olderTitle: 'Older blocked',
    },
    newFollowers: {
      title: 'New Followers',
      recent: account.recent.newFollowers,
      recentLabelSingular: 'new follower',
    },
    youUnfollowed: {
      title: 'You Unfollowed',
      recent: account.recent.youUnfollowed,
      recentLabelSingular: 'account you unfollowed',
      recentLabelPlural: 'accounts you unfollowed',
    },
    dontFollowBack: {
      title: "Don't Follow Back",
      flat: account.following.filter(u => !followerIds.has(u.id)),
      description: "Accounts they follow that don't follow them back.",
    },
    youDontFollowBack: {
      title: "You Don't Follow Back",
      flat: account.followers.filter(u => !followingIds.has(u.id)),
      description: "Accounts that follow them that they don't follow back.",
    },
  };

  const c = config[stat];
  if (!c) { back(); return; }

  let body = '';
  let allUsers = [];

  if (c.flat) {
    allUsers = c.flat;
    body = `
      ${c.description ? `<p class="list-description">${escapeHtml(c.description)}</p>` : ''}
      ${renderUserList(c.flat, 'No users.')}
    `;
  } else {
    const recentN = c.recent.length;
    const olderN = (c.older || []).length;
    const recentLabel = pluralize(recentN, c.recentLabelSingular, c.recentLabelPlural);
    allUsers = [...c.recent, ...(c.older || [])];
    const negClass = ['unfollowers', 'blocked'].includes(stat) ? ' negative' : '';

    body = `
      ${c.hint ? `<p class="list-description">${escapeHtml(c.hint)}</p>` : ''}
      <div class="list-section">
        <div class="list-section-title${negClass}"><span class="accent">${recentN}</span> ${escapeHtml(recentLabel)} since last sync</div>
        ${renderUserList(c.recent, 'No results.')}
      </div>
      ${c.older ? `
        <div class="list-section">
          <div class="list-section-title older">${escapeHtml(c.olderTitle)} (${olderN})</div>
          ${renderUserList(c.older, 'No results.')}
        </div>
      ` : ''}
    `;
  }

  const view = $('view-list');
  view.innerHTML = `
    <header class="detail-header">
      <button class="back-btn" data-back>← Back</button>
      <div class="sync-info">
        <span class="last-sync">Last sync: ${formatDate(account.lastSync)}</span>
      </div>
    </header>
    <div class="account-info">
      <div class="username">@${escapeHtml(account.username)}</div>
      <div class="counts"><strong>${account.followersCount.toLocaleString()}</strong> followers · <strong>${account.followingCount.toLocaleString()}</strong> following</div>
      <button class="copy-btn" data-copy>Copy all usernames</button>
    </div>
    ${body}
  `;

  view.querySelector('[data-back]').addEventListener('click', back);
  view.querySelector('[data-copy]').addEventListener('click', e => copyUsernames(allUsers, e.currentTarget));
}

function renderUserList(users, emptyMsg) {
  if (!users || !users.length) {
    return `<div class="user-list"><div class="empty-list">${escapeHtml(emptyMsg)}</div></div>`;
  }
  return `
    <div class="user-list">
      ${users.map(u => {
        const name = escapeHtml(u.username);
        const full = escapeHtml(u.fullName || u.full_name || '');
        const date = u.date ? formatDate(u.date) : '';
        const initials = escapeHtml(initialsOf(u));
        return `
          <div class="user-item">
            <div class="avatar">${initials}</div>
            <div class="user-info">
              <a href="https://www.instagram.com/${name}/" target="_blank" rel="noopener noreferrer">@${name}</a>
              ${full ? `<div class="full-name">${full}</div>` : ''}
            </div>
            ${date ? `<div class="user-date">${date}</div>` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

async function copyUsernames(users, btn) {
  if (!users.length) { toast('Nothing to copy'); return; }
  const text = users.map(u => '@' + u.username).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('copied');
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.textContent = 'Copy all usernames';
    }, 1500);
    toast(`Copied ${users.length} username${users.length === 1 ? '' : 's'}`);
  } catch {
    toast('Copy failed', { error: true });
  }
}

function init() {
  $('search-btn').addEventListener('click', handleSearch);
  $('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSearch();
  });
  render();
}

init();
