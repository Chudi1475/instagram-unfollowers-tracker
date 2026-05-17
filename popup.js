'use strict';

const IG_APP_ID = '936619743392459';
const ASBD_ID = '129477';
const API = 'https://www.instagram.com/api/v1';

const headers = {
  'X-IG-App-ID': IG_APP_ID,
  'X-ASBD-ID': ASBD_ID,
  'Accept': 'application/json',
  'X-Requested-With': 'XMLHttpRequest',
};

const $ = id => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function initialsOf(u) {
  const full = (u.fullName || '').trim();
  if (full) {
    const parts = full.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (u.username || '?').slice(0, 2).toUpperCase();
}

async function igFetch(url) {
  const res = await fetch(url, { headers, credentials: 'include' });
  if (res.status === 429) throw new Error('Rate-limited by Instagram. Wait a few minutes.');
  if (res.status === 401) throw new Error('Not logged in. Log into instagram.com first.');
  if (res.status === 404) throw new Error('User not found.');
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

function showProgress(pct, text) {
  const p = $('progress');
  p.classList.remove('hidden');
  p.querySelector('.progress-bar').style.setProperty('--w', `${pct}%`);
  p.querySelector('.progress-text').textContent = text;
}
function hideProgress() { $('progress').classList.add('hidden'); }

function setStatusHtml(html) { $('status').innerHTML = html; }
function showError(msg) { setStatusHtml(`<div class="error">${escapeHtml(msg)}</div>`); }
function clearStatus() { $('status').innerHTML = ''; }

function toast(msg, opts = {}) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', !!opts.error);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), opts.duration || 1700);
}

function renderResult(user, dontFollowBack, followersCount, followingCount) {
  const username = escapeHtml(user.username);
  const list = dontFollowBack.length
    ? `<div class="user-list">${dontFollowBack.map(u => `
        <div class="user-item">
          <div class="avatar">${escapeHtml(initialsOf(u))}</div>
          <div class="user-info">
            <a href="https://www.instagram.com/${escapeHtml(u.username)}/" target="_blank" rel="noopener noreferrer">@${escapeHtml(u.username)}</a>
            ${u.fullName ? `<div class="full-name">${escapeHtml(u.fullName)}</div>` : ''}
          </div>
        </div>
      `).join('')}</div>`
    : `<div class="user-list"><div class="empty-list">Everyone @${username} follows follows them back.</div></div>`;

  $('results').innerHTML = `
    <div class="result-card">
      <div class="account-info">
        <div class="username">@${username}</div>
        <div class="counts"><strong>${followersCount.toLocaleString()}</strong> followers · <strong>${followingCount.toLocaleString()}</strong> following</div>
      </div>
      <div class="stat-banner">
        <div class="stat-value">${dontFollowBack.length.toLocaleString()}</div>
        <div class="stat-label">don't follow back</div>
      </div>
      ${dontFollowBack.length ? `<button class="copy-btn" id="copy-btn">Copy all usernames</button>` : ''}
    </div>
    ${list}
  `;

  const copyBtn = $('copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = dontFollowBack.map(u => '@' + u.username).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.classList.add('copied');
        copyBtn.textContent = 'Copied!';
        toast(`Copied ${dontFollowBack.length} username${dontFollowBack.length === 1 ? '' : 's'}`);
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          copyBtn.textContent = 'Copy all usernames';
        }, 1500);
      } catch {
        toast('Copy failed', { error: true });
      }
    });
  }
}

async function check(username) {
  $('search-btn').disabled = true;
  clearStatus();
  $('results').innerHTML = '';
  hideProgress();

  try {
    showProgress(0, `Looking up @${username}...`);
    const user = await fetchUser(username);

    if (user.is_private && !user.followed_by_viewer) {
      throw new Error(`@${user.username} is private and you don't follow it.`);
    }

    const expF = (user.edge_followed_by && user.edge_followed_by.count) || 0;
    const expG = (user.edge_follow && user.edge_follow.count) || 0;
    const total = expF + expG;

    let doneF = 0, doneG = 0;
    const onP = (n, type) => {
      if (type === 'followers') doneF = n; else doneG = n;
      const pct = total ? Math.min(99, Math.round((doneF + doneG) / total * 99)) : 0;
      showProgress(pct, `${doneF.toLocaleString()}/${expF.toLocaleString()} followers · ${doneG.toLocaleString()}/${expG.toLocaleString()} following`);
    };

    showProgress(1, `Fetching @${user.username}...`);

    const t0 = performance.now();
    const [followers, following] = await Promise.all([
      fetchFriendList(user.id, 'followers', onP),
      fetchFriendList(user.id, 'following', onP),
    ]);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

    const followerIds = new Set(followers.map(u => u.id));
    const dontFollowBack = following.filter(u => !followerIds.has(u.id));

    showProgress(100, `Done in ${elapsed}s`);
    setTimeout(hideProgress, 700);

    renderResult(user, dontFollowBack, followers.length, following.length);
    chrome.storage.local.set({ lastUsername: username });
  } catch (e) {
    hideProgress();
    showError(e.message || 'Failed.');
  } finally {
    $('search-btn').disabled = false;
  }
}

function init() {
  $('search-btn').addEventListener('click', () => {
    const u = $('search-input').value.trim().replace(/^@/, '');
    if (u) check(u);
  });
  $('search-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('search-btn').click();
  });

  chrome.storage.local.get('lastUsername', d => {
    if (d.lastUsername) {
      $('search-input').value = d.lastUsername;
      $('search-input').select();
    }
  });
}

init();
