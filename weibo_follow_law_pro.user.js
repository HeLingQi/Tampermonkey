// ==UserScript==
// @name         微博关注列表定律 Pro
// @namespace    https://weibo.com/
// @version      0.5.0
// @description  后台静默扫描关注列表并自动拉黑；在用户主页和微博评论区注入一键拉黑按钮；支持种子库导入导出。
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
    pageSize: 20,
    maxFollowPages: 100,
    requestDelayMin: 650,
    requestDelayMax: 1100,
    maxRateLimitRetries: 2,
    safeCacheTtl: 12 * 60 * 60 * 1000,
    goBackAfterBlock: true,
    maxHistory: 200
  };

  const K = {
    S: 'wflp_settings', SEEDS: 'wflp_seeds', FORCED: 'wflp_forced_seeds',
    AUTO: 'wflp_auto_blocked', WL: 'wflp_whitelist', CACHE: 'wflp_safe_cache',
    HISTORY: 'wflp_history', VER: 'wflp_seed_version', INIT: 'wflp_initialized'
  };

  const st = { run: 0, href: '', profile: null, observer: null };
  const obj = (k, d = {}) => { const v = GM_getValue(k, d); return v && typeof v === 'object' && !Array.isArray(v) ? v : d; };
  const arr = k => { const v = GM_getValue(k, []); return Array.isArray(v) ? v.map(String) : []; };
  const cfg = () => ({ ...DEF, ...obj(K.S) });
  const setCfg = p => GM_setValue(K.S, { ...cfg(), ...p });
  const seeds = () => obj(K.SEEDS);
  const forced = () => new Set(arr(K.FORCED));
  const auto = () => obj(K.AUTO);
  const whitelist = () => new Set(arr(K.WL));
  const seedVer = () => Number(GM_getValue(K.VER, 0)) || 0;
  const bump = () => { GM_setValue(K.VER, seedVer() + 1); GM_setValue(K.CACHE, {}); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const jitter = () => { const c = cfg(); return c.requestDelayMin + Math.random() * Math.max(0, c.requestDelayMax - c.requestDelayMin); };
  const cookie = n => { const r = document.cookie.split('; ').find(x => x.startsWith(n + '=')); if (!r) return ''; try { return decodeURIComponent(r.slice(n.length + 1)); } catch { return r.slice(n.length + 1); } };

  async function api(url, options = {}, run = null) {
    for (let i = 0; i <= cfg().maxRateLimitRetries; i++) {
      if (run !== null && run !== st.run) throw new Error('ROUTE_CHANGED');
      const res = await fetch(url, { credentials: 'include', ...options });
      let data = null; try { data = await res.clone().json(); } catch {}
      if (res.status === 418 || res.status === 429 || /频繁|too many|rate/i.test(String(data?.msg || data?.message || ''))) {
        if (i >= cfg().maxRateLimitRetries) throw new Error('微博请求频率受限');
        await sleep(3000 * (i + 1)); continue;
      }
      if (!res.ok) throw new Error(data?.msg || data?.message || `HTTP ${res.status}`);
      if (data === null) throw new Error('接口未返回 JSON');
      return data;
    }
  }

  function css() {
    if (document.getElementById('wflp-css')) return;
    const e = document.createElement('style'); e.id = 'wflp-css'; e.textContent = `
#wflp-toasts{position:fixed;top:76px;right:20px;z-index:2147483646;width:min(360px,calc(100vw - 32px));display:flex;flex-direction:column;gap:10px;pointer-events:none}
.wflp-toast{pointer-events:auto;background:rgba(255,255,255,.97);border:1px solid rgba(0,0,0,.08);box-shadow:0 12px 34px rgba(0,0,0,.14);border-radius:12px;padding:12px 14px;font:13px/1.55 system-ui;color:#222;opacity:0;transform:translateY(-8px);transition:.18s}.wflp-toast.show{opacity:1;transform:none}.wflp-toast b{display:block;font-size:14px}.wflp-toast small{display:block;color:#666;margin-top:2px}.wflp-toast.success{border-left:4px solid #18a058}.wflp-toast.error{border-left:4px solid #d03050}.wflp-toast.warning{border-left:4px solid #f0a020}
#wflp-modal{position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.32);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:24px;font-family:system-ui}#wflp-modal .card{width:min(440px,100%);background:#fff;border-radius:16px;box-shadow:0 26px 80px rgba(0,0,0,.22);padding:22px;color:#222}#wflp-modal h3{margin:0 0 10px;font-size:18px}#wflp-modal p{white-space:pre-wrap;color:#5b616b;font-size:13px;line-height:1.7}#wflp-modal input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #d9dde4;border-radius:10px;font-size:14px;outline:none}#wflp-modal .err{min-height:20px;color:#d03050;font-size:12px;margin-top:5px}#wflp-modal .acts{display:flex;justify-content:flex-end;gap:10px;margin-top:14px}#wflp-modal button{border-radius:9px;padding:8px 15px;cursor:pointer;font-weight:600;border:1px solid #ddd;background:#fff}#wflp-modal .ok{background:#ff8200;border-color:#ff8200;color:#fff}
.wflp-block{display:inline-flex;align-items:center;justify-content:center;margin-left:6px;padding:2px 8px;min-height:20px;border:1px solid rgba(208,48,80,.28);border-radius:7px;background:rgba(208,48,80,.055);color:#c82f4f;font:500 12px/1.4 system-ui;cursor:pointer;vertical-align:middle}.wflp-block:hover{background:rgba(208,48,80,.12)}.wflp-block[disabled]{opacity:.5;cursor:default}.wflp-profile{min-height:30px;padding:4px 12px;font-size:13px}.wflp-float{position:fixed;top:86px;right:24px;z-index:2147483000;box-shadow:0 6px 18px rgba(0,0,0,.08)}
@media(prefers-color-scheme:dark){.wflp-toast,#wflp-modal .card{background:#24262b;color:#eee}.wflp-toast small,#wflp-modal p{color:#b1b7c0}#wflp-modal input,#wflp-modal button{background:#1f2125;color:#eee;border-color:#454a52}}
`; (document.head || document.documentElement).appendChild(e);
  }

  function toast(title, detail = '', type = 'info', ms = 3200) {
    if (!document.documentElement) return; css();
    let root = document.getElementById('wflp-toasts'); if (!root) { root = document.createElement('div'); root.id = 'wflp-toasts'; document.documentElement.appendChild(root); }
    const el = document.createElement('div'); el.className = `wflp-toast ${type}`; el.innerHTML = `<b></b><small></small>`; el.querySelector('b').textContent = title; el.querySelector('small').textContent = detail; root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show')); setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 180); }, ms);
  }

  function modal({ title, message = '', input = false, value = '', confirmText = '确定', validate = null }) {
    return new Promise(resolve => {
      css(); document.getElementById('wflp-modal')?.remove();
      const bg = document.createElement('div'); bg.id = 'wflp-modal';
      bg.innerHTML = `<div class="card"><h3></h3><p></p>${input ? '<input>' : ''}<div class="err"></div><div class="acts"><button class="cancel">取消</button><button class="ok"></button></div></div>`;
      bg.querySelector('h3').textContent = title; bg.querySelector('p').textContent = message; bg.querySelector('.ok').textContent = confirmText;
      const field = bg.querySelector('input'); if (field) field.value = value;
      const done = v => { bg.remove(); resolve(v); }; bg.querySelector('.cancel').onclick = () => done(null);
      bg.querySelector('.ok').onclick = () => { const v = field ? field.value.trim() : true; const err = validate?.(v); if (err) return bg.querySelector('.err').textContent = err; done(v); };
      bg.onclick = e => { if (e.target === bg) done(null); }; document.documentElement.appendChild(bg); field?.focus(); field?.select();
    });
  }

  function profileHint() {
    const p = location.pathname.replace(/\/+$/, ''); let m;
    if ((m = p.match(/^\/u\/(\d{5,})$/)) || (m = p.match(/^\/(\d{5,})$/)) || (m = p.match(/^\/p\/100505(\d{5,})$/))) return { uid: m[1] };
    if ((m = p.match(/^\/n\/([^/]+)$/))) { let n = m[1]; try { n = decodeURIComponent(n); } catch {} return { name: n }; }
    return null;
  }

  async function resolveProfile(run = st.run) {
    const h = profileHint(); if (!h) return null;
    const q = h.uid ? `uid=${encodeURIComponent(h.uid)}` : `screen_name=${encodeURIComponent(h.name)}`;
    try {
      const d = await api(`/ajax/profile/info?${q}`, {}, run), u = d?.data?.user;
      if (u) return { uid: String(u.idstr || u.id || h.uid || ''), name: String(u.screen_name || h.name || ''), following: Number(u.friends_count || 0) };
    } catch (e) { if (e.message === 'ROUTE_CHANGED') throw e; }
    return h.uid ? { uid: h.uid, name: '', following: 0 } : null;
  }

  function myUid() {
    const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    for (const v of [w?.$CONFIG?.uid, w?.__INITIAL_STATE__?.config?.uid, w?.__INITIAL_STATE__?.loginUserInfo?.uid]) { const m = String(v || '').match(/\d{5,}/); if (m) return m[0]; }
    return '';
  }
  const isSelf = () => [...document.querySelectorAll('button,a')].some(x => /^(编辑个人资料|编辑资料)$/.test((x.textContent || '').trim()));
  const next = v => !['', '0', 'false', 'null', 'undefined'].includes(String(v ?? '').trim().toLowerCase());
  function blockedUid(i) { const m = String(i?.scheme || '').match(/uid=(\d{5,})/); return m?.[1] || String(i?.user?.idstr || i?.user?.id || i?.uid || ''); }

  async function syncBlacklist() {
    const old = seeds(), a = auto(), f = forced(), official = new Set();
    for (let page = 1; page <= 500; page++) {
      const d = await api(`/ajax/setting/getFilteredUsers?page=${page}`);
      if (d?.ok !== 1 && d?.ok !== true) throw new Error(d?.msg || '官方黑名单接口失败');
      if (!Array.isArray(d.card_group)) throw new Error('官方黑名单响应异常');
      d.card_group.forEach(i => { const u = blockedUid(i); if (u) official.add(u); });
      if (!d.card_group.length || !next(d.next_cursor) || Number(d.total) === 0) break;
      await sleep(500);
    }
    const n = {};
    for (const u of official) if (!a[u] || f.has(u)) n[u] = { weight: Number(old[u]?.weight || cfg().defaultSeedWeight), source: f.has(u) ? 'forced' : 'official', name: old[u]?.name || '' };
    for (const u of f) n[u] = { weight: Number(old[u]?.weight || cfg().defaultSeedWeight), source: 'forced', name: old[u]?.name || '' };
    GM_setValue(K.SEEDS, n); GM_setValue(K.INIT, true); bump(); return n;
  }
  const ensureSeeds = () => GM_getValue(K.INIT, false) ? Promise.resolve(seeds()) : syncBlacklist();

  async function scan(p, map, run) {
    const c = cfg(), threshold = Number(c.autoBlockScore), pages = p.following > 0 ? Math.min(Math.ceil(p.following / c.pageSize), c.maxFollowPages) : c.maxFollowPages;
    let score = 0, scanned = 0, hits = [], complete = false; const seen = new Set();
    for (let page = 1; page <= pages; page++) {
      const d = await api(`/ajax/friendships/friends?uid=${encodeURIComponent(p.uid)}&page=${page}&count=${c.pageSize}`, {}, run);
      if (!Array.isArray(d?.users)) throw new Error('关注列表接口异常');
      if (!d.users.length) { complete = true; break; }
      for (const u of d.users) {
        const id = String(u.idstr || u.id || ''); if (!id || seen.has(id)) continue; seen.add(id); scanned++;
        if (map[id]) { const weight = Math.max(0, Number(map[id].weight || c.defaultSeedWeight)); score += weight; hits.push({ uid: id, name: u.screen_name || u.name || map[id].name || id, weight }); if (score >= threshold) return { blocked: true, score, scanned, hits, complete: false }; }
      }
      if (!next(d.next_cursor) || d.users.length < c.pageSize) { complete = true; break; }
      await sleep(jitter());
    }
    if (p.following > pages * c.pageSize) complete = false;
    return { blocked: false, score, scanned, hits, complete };
  }

  async function doBlock(uid) {
    const token = cookie('XSRF-TOKEN'); if (!token) throw new Error('无法读取 XSRF-TOKEN');
    const d = await api('/ajax/statuses/filterUser', { method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8', 'x-xsrf-token': token, 'x-requested-with': 'XMLHttpRequest' }, body: JSON.stringify({ uid: Number(uid), status: 1, interact: 1, follow: 1 }) });
    if (d?.ok !== 1 && d?.ok !== true) throw new Error(d?.msg || '微博未确认拉黑成功'); return d;
  }

  function addSeed(uid, name = '', weight = 1, source = 'forced') {
    const m = seeds(); m[uid] = { weight: Number(weight) || 1, source, name }; GM_setValue(K.SEEDS, m);
    const f = forced(); f.add(uid); GM_setValue(K.FORCED, [...f]); const a = auto(); if (a[uid]) { delete a[uid]; GM_setValue(K.AUTO, a); }
    GM_setValue(K.INIT, true); bump();
  }

  async function manualBlock(uid, name, btn) {
    if (!uid || btn?.disabled) return; if (myUid() === uid) return toast('已取消', '不能拉黑当前登录账号', 'warning');
    if (whitelist().has(uid)) return toast('已取消', '该用户在白名单中', 'warning');
    if (btn) { btn.disabled = true; btn.textContent = '处理中'; }
    try { await doBlock(uid); addSeed(uid, name, cfg().defaultSeedWeight, 'manual'); if (btn) btn.textContent = '已拉黑'; toast(`已拉黑 ${name ? '@' + name : uid}`, '已加入持久种子库', 'success'); }
    catch (e) { if (btn) { btn.disabled = false; btn.textContent = '拉黑'; } toast('拉黑失败', String(e.message || e), 'error'); }
  }

  function uidFromHref(href = '') { const m = href.match(/\/u\/(\d{5,})/) || href.match(/weibo\.com\/(\d{5,})(?:[/?#]|$)/) || href.match(/[?&]uid=(\d{5,})/); return m?.[1] || ''; }
  function makeBtn(uid, name, cls = '') { const b = document.createElement('button'); b.type = 'button'; b.className = `wflp-block ${cls}`; b.textContent = '拉黑'; b.dataset.uid = uid; b.onclick = e => { e.preventDefault(); e.stopPropagation(); manualBlock(uid, name, b); }; return b; }

  async function injectProfile() {
    if (!profileHint() || document.querySelector('.wflp-profile')) return;
    const p = st.profile || await resolveProfile().catch(() => null); if (!p?.uid || p.uid === myUid() || isSelf()) return; css();
    const candidates = [...document.querySelectorAll('button')].filter(b => /^(关注|已关注|私信|更多)$/.test((b.textContent || '').trim()));
    const anchor = candidates.find(b => b.offsetParent); const b = makeBtn(p.uid, p.name, 'wflp-profile');
    if (anchor?.parentElement) anchor.parentElement.appendChild(b); else { b.classList.add('wflp-float'); document.documentElement.appendChild(b); }
  }

  function injectComments(root = document) {
    css();
    const containers = root.querySelectorAll?.('[data-comment-id], .wbpro-list .item1, [class*="Comment"] [class*="item"]') || [];
    containers.forEach(c => {
      if (c.querySelector('.wflp-block')) return;
      const links = [...c.querySelectorAll('a[href]')]; let a = links.find(x => uidFromHref(x.href) && (x.textContent || '').trim()); if (!a) return;
      const uid = uidFromHref(a.href), name = (a.textContent || '').trim().replace(/^@/, ''); if (!uid || uid === myUid()) return;
      a.insertAdjacentElement('afterend', makeBtn(uid, name));
    });
  }

  function observe() {
    if (st.observer || !document.documentElement) return;
    st.observer = new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType !== 1) return; injectComments(n); if (profileHint()) injectProfile(); })));
    st.observer.observe(document.documentElement, { childList: true, subtree: true }); injectComments(); injectProfile();
  }

  function historyAdd(x) { let h = GM_getValue(K.HISTORY, []); if (!Array.isArray(h)) h = []; h.unshift({ at: Date.now(), ...x }); h.length = Math.min(h.length, cfg().maxHistory); GM_setValue(K.HISTORY, h); }
  function cacheSafe(p, r) { if (!r.complete) return; const c = obj(K.CACHE); c[p.uid] = { at: Date.now(), seedVersion: seedVer(), score: r.score, scanned: r.scanned }; GM_setValue(K.CACHE, c); }
  function cached(uid) { const x = obj(K.CACHE)[uid]; return !!x && x.seedVersion === seedVer() && Date.now() - Number(x.at || 0) < cfg().safeCacheTtl; }

  async function process(run) {
    if (!cfg().enabled) return; const p = await resolveProfile(run); if (!p || run !== st.run) return; st.profile = p; injectProfile();
    if (p.uid === myUid() || isSelf() || whitelist().has(p.uid) || cached(p.uid)) return;
    if (auto()[p.uid]) return;
    let map; try { map = await ensureSeeds(); } catch (e) { console.error('[WFLP] seed', e); return; }
    if (map[p.uid] || !Object.keys(map).length || run !== st.run) return;
    let r; try { r = await scan(p, map, run); } catch (e) { if (e.message !== 'ROUTE_CHANGED') console.error('[WFLP] scan', e); return; }
    if (run !== st.run) return;
    if (r.blocked) {
      try { await doBlock(p.uid); const a = auto(); a[p.uid] = { at: Date.now(), score: r.score, hits: r.hits.map(x => x.uid) }; GM_setValue(K.AUTO, a); historyAdd({ decision: 'blocked', uid: p.uid, name: p.name, ...r }); toast(`已自动拉黑 ${p.name ? '@' + p.name : p.uid}`, `Risk Score ${r.score.toFixed(2)} · 扫描 ${r.scanned} 人 · 命中 ${r.hits.length} 人`, 'success', 4200); if (cfg().goBackAfterBlock) setTimeout(() => history.back(), 650); }
      catch (e) { toast('达到阈值，但拉黑失败', String(e.message || e), 'error', 4500); }
    } else { historyAdd({ decision: r.complete ? 'safe' : 'incomplete', uid: p.uid, name: p.name, ...r }); cacheSafe(p, r); }
  }

  function route() {
    if (location.href === st.href) return; st.href = location.href; st.run++; st.profile = null; document.querySelector('.wflp-float')?.remove(); const run = st.run;
    if (cfg().enabled && profileHint()) { setTimeout(injectProfile, 120); setTimeout(() => process(run).catch(console.error), 300); }
    setTimeout(() => injectComments(), 150);
  }

  function exportSeeds() {
    const data = { format: 'weibo-follow-law-pro-seeds', version: 1, exportedAt: new Date().toISOString(), seeds: seeds() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `weibo-follow-law-seeds-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); return Object.keys(data.seeds).length;
  }

  function importSeeds() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,.txt,application/json,text/plain'; input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return;
      try {
        const text = await file.text(); let incoming = {};
        try { const d = JSON.parse(text); incoming = d?.seeds && typeof d.seeds === 'object' ? d.seeds : d; }
        catch { text.split(/[\n,，]+/).map(x => x.trim()).filter(x => /^\d{5,}$/.test(x)).forEach(uid => incoming[uid] = { weight: 1, name: '' }); }
        const m = seeds(), f = forced(); let count = 0;
        for (const [uid, v] of Object.entries(incoming || {})) if (/^\d{5,}$/.test(uid)) { m[uid] = { weight: Math.max(.01, Number(v?.weight || 1)), source: 'imported', name: String(v?.name || '') }; f.add(uid); count++; }
        GM_setValue(K.SEEDS, m); GM_setValue(K.FORCED, [...f]); GM_setValue(K.INIT, true); bump(); toast('种子黑名单导入完成', `导入 ${count} 个 · 当前 ${Object.keys(m).length} 个`, 'success');
      } catch (e) { toast('导入失败', String(e.message || e), 'error'); }
    }; input.click();
  }

  GM_registerMenuCommand('同步微博官方黑名单 → 种子库', async () => { try { const m = await syncBlacklist(); toast('种子黑名单同步完成', `当前 ${Object.keys(m).length} 人`, 'success'); } catch (e) { toast('同步失败', String(e.message || e), 'error'); } });
  GM_registerMenuCommand('导出种子黑名单（迁移备份）', () => toast('种子黑名单已导出', `共 ${exportSeeds()} 个种子`, 'success'));
  GM_registerMenuCommand('导入种子黑名单（迁移恢复）', importSeeds);
  GM_registerMenuCommand('设置 Risk Score 拉黑阈值', async () => { const v = await modal({ title: '自动拉黑阈值', message: '1 = 命中一个普通种子即拉黑；2/3 更保守。', input: true, value: cfg().autoBlockScore, confirmText: '保存', validate: x => Number(x) > 0 ? '' : '请输入大于 0 的数字' }); if (v !== null) { setCfg({ autoBlockScore: Number(v) }); GM_setValue(K.CACHE, {}); toast('设置已保存', `阈值 ${v}`, 'success'); } });
  GM_registerMenuCommand('设置最大关注列表扫描页数', async () => { const v = await modal({ title: '最大扫描页数', message: '每页约 20 人。', input: true, value: cfg().maxFollowPages, confirmText: '保存', validate: x => Number(x) >= 1 && Number(x) <= 500 ? '' : '请输入 1~500' }); if (v !== null) { setCfg({ maxFollowPages: Math.floor(Number(v)) }); GM_setValue(K.CACHE, {}); toast('设置已保存', `最大 ${v} 页`, 'success'); } });
  GM_registerMenuCommand('将当前用户设为重点种子', async () => { const p = st.profile || await resolveProfile().catch(() => null); if (!p?.uid) return toast('无法识别当前用户', '请进入用户主页', 'warning'); const v = await modal({ title: `重点种子 · ${p.name ? '@' + p.name : p.uid}`, message: '1=普通，2=较高，3=重点。', input: true, value: 3, confirmText: '加入', validate: x => Number(x) > 0 ? '' : '请输入正数' }); if (v !== null) { addSeed(p.uid, p.name, Number(v), 'forced'); toast('重点种子已添加', `权重 ${v}`, 'success'); } });
  GM_registerMenuCommand('将当前用户加入白名单', async () => { const p = st.profile || await resolveProfile().catch(() => null); if (!p?.uid) return; const w = whitelist(); w.add(p.uid); GM_setValue(K.WL, [...w]); toast('已加入白名单', p.name || p.uid, 'success'); });
  GM_registerMenuCommand('查看插件统计', () => modal({ title: '关注列表定律 Pro', message: `种子：${Object.keys(seeds()).length}\n重点/持久种子：${forced().size}\n自动拉黑：${Object.keys(auto()).length}\n白名单：${whitelist().size}\n当前阈值：${cfg().autoBlockScore}` }));
  GM_registerMenuCommand(cfg().enabled ? '关闭关注列表定律 Pro' : '开启关注列表定律 Pro', () => { setCfg({ enabled: !cfg().enabled }); location.reload(); });

  for (const m of ['pushState', 'replaceState']) { const raw = history[m]; history[m] = function(...a) { const r = raw.apply(this, a); queueMicrotask(route); return r; }; }
  addEventListener('popstate', route); addEventListener('hashchange', route);
  const start = () => { observe(); route(); setInterval(() => { route(); injectComments(); }, 1200); };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', start, { once: true }) : start();
})();
