// ==UserScript==
// @name         微博关注列表定律 Pro
// @namespace    https://weibo.com/
// @version      0.5.3
// @description  后台静默扫描关注列表并自动拉黑；支持关注/粉丝比例规则；在用户主页、评论区和关注列表注入一键拉黑按钮；支持种子库迁移与拉黑状态识别。
// @updateURL    https://raw.githubusercontent.com/HeLingQi/Tampermonkey/main/weibo_follow_law_pro.user.js
// @downloadURL  https://raw.githubusercontent.com/HeLingQi/Tampermonkey/main/weibo_follow_law_pro.user.js
// @match        https://weibo.com/*
// @match        https://www.weibo.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const DEF = {
    enabled: true,
    autoBlockScore: 1,
    defaultSeedWeight: 1,
    followFollowerRatioThreshold: 10,
    pageSize: 20,
    maxFollowPages: 100,
    requestDelayMin: 650,
    requestDelayMax: 1100,
    maxRateLimitRetries: 2,
    safeCacheTtl: 12 * 60 * 60 * 1000,
    blockedSyncTtl: 6 * 60 * 60 * 1000,
    goBackAfterBlock: true,
    maxHistory: 200
  };

  const K = {
    S: 'wflp_settings',
    SEEDS: 'wflp_seeds',
    FORCED: 'wflp_forced_seeds',
    AUTO: 'wflp_auto_blocked',
    BLOCKED: 'wflp_blocked_users',
    BLOCKED_SYNC_AT: 'wflp_blocked_sync_at',
    WL: 'wflp_whitelist',
    CACHE: 'wflp_safe_cache',
    HISTORY: 'wflp_history',
    VER: 'wflp_seed_version',
    INIT: 'wflp_initialized'
  };

  const st = {
    run: 0,
    href: '',
    profile: null,
    observer: null,
    profileInjecting: false,
    blacklistSyncing: null
  };

  const obj = (k, d = {}) => {
    const v = GM_getValue(k, d);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : d;
  };
  const arr = k => {
    const v = GM_getValue(k, []);
    return Array.isArray(v) ? v.map(String) : [];
  };
  const cfg = () => ({ ...DEF, ...obj(K.S) });
  const setCfg = patch => GM_setValue(K.S, { ...cfg(), ...patch });
  const seeds = () => obj(K.SEEDS);
  const forced = () => new Set(arr(K.FORCED));
  const auto = () => obj(K.AUTO);
  const blocked = () => obj(K.BLOCKED);
  const whitelist = () => new Set(arr(K.WL));
  const seedVer = () => Number(GM_getValue(K.VER, 0)) || 0;
  const bump = () => {
    GM_setValue(K.VER, seedVer() + 1);
    GM_setValue(K.CACHE, {});
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const jitter = () => {
    const c = cfg();
    return c.requestDelayMin + Math.random() * Math.max(0, c.requestDelayMax - c.requestDelayMin);
  };
  const cookie = name => {
    const row = document.cookie.split('; ').find(x => x.startsWith(name + '='));
    if (!row) return '';
    try { return decodeURIComponent(row.slice(name.length + 1)); }
    catch { return row.slice(name.length + 1); }
  };

  async function api(url, options = {}, run = null) {
    for (let i = 0; i <= cfg().maxRateLimitRetries; i++) {
      if (run !== null && run !== st.run) throw new Error('ROUTE_CHANGED');
      const res = await fetch(url, { credentials: 'include', ...options });
      let data = null;
      try { data = await res.clone().json(); } catch {}
      if (
        res.status === 418 ||
        res.status === 429 ||
        /频繁|too many|rate/i.test(String(data?.msg || data?.message || ''))
      ) {
        if (i >= cfg().maxRateLimitRetries) throw new Error('微博请求频率受限');
        await sleep(3000 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(data?.msg || data?.message || `HTTP ${res.status}`);
      if (data === null) throw new Error('接口未返回 JSON');
      return data;
    }
    throw new Error('请求失败');
  }

  function css() {
    if (document.getElementById('wflp-css')) return;
    const e = document.createElement('style');
    e.id = 'wflp-css';
    e.textContent = `
#wflp-toasts{position:fixed;top:76px;right:20px;z-index:2147483646;width:min(360px,calc(100vw - 32px));display:flex;flex-direction:column;gap:10px;pointer-events:none}
.wflp-toast{pointer-events:auto;background:rgba(255,255,255,.97);border:1px solid rgba(0,0,0,.08);box-shadow:0 12px 34px rgba(0,0,0,.14);border-radius:12px;padding:12px 14px;font:13px/1.55 system-ui;color:#222;opacity:0;transform:translateY(-8px);transition:.18s}.wflp-toast.show{opacity:1;transform:none}.wflp-toast b{display:block;font-size:14px}.wflp-toast small{display:block;color:#666;margin-top:2px}.wflp-toast.success{border-left:4px solid #18a058}.wflp-toast.error{border-left:4px solid #d03050}.wflp-toast.warning{border-left:4px solid #f0a020}
#wflp-modal{position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.32);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui}#wflp-modal .card{width:min(440px,100%);background:#fff;border-radius:16px;box-shadow:0 26px 80px rgba(0,0,0,.22);padding:22px;color:#222}#wflp-modal h3{margin:0 0 10px;font-size:18px}#wflp-modal p{white-space:pre-wrap;color:#5b616b;font-size:13px;line-height:1.7}#wflp-modal input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #d9dde4;border-radius:10px;font-size:14px;outline:none}#wflp-modal .err{min-height:20px;color:#d03050;font-size:12px;margin-top:5px}#wflp-modal .acts{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}#wflp-modal button{border-radius:9px;padding:8px 15px;cursor:pointer;font-weight:600;border:1px solid #ddd;background:#fff}#wflp-modal .ok{background:#ff8200;border-color:#ff8200;color:#fff}
.wflp-block{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;margin-left:8px;padding:0 12px;min-height:26px;border:1px solid #ff8200;border-radius:999px;background:#fff;color:#ff8200;font:500 12px/1 system-ui;cursor:pointer;vertical-align:middle;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}.wflp-block:hover:not([disabled]){background:#fff5eb}.wflp-block:active:not([disabled]){background:#ffead6}.wflp-block[disabled]{cursor:default}.wflp-block.is-blocked{border-color:#d9d9d9;background:#f5f5f5;color:#939393;opacity:1}.wflp-profile{min-width:88px;height:40px;padding:0 22px;border-radius:20px;font-size:16px}.wflp-follow{min-width:64px;height:30px;padding:0 14px;font-size:13px}.wflp-float{position:fixed;top:86px;right:24px;z-index:2147483000;box-shadow:0 6px 18px rgba(0,0,0,.08)}
@media(prefers-color-scheme:dark){.wflp-toast,#wflp-modal .card{background:#24262b;color:#eee}.wflp-toast small,#wflp-modal p{color:#b1b7c0}#wflp-modal input,#wflp-modal button{background:#1f2125;color:#eee;border-color:#454a52}.wflp-block{background:transparent}.wflp-block:hover:not([disabled]){background:rgba(255,130,0,.12)}.wflp-block.is-blocked{background:#33363b;border-color:#555b63;color:#9aa0a8}}
`;
    (document.head || document.documentElement).appendChild(e);
  }

  function toast(title, detail = '', type = 'info', ms = 3200) {
    if (!document.documentElement) return;
    css();
    let root = document.getElementById('wflp-toasts');
    if (!root) {
      root = document.createElement('div');
      root.id = 'wflp-toasts';
      document.documentElement.appendChild(root);
    }
    const el = document.createElement('div');
    el.className = `wflp-toast ${type}`;
    el.innerHTML = '<b></b><small></small>';
    el.querySelector('b').textContent = title;
    el.querySelector('small').textContent = detail;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 180);
    }, ms);
  }

  function modal({ title, message = '', input = false, value = '', confirmText = '确定', validate = null }) {
    return new Promise(resolve => {
      css();
      document.getElementById('wflp-modal')?.remove();
      const bg = document.createElement('div');
      bg.id = 'wflp-modal';
      bg.innerHTML = `<div class="card"><h3></h3><p></p>${input ? '<input>' : ''}<div class="err"></div><div class="acts"><button class="cancel">取消</button><button class="ok"></button></div></div>`;
      bg.querySelector('h3').textContent = title;
      bg.querySelector('p').textContent = message;
      bg.querySelector('.ok').textContent = confirmText;
      const field = bg.querySelector('input');
      if (field) field.value = value;
      const done = value => { bg.remove(); resolve(value); };
      bg.querySelector('.cancel').onclick = () => done(null);
      bg.querySelector('.ok').onclick = () => {
        const value = field ? field.value.trim() : true;
        const err = validate?.(value);
        if (err) return bg.querySelector('.err').textContent = err;
        done(value);
      };
      bg.onclick = event => { if (event.target === bg) done(null); };
      document.documentElement.appendChild(bg);
      field?.focus();
      field?.select();
    });
  }

  function profileHint() {
    const path = location.pathname.replace(/\/+$/, '');
    let m;
    if (
      (m = path.match(/^\/u\/(\d{5,})$/)) ||
      (m = path.match(/^\/(\d{5,})$/)) ||
      (m = path.match(/^\/p\/100505(\d{5,})$/))
    ) return { uid: m[1] };
    if ((m = path.match(/^\/n\/([^/]+)$/))) {
      let name = m[1];
      try { name = decodeURIComponent(name); } catch {}
      return { name };
    }
    return null;
  }

  async function resolveProfile(run = st.run) {
    const h = profileHint();
    if (!h) return null;
    const query = h.uid
      ? `uid=${encodeURIComponent(h.uid)}`
      : `screen_name=${encodeURIComponent(h.name)}`;
    try {
      const data = await api(`/ajax/profile/info?${query}`, {}, run);
      const user = data?.data?.user;
      if (user) {
        return {
          uid: String(user.idstr || user.id || h.uid || ''),
          name: String(user.screen_name || h.name || ''),
          following: Number(user.friends_count ?? 0),
          followers: Number(user.followers_count ?? 0),
          countsReliable: user.friends_count != null && user.followers_count != null
        };
      }
    } catch (e) {
      if (e.message === 'ROUTE_CHANGED') throw e;
    }
    return h.uid
      ? { uid: h.uid, name: '', following: null, followers: null, countsReliable: false }
      : null;
  }

  function myUid() {
    const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    for (const value of [w?.$CONFIG?.uid, w?.__INITIAL_STATE__?.config?.uid, w?.__INITIAL_STATE__?.loginUserInfo?.uid]) {
      const m = String(value || '').match(/\d{5,}/);
      if (m) return m[0];
    }
    return '';
  }

  const isSelf = () => [...document.querySelectorAll('button,a')]
    .some(x => /^(编辑个人资料|编辑资料)$/.test((x.textContent || '').trim()));
  const hasNext = value => !['', '0', 'false', 'null', 'undefined']
    .includes(String(value ?? '').trim().toLowerCase());

  function blockedUid(item) {
    const m = String(item?.scheme || '').match(/uid=(\d{5,})/);
    return m?.[1] || String(item?.user?.idstr || item?.user?.id || item?.uid || '');
  }

  function isKnownBlocked(uid) {
    uid = String(uid || '');
    if (!uid) return false;
    if (blocked()[uid] || auto()[uid]) return true;
    const seed = seeds()[uid];
    return !!seed && ['official', 'manual'].includes(String(seed.source || ''));
  }

  function markBlocked(uid, source = 'manual') {
    uid = String(uid || '');
    if (!uid) return;
    const map = blocked();
    map[uid] = { at: Date.now(), source };
    GM_setValue(K.BLOCKED, map);
    refreshBlockButtons(uid);
  }

  function setButtonState(btn, uid) {
    if (!btn) return;
    const yes = isKnownBlocked(uid);
    btn.disabled = yes;
    btn.textContent = yes ? '已拉黑' : '拉黑';
    btn.classList.toggle('is-blocked', yes);
  }

  function refreshBlockButtons(uid = '') {
    const selector = uid
      ? `.wflp-block[data-uid="${String(uid).replace(/"/g, '')}"]`
      : '.wflp-block[data-uid]';
    document.querySelectorAll(selector).forEach(btn => setButtonState(btn, btn.dataset.uid));
  }

  async function syncBlacklist() {
    if (st.blacklistSyncing) return st.blacklistSyncing;
    st.blacklistSyncing = (async () => {
      const old = seeds();
      const autoMap = auto();
      const forcedSet = forced();
      const official = new Set();

      for (let page = 1; page <= 500; page++) {
        const data = await api(`/ajax/setting/getFilteredUsers?page=${page}`);
        if (data?.ok !== 1 && data?.ok !== true) throw new Error(data?.msg || '官方黑名单接口失败');
        if (!Array.isArray(data.card_group)) throw new Error('官方黑名单响应异常');
        data.card_group.forEach(item => {
          const uid = blockedUid(item);
          if (uid) official.add(uid);
        });
        if (!data.card_group.length || !hasNext(data.next_cursor) || Number(data.total) === 0) break;
        await sleep(500);
      }

      const blockedIndex = {};
      const now = Date.now();
      official.forEach(uid => blockedIndex[uid] = { at: now, source: 'official' });
      GM_setValue(K.BLOCKED, blockedIndex);
      GM_setValue(K.BLOCKED_SYNC_AT, now);

      const nextSeeds = {};
      for (const uid of official) {
        if (autoMap[uid] && !forcedSet.has(uid)) continue;
        nextSeeds[uid] = {
          weight: Number(old[uid]?.weight || cfg().defaultSeedWeight),
          source: forcedSet.has(uid) ? (old[uid]?.source || 'forced') : 'official',
          name: old[uid]?.name || ''
        };
      }
      for (const uid of forcedSet) {
        nextSeeds[uid] = {
          weight: Number(old[uid]?.weight || cfg().defaultSeedWeight),
          source: old[uid]?.source || 'forced',
          name: old[uid]?.name || ''
        };
      }

      GM_setValue(K.SEEDS, nextSeeds);
      GM_setValue(K.INIT, true);
      bump();
      refreshBlockButtons();
      return nextSeeds;
    })();

    try { return await st.blacklistSyncing; }
    finally { st.blacklistSyncing = null; }
  }

  function refreshBlacklistIfStale() {
    const last = Number(GM_getValue(K.BLOCKED_SYNC_AT, 0)) || 0;
    if (Date.now() - last < cfg().blockedSyncTtl) return;
    syncBlacklist().catch(err => console.debug('[WFLP] blacklist refresh', err));
  }

  const ensureSeeds = () => GM_getValue(K.INIT, false)
    ? Promise.resolve(seeds())
    : syncBlacklist();

  async function scan(profile, seedMap, run) {
    const c = cfg();
    const threshold = Number(c.autoBlockScore);
    const following = Number(profile.following || 0);
    const pages = following > 0
      ? Math.min(Math.ceil(following / c.pageSize), c.maxFollowPages)
      : c.maxFollowPages;
    let score = 0;
    let scanned = 0;
    const hits = [];
    let complete = false;
    const seen = new Set();

    for (let page = 1; page <= pages; page++) {
      const data = await api(
        `/ajax/friendships/friends?uid=${encodeURIComponent(profile.uid)}&page=${page}&count=${c.pageSize}`,
        {},
        run
      );
      if (!Array.isArray(data?.users)) throw new Error('关注列表接口异常');
      if (!data.users.length) {
        complete = true;
        break;
      }
      for (const user of data.users) {
        const uid = String(user.idstr || user.id || '');
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        scanned++;
        if (!seedMap[uid]) continue;
        const weight = Math.max(0, Number(seedMap[uid].weight || c.defaultSeedWeight));
        score += weight;
        hits.push({ uid, name: user.screen_name || user.name || seedMap[uid].name || uid, weight });
        if (score >= threshold) return { blocked: true, score, scanned, hits, complete: false };
      }
      if (!hasNext(data.next_cursor) || data.users.length < c.pageSize) {
        complete = true;
        break;
      }
      await sleep(jitter());
    }
    if (following > pages * c.pageSize) complete = false;
    return { blocked: false, score, scanned, hits, complete };
  }

  async function doBlock(uid) {
    const token = cookie('XSRF-TOKEN');
    if (!token) throw new Error('无法读取 XSRF-TOKEN');
    const data = await api('/ajax/statuses/filterUser', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'x-xsrf-token': token,
        'x-requested-with': 'XMLHttpRequest'
      },
      body: JSON.stringify({ uid: Number(uid), status: 1, interact: 1, follow: 1 })
    });
    if (data?.ok !== 1 && data?.ok !== true) throw new Error(data?.msg || '微博未确认拉黑成功');
    return data;
  }

  function addSeed(uid, name = '', weight = 1, source = 'forced') {
    const map = seeds();
    map[uid] = { weight: Number(weight) || 1, source, name };
    GM_setValue(K.SEEDS, map);
    const forcedSet = forced();
    forcedSet.add(uid);
    GM_setValue(K.FORCED, [...forcedSet]);
    const autoMap = auto();
    if (autoMap[uid]) {
      delete autoMap[uid];
      GM_setValue(K.AUTO, autoMap);
    }
    GM_setValue(K.INIT, true);
    bump();
  }

  async function manualBlock(uid, name, btn) {
    if (!uid || btn?.disabled) return;
    if (myUid() === uid) return toast('已取消', '不能拉黑当前登录账号', 'warning');
    if (whitelist().has(uid)) return toast('已取消', '该用户在白名单中', 'warning');
    if (isKnownBlocked(uid)) {
      refreshBlockButtons(uid);
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = '处理中';
    }
    try {
      await doBlock(uid);
      addSeed(uid, name, cfg().defaultSeedWeight, 'manual');
      markBlocked(uid, 'manual');
      toast(`已拉黑 ${name ? '@' + name : uid}`, '已加入持久种子库', 'success');
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '拉黑';
      }
      toast('拉黑失败', String(e.message || e), 'error');
    }
  }

  function uidFromHref(href = '') {
    const m = href.match(/\/u\/(\d{5,})/) ||
      href.match(/weibo\.com\/(\d{5,})(?:[/?#]|$)/) ||
      href.match(/[?&]uid=(\d{5,})/);
    return m?.[1] || '';
  }

  function makeBtn(uid, name, cls = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `wflp-block ${cls}`;
    btn.dataset.uid = uid;
    setButtonState(btn, uid);
    btn.onclick = event => {
      event.preventDefault();
      event.stopPropagation();
      manualBlock(uid, name, btn);
    };
    return btn;
  }

  async function injectProfile() {
    if (!profileHint() || st.profileInjecting) return;
    st.profileInjecting = true;
    try {
      const profile = st.profile || await resolveProfile().catch(() => null);
      if (!profile?.uid || profile.uid === myUid() || isSelf()) return;
      css();
      const existing = [...document.querySelectorAll('.wflp-profile')];
      const same = existing.filter(btn => btn.dataset.uid === profile.uid);
      same.slice(1).forEach(btn => btn.remove());
      existing.filter(btn => btn.dataset.uid !== profile.uid).forEach(btn => btn.remove());
      if (same[0]?.isConnected) {
        setButtonState(same[0], profile.uid);
        return;
      }
      const candidates = [...document.querySelectorAll('button')]
        .filter(btn => /^(关注|已关注|私信|更多)$/.test((btn.textContent || '').trim()));
      const anchor = candidates.find(btn => btn.offsetParent);
      const btn = makeBtn(profile.uid, profile.name, 'wflp-profile');
      if (anchor?.parentElement) anchor.parentElement.appendChild(btn);
      else {
        btn.classList.add('wflp-float');
        document.documentElement.appendChild(btn);
      }
    } finally {
      st.profileInjecting = false;
    }
  }

  function injectComments(root = document) {
    css();
    const containers = root.querySelectorAll?.(
      '[data-comment-id], .wbpro-list .item1, [class*="Comment"] [class*="item"]'
    ) || [];
    containers.forEach(container => {
      const links = [...container.querySelectorAll('a[href]')];
      const author = links.find(link => uidFromHref(link.href) && (link.textContent || '').trim());
      if (!author) return;
      const uid = uidFromHref(author.href);
      const name = (author.textContent || '').trim().replace(/^@/, '');
      if (!uid || uid === myUid()) return;
      const existing = container.querySelector(`.wflp-block[data-uid="${uid}"]`);
      if (existing) {
        setButtonState(existing, uid);
        return;
      }
      author.insertAdjacentElement('afterend', makeBtn(uid, name));
    });
  }

  function followPageOwnerUid() {
    return location.pathname.match(/^\/u\/page\/follow\/(\d{5,})(?:\/|$)/)?.[1] || '';
  }
  const isFollowPage = () => !!followPageOwnerUid();

  function followUserNearControl(control) {
    const owner = followPageOwnerUid();
    let node = control.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const users = new Map();
      for (const link of node.querySelectorAll('a[href]')) {
        const uid = uidFromHref(link.href);
        const name = (link.textContent || '').trim().replace(/^@/, '');
        if (!uid || uid === owner || uid === myUid()) continue;
        if (!users.has(uid) || name) users.set(uid, { uid, name });
      }
      if (users.size === 1) return [...users.values()][0];
    }
    return null;
  }

  function injectFollowList(root = document) {
    if (!isFollowPage()) return;
    css();
    const controls = [];
    if (root?.nodeType === 1 && root.matches?.('button,a')) controls.push(root);
    if (root?.querySelectorAll) controls.push(...root.querySelectorAll('button,a'));
    controls.forEach(control => {
      const text = (control.textContent || '').trim();
      if (!/^(关注|已关注|互相关注|取消关注)$/.test(text) || !control.offsetParent) return;
      const user = followUserNearControl(control);
      if (!user?.uid) return;
      const existing = document.querySelector(`.wflp-follow[data-uid="${user.uid}"]`);
      if (existing) {
        setButtonState(existing, user.uid);
        return;
      }
      const btn = makeBtn(user.uid, user.name, 'wflp-follow');
      if (control.parentElement) control.insertAdjacentElement('afterend', btn);
    });
  }

  function observe() {
    if (st.observer || !document.documentElement) return;
    st.observer = new MutationObserver(mutations => mutations.forEach(mutation =>
      mutation.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        injectComments(node);
        injectFollowList(node);
        if (profileHint()) injectProfile();
      })
    ));
    st.observer.observe(document.documentElement, { childList: true, subtree: true });
    injectComments();
    injectFollowList();
    injectProfile();
  }

  function historyAdd(item) {
    let historyItems = GM_getValue(K.HISTORY, []);
    if (!Array.isArray(historyItems)) historyItems = [];
    historyItems.unshift({ at: Date.now(), ...item });
    historyItems.length = Math.min(historyItems.length, cfg().maxHistory);
    GM_setValue(K.HISTORY, historyItems);
  }

  function cacheSafe(profile, result) {
    if (!result.complete) return;
    const cache = obj(K.CACHE);
    cache[profile.uid] = {
      at: Date.now(),
      seedVersion: seedVer(),
      score: result.score,
      scanned: result.scanned
    };
    GM_setValue(K.CACHE, cache);
  }

  function cached(uid) {
    const item = obj(K.CACHE)[uid];
    return !!item &&
      item.seedVersion === seedVer() &&
      Date.now() - Number(item.at || 0) < cfg().safeCacheTtl;
  }

  function ratioRule(profile) {
    if (!profile?.countsReliable) return null;
    const following = Number(profile.following);
    const followers = Number(profile.followers);
    if (!Number.isFinite(following) || !Number.isFinite(followers) || following < 0 || followers < 0) return null;
    const threshold = Number(cfg().followFollowerRatioThreshold);
    const hit = following > followers * threshold;
    const ratio = followers === 0 ? (following > 0 ? Infinity : 0) : following / followers;
    return { hit, following, followers, ratio, threshold };
  }

  async function blockByRatio(profile, rule, run) {
    if (!rule?.hit || run !== st.run) return false;
    try {
      await doBlock(profile.uid);
      if (run !== st.run) return true;
      const autoMap = auto();
      autoMap[profile.uid] = {
        at: Date.now(),
        reason: 'follow_follower_ratio',
        following: rule.following,
        followers: rule.followers,
        ratio: Number.isFinite(rule.ratio) ? rule.ratio : null,
        threshold: rule.threshold
      };
      GM_setValue(K.AUTO, autoMap);
      markBlocked(profile.uid, 'ratio');
      historyAdd({
        decision: 'blocked',
        reason: 'follow_follower_ratio',
        uid: profile.uid,
        name: profile.name,
        following: rule.following,
        followers: rule.followers,
        ratio: Number.isFinite(rule.ratio) ? rule.ratio : null,
        threshold: rule.threshold
      });
      const ratioText = Number.isFinite(rule.ratio) ? `${rule.ratio.toFixed(1)} 倍` : '∞';
      toast(
        `已自动拉黑 ${profile.name ? '@' + profile.name : profile.uid}`,
        `关注 ${rule.following} / 粉丝 ${rule.followers} = ${ratioText}，超过 ${rule.threshold} 倍`,
        'success',
        4200
      );
      if (cfg().goBackAfterBlock) setTimeout(() => history.back(), 650);
      return true;
    } catch (e) {
      toast('关注/粉丝比例命中，但拉黑失败', String(e.message || e), 'error', 4500);
      return false;
    }
  }

  async function process(run) {
    if (!cfg().enabled) return;
    const profile = await resolveProfile(run);
    if (!profile || run !== st.run) return;
    st.profile = profile;
    injectProfile();

    if (profile.uid === myUid() || isSelf() || whitelist().has(profile.uid)) return;
    if (isKnownBlocked(profile.uid)) {
      refreshBlockButtons(profile.uid);
      return;
    }

    const ratio = ratioRule(profile);
    if (ratio?.hit) {
      await blockByRatio(profile, ratio, run);
      return;
    }

    if (cached(profile.uid)) return;

    let seedMap;
    try { seedMap = await ensureSeeds(); }
    catch (e) {
      console.error('[WFLP] seed', e);
      return;
    }
    if (run !== st.run || seedMap[profile.uid] || !Object.keys(seedMap).length) return;

    let result;
    try { result = await scan(profile, seedMap, run); }
    catch (e) {
      if (e.message !== 'ROUTE_CHANGED') console.error('[WFLP] scan', e);
      return;
    }
    if (run !== st.run) return;

    if (result.blocked) {
      try {
        await doBlock(profile.uid);
        const autoMap = auto();
        autoMap[profile.uid] = {
          at: Date.now(),
          reason: 'seed_risk_score',
          score: result.score,
          hits: result.hits.map(x => x.uid)
        };
        GM_setValue(K.AUTO, autoMap);
        markBlocked(profile.uid, 'risk');
        historyAdd({
          decision: 'blocked',
          reason: 'seed_risk_score',
          uid: profile.uid,
          name: profile.name,
          ...result
        });
        toast(
          `已自动拉黑 ${profile.name ? '@' + profile.name : profile.uid}`,
          `Risk Score ${result.score.toFixed(2)} · 扫描 ${result.scanned} 人 · 命中 ${result.hits.length} 人`,
          'success',
          4200
        );
        if (cfg().goBackAfterBlock) setTimeout(() => history.back(), 650);
      } catch (e) {
        toast('达到阈值，但拉黑失败', String(e.message || e), 'error', 4500);
      }
    } else {
      historyAdd({
        decision: result.complete ? 'safe' : 'incomplete',
        uid: profile.uid,
        name: profile.name,
        ...result
      });
      cacheSafe(profile, result);
    }
  }

  function route() {
    if (location.href === st.href) return;
    st.href = location.href;
    st.run++;
    st.profile = null;
    st.profileInjecting = false;
    document.querySelectorAll('.wflp-profile').forEach(btn => btn.remove());
    const run = st.run;
    if (cfg().enabled && profileHint()) {
      setTimeout(injectProfile, 120);
      setTimeout(() => process(run).catch(console.error), 300);
    }
    setTimeout(() => {
      injectComments();
      injectFollowList();
      refreshBlockButtons();
    }, 150);
  }

  function exportSeeds() {
    const data = {
      format: 'weibo-follow-law-pro-seeds',
      version: 1,
      exportedAt: new Date().toISOString(),
      seeds: seeds()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `weibo-follow-law-seeds-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return Object.keys(data.seeds).length;
  }

  function importSeeds() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.txt,application/json,text/plain';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        let incoming = {};
        try {
          const data = JSON.parse(text);
          incoming = data?.seeds && typeof data.seeds === 'object' ? data.seeds : data;
        } catch {
          text.split(/[\n,，]+/)
            .map(x => x.trim())
            .filter(x => /^\d{5,}$/.test(x))
            .forEach(uid => incoming[uid] = { weight: 1, name: '' });
        }
        const map = seeds();
        const forcedSet = forced();
        let count = 0;
        for (const [uid, value] of Object.entries(incoming || {})) {
          if (!/^\d{5,}$/.test(uid)) continue;
          map[uid] = {
            weight: Math.max(.01, Number(value?.weight || 1)),
            source: 'imported',
            name: String(value?.name || '')
          };
          forcedSet.add(uid);
          count++;
        }
        GM_setValue(K.SEEDS, map);
        GM_setValue(K.FORCED, [...forcedSet]);
        GM_setValue(K.INIT, true);
        bump();
        refreshBlockButtons();
        toast('种子黑名单导入完成', `导入 ${count} 个 · 当前 ${Object.keys(map).length} 个`, 'success');
      } catch (e) {
        toast('导入失败', String(e.message || e), 'error');
      }
    };
    input.click();
  }

  GM_registerMenuCommand('同步微博官方黑名单 → 种子库', async () => {
    try {
      const map = await syncBlacklist();
      toast('种子黑名单同步完成', `当前 ${Object.keys(map).length} 人`, 'success');
    } catch (e) {
      toast('同步失败', String(e.message || e), 'error');
    }
  });
  GM_registerMenuCommand('导出种子黑名单（迁移备份）', () =>
    toast('种子黑名单已导出', `共 ${exportSeeds()} 个种子`, 'success')
  );
  GM_registerMenuCommand('导入种子黑名单（迁移恢复）', importSeeds);
  GM_registerMenuCommand('设置 Risk Score 拉黑阈值', async () => {
    const value = await modal({
      title: '自动拉黑阈值',
      message: '1 = 命中一个普通种子即拉黑；2/3 更保守。',
      input: true,
      value: cfg().autoBlockScore,
      confirmText: '保存',
      validate: x => Number(x) > 0 ? '' : '请输入大于 0 的数字'
    });
    if (value !== null) {
      setCfg({ autoBlockScore: Number(value) });
      GM_setValue(K.CACHE, {});
      toast('设置已保存', `阈值 ${value}`, 'success');
    }
  });
  GM_registerMenuCommand('设置最大关注列表扫描页数', async () => {
    const value = await modal({
      title: '最大扫描页数',
      message: '每页约 20 人。',
      input: true,
      value: cfg().maxFollowPages,
      confirmText: '保存',
      validate: x => Number(x) >= 1 && Number(x) <= 500 ? '' : '请输入 1~500'
    });
    if (value !== null) {
      setCfg({ maxFollowPages: Math.floor(Number(value)) });
      GM_setValue(K.CACHE, {});
      toast('设置已保存', `最大 ${value} 页`, 'success');
    }
  });
  GM_registerMenuCommand('将当前用户设为重点种子', async () => {
    const profile = st.profile || await resolveProfile().catch(() => null);
    if (!profile?.uid) return toast('无法识别当前用户', '请进入用户主页', 'warning');
    const value = await modal({
      title: `重点种子 · ${profile.name ? '@' + profile.name : profile.uid}`,
      message: '1=普通，2=较高，3=重点。',
      input: true,
      value: 3,
      confirmText: '加入',
      validate: x => Number(x) > 0 ? '' : '请输入正数'
    });
    if (value !== null) {
      addSeed(profile.uid, profile.name, Number(value), 'forced');
      toast('重点种子已添加', `权重 ${value}`, 'success');
    }
  });
  GM_registerMenuCommand('将当前用户加入白名单', async () => {
    const profile = st.profile || await resolveProfile().catch(() => null);
    if (!profile?.uid) return;
    const set = whitelist();
    set.add(profile.uid);
    GM_setValue(K.WL, [...set]);
    toast('已加入白名单', profile.name || profile.uid, 'success');
  });
  GM_registerMenuCommand('查看插件统计', () => modal({
    title: '关注列表定律 Pro',
    message:
      `种子：${Object.keys(seeds()).length}\n` +
      `重点/持久种子：${forced().size}\n` +
      `自动拉黑：${Object.keys(auto()).length}\n` +
      `已知拉黑：${Object.keys(blocked()).length}\n` +
      `白名单：${whitelist().size}\n` +
      `Risk Score 阈值：${cfg().autoBlockScore}\n` +
      `关注/粉丝直拉阈值：>${cfg().followFollowerRatioThreshold} 倍`
  }));
  GM_registerMenuCommand(
    cfg().enabled ? '关闭关注列表定律 Pro' : '开启关注列表定律 Pro',
    () => {
      setCfg({ enabled: !cfg().enabled });
      location.reload();
    }
  );

  for (const method of ['pushState', 'replaceState']) {
    const raw = history[method];
    history[method] = function(...args) {
      const result = raw.apply(this, args);
      queueMicrotask(route);
      return result;
    };
  }
  addEventListener('popstate', route);
  addEventListener('hashchange', route);

  const start = () => {
    observe();
    route();
    refreshBlacklistIfStale();
    setInterval(() => {
      route();
      injectComments();
      injectFollowList();
      refreshBlockButtons();
      refreshBlacklistIfStale();
    }, 1200);
  };

  document.readyState === 'loading'
    ? addEventListener('DOMContentLoaded', start, { once: true })
    : start();
})();
