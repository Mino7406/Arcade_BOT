// 디스코드 시뮬레이터 서버 — 실제 봇 코드(index.js)를 그대로 불러, 가짜 디스코드 위에서 돌린다.
// 직접 실행하지 말고 `node tools/디스코드시뮬/실행.js` 로 — 임시 폴더에 복사해서 돌린다(DB/ 를 건드리지 않게).
//
// 구조
//  - discord.js 의 Client 를 가짜 Client 로 바꿔치기한 뒤 index.js 를 require 한다 → 봇이 등록한
//    interactionCreate / messageCreate 리스너(= 실제 라우팅·채널 제한·오류 처리)를 그대로 호출할 수 있다.
//  - 브라우저 화면(화면.html)은 이 서버의 /api 로 "버튼 클릭 · 슬래시 명령 · 선택 메뉴 · 모달 제출 · 채팅"을 보낸다.
//  - 봇이 하는 응답(reply/update/editReply/followUp/showModal/channel.send/DM …)은 가짜 메시지 저장소에 쌓이고,
//    SSE(/events)로 화면이 다시 그려진다.
//  - 환경 설정(서버·유저·권한·역할·채널·시간·지연·DM 차단 …)을 바꿔 가며 상황별로 확인할 수 있다.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { AsyncLocalStorage } = require('async_hooks');

const ROOT = __dirname;
const D = require('discord.js');
const cfg = require(path.join(ROOT, 'config.js'));
const PORT = Number(process.env.SIM_PORT) || 5173;
const PRESET_FILE = process.env.SIM_PRESETS || path.join(ROOT, 'presets.json');

// ───────────────────────── 가상 시계 ─────────────────────────
const RealDate = Date;
let timeOffset = 0;
class SimDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + timeOffset); }
  static now() { return RealDate.now() + timeOffset; }
}
global.Date = SimDate;

// ───────────────────────── 로그 ─────────────────────────
const als = new AsyncLocalStorage(); // 지금 처리 중인 상호작용 기록(trace)
const sse = new Set();
const traces = [];      // 상호작용 기록(최근 200개)
const sysLog = [];      // 상호작용 밖에서 일어난 일(타이머·예약 등)
let revision = 0;
function bump() {
  revision++;
  for (const res of sse) res.write(`data: ${revision}\n\n`);
}
function note(kind, text) {
  const t = als.getStore();
  if (t) t.steps.push({ kind, text });
  else { sysLog.push({ at: Date.now(), kind, text }); if (sysLog.length > 200) sysLog.shift(); }
  bump();
}
const origErr = console.error.bind(console);
const origWarn = console.warn.bind(console);
const fmt = (a) => a.map(x => (x instanceof Error ? (x.stack || x.message).split('\n').slice(0, 4).join(' | ') : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
console.error = (...a) => { origErr(...a); note('오류', fmt(a)); };
console.warn = (...a) => { origWarn(...a); note('경고', fmt(a)); };

// ───────────────────────── 환경 설정 ─────────────────────────
const MAIN_GUILD = cfg.GUILD_ID.split(',')[0].trim();
const TEST_GUILD = (cfg.TEST_GUILD_IDS || [])[0] || '1282694117255548960';
const BOT_ID = '999999999999999999';
const ADMIN_DEFAULT = [...cfg.ADMIN_IDS];
const OWNER_DEFAULT = [...(cfg.OWNER_IDS || [])];

const DEFAULT_USERS = [
  { id: cfg.ADMIN_IDS[0], name: '관리자', admin: true, owner: true },
  { id: '100000000000000001', name: '민호' },
  { id: '100000000000000002', name: '지수' },
  { id: '100000000000000003', name: '하늘' },
  { id: '100000000000000004', name: '도윤' },
  { id: '100000000000000005', name: '서연' },
  { id: '100000000000000006', name: '준호' },
  { id: '100000000000000007', name: '예린' },
  { id: '100000000000000008', name: '태양' },
  { id: '100000000000000009', name: '나래' },
  { id: '100000000000000010', name: '현우' },
];
const ROLES = [
  { id: cfg.NEWBIE_BOOST_ROLE_ID || '1', name: '뉴비부스트' },
  { id: '2000000000000000001', name: '내전 알림' },
  { id: '2000000000000000002', name: 'Steam' },
];

function defaultEnv() {
  return {
    guild: 'test',                 // 'main' 본서버 / 'test' 테스트서버 — 채널 제한 규칙이 서버마다 다르다
    userId: DEFAULT_USERS[1].id,   // 지금 조작하는 사람
    channelId: cfg.PLAYGROUND_CHANNEL_ID,
    timeOffsetHours: 0,            // 가상 시계 이동(시간)
    latencyMs: 0,                  // 봇 응답 전 인위적 지연(3초 규칙 확인용)
    dmBlockedAll: false,           // 모든 유저가 DM을 막아 둔 상황
    users: Object.fromEntries(DEFAULT_USERS.map(u => [u.id, {
      name: u.name, admin: !!u.admin, owner: !!u.owner, roles: [], voice: null, dmBlocked: false,
    }])),
  };
}
let env = defaultEnv();

// 채널 목록(config.js 의 실제 ID — 그래야 채널 제한 규칙이 그대로 적용된다)
function channelDefs() {
  const list = [];
  const add = (id, name, group) => { if (id && !list.some(c => c.id === id)) list.push({ id, name, group }); };
  add(cfg.PLAYGROUND_CHANNEL_ID, '놀이터', '텍스트 채널');
  (cfg.ALLOWED_CHANNEL_IDS || []).forEach((id, i) => add(id, id === cfg.MATCH_BONUS_CHANNEL_ID ? '게임모집(인증)' : `내전·모집 ${i + 1}`, '텍스트 채널'));
  add(cfg.MATCH_BONUS_CHANNEL_ID, '게임모집(인증)', '텍스트 채널');
  add(cfg.XP_CHANNEL_ID, '메인 채팅', '텍스트 채널');
  (cfg.RECORD_SEARCH_CHANNEL_IDS || []).forEach((id, i) => add(id, id === cfg.XP_CHANNEL_ID ? '메인 채팅' : `TTS·임시채팅 ${i}`, '텍스트 채널'));
  add(cfg.PATCHNOTE_CHANNEL_ID, '패치노트', '텍스트 채널');
  add('9000000000000000001', '일반 채널(허용 목록 밖)', '텍스트 채널');
  return list;
}

// ───────────────────────── 가짜 사용자·서버·채널 ─────────────────────────
let seq = 0;
const nextId = () => ((BigInt(RealDate.now() + timeOffset - 1420070400000) << 22n) | BigInt(++seq % 4096)).toString();
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const bitsOf = (flags) => { try { return Number(new D.MessageFlagsBitField(flags ?? 0).bitfield); } catch { return typeof flags === 'number' ? flags : 0; } };
const toJSON = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);

class FakeUser {
  constructor(id, name, bot = false) {
    this.id = id; this.username = name; this.globalName = name; this.displayName = name; this.bot = bot;
    this.discriminator = '0'; this.tag = name; this.system = false;
  }
  displayAvatarURL() { return `sim://avatar/${this.id}`; }
  avatarURL() { return this.displayAvatarURL(); }
  toString() { return `<@${this.id}>`; }
  get createdTimestamp() { return 1700000000000; }
  async createDM() { return getChannel(`dm:${this.id}`); }
  async send(p) {
    const e = env.users[this.id];
    if (!this.bot && (env.dmBlockedAll || e?.dmBlocked)) {
      note('DM', `📪 ${this.username} 님에게 DM 전송 실패 — DM 차단(50007)`);
      throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007, status: 403 });
    }
    return (await this.createDM()).send(p);
  }
}
const botUser = new FakeUser(BOT_ID, 'ARCADE', true);
botUser.tag = 'ARCADE#0001';
const userCache = new Map();
function getUser(id) {
  id = String(id);
  if (!userCache.has(id)) {
    const e = env.users[id];
    userCache.set(id, id === BOT_ID ? botUser : new FakeUser(id, e?.name ?? `유저${id.slice(-4)}`));
  }
  return userCache.get(id);
}

function roleObj(r) { return { id: r.id, name: r.name, toString: () => `<@&${r.id}>`, members: new D.Collection() }; }
function memberOf(guild, id) {
  const u = getUser(id);
  const e = env.users[id] ?? { admin: false, roles: [], voice: null };
  const roleCache = new D.Collection();
  for (const rid of e.roles || []) { const r = ROLES.find(x => x.id === rid); if (r) roleCache.set(r.id, roleObj(r)); }
  return {
    id, user: u, guild, displayName: u.username, nickname: null, joinedTimestamp: 1700000000000,
    roles: {
      cache: roleCache,
      add: async (r) => { const rid = r?.id ?? r; (e.roles ??= []).includes(rid) || e.roles.push(rid); bump(); },
      remove: async (r) => { const rid = r?.id ?? r; e.roles = (e.roles || []).filter(x => x !== rid); bump(); },
    },
    permissions: { has: () => !!e.admin },
    voice: { channel: e.voice ? { id: e.voice, name: e.voice, members: new D.Collection() } : null, channelId: e.voice ?? null },
    displayAvatarURL: () => u.displayAvatarURL(),
    toString: () => `<@${id}>`,
    send: (p) => u.send(p),
    kickable: true, bannable: true, manageable: true,
  };
}

const guildCache = new Map();
function getGuild(gid) {
  if (!guildCache.has(gid)) {
    const g = {
      id: gid, name: gid === TEST_GUILD ? '아케이드 (테스트 서버)' : '아케이드 (본서버)', ownerId: cfg.ADMIN_IDS[0], memberCount: DEFAULT_USERS.length,
      client: null, available: true,
    };
    const roleCol = new D.Collection(ROLES.map(r => [r.id, roleObj(r)]));
    g.roles = { cache: roleCol, fetch: async () => roleCol, create: async (o) => roleObj({ id: nextId(), name: o?.name ?? '역할' }) };
    g.members = {
      cache: new D.Collection(),
      fetch: async (arg) => {
        if (typeof arg === 'string') { if (!env.users[arg]) throw Object.assign(new Error('Unknown Member'), { code: 10007 }); return memberOf(g, arg); }
        const ids = arg?.user ? [].concat(arg.user) : Object.keys(env.users);
        return new D.Collection(ids.filter(i => env.users[i]).map(i => [i, memberOf(g, i)]));
      },
    };
    g.channels = { cache: new D.Collection(), fetch: async (id) => (id ? getChannel(id) : new D.Collection(channelDefs().map(c => [c.id, getChannel(c.id)]))) };
    g.emojis = { cache: new D.Collection(), fetch: async () => new D.Collection() };
    g.voiceStates = { cache: new D.Collection() };
    guildCache.set(gid, g);
  }
  const g = guildCache.get(gid); g.client = client; return g;
}
const curGuildId = () => (env.guild === 'main' ? MAIN_GUILD : TEST_GUILD);

// ── 메시지 ──
const channels = new Map();
const missingApis = new Set();

function guardApi(obj, label) { // 가짜가 모르는 디스코드 API 를 봇이 부르면 조용히 undefined 가 아니라 화면에 알려 준다
  return new Proxy(obj, {
    get(t, k, r) {
      if (k in t || typeof k === 'symbol' || k === 'then' || k === 'toJSON' || k === 'inspect') return Reflect.get(t, k, r);
      const key = `${label}.${String(k)}`;
      if (!missingApis.has(key)) { missingApis.add(key); note('경고', `🧩 시뮬레이터가 아직 흉내 내지 못하는 디스코드 API: ${key}`); }
      return undefined;
    },
  });
}

function normPayload(p) {
  if (typeof p === 'string') p = { content: p };
  p = p || {};
  let flags = bitsOf(p.flags);
  if (p.ephemeral) flags |= D.MessageFlags.Ephemeral;
  const files = {};
  for (const f of p.files || []) {
    const name = f?.name ?? f?.attachment?.name ?? `file${Object.keys(files).length}`;
    const buf = f?.attachment ?? f;
    if (Buffer.isBuffer(buf)) files[name] = `data:${/\.gif$/i.test(name) ? 'image/gif' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : 'image/png'};base64,${buf.toString('base64')}`;
    else if (typeof buf === 'string') files[name] = buf;
  }
  return {
    content: p.content ?? null,
    embeds: (p.embeds || []).map(toJSON),
    components: (p.components || []).map(toJSON),
    files, flags,
    hasKey: { content: 'content' in p, embeds: 'embeds' in p, components: 'components' in p, files: 'files' in p },
  };
}

class FakeMessage {
  constructor(channel, author, payload, meta = {}) {
    this.id = nextId(); this.channel = channel; this.channelId = channel.id; this.guildId = channel.guildId;
    this.guild = channel.guildId ? getGuild(channel.guildId) : null; this.client = client;
    this.author = author; this.member = channel.guildId && !author.bot ? memberOf(this.guild, author.id) : null;
    this.createdTimestamp = Date.now(); this.editedTimestamp = null; this.pinned = false; this.deleted = false;
    this.ephemeralTo = meta.ephemeralTo ?? null;
    this.interactionLabel = meta.interactionLabel ?? null;
    this.replyTo = meta.replyTo ?? null;
    this.reference = meta.replyTo ? { messageId: meta.replyTo, channelId: channel.id } : null;
    this.webhookId = null; this.type = 0; this.system = false;
    this.mentions = { users: new D.Collection(), roles: new D.Collection(), has: () => false, repliedUser: null };
    this.reactions = { cache: new D.Collection(), removeAll: async () => {} };
    this.attachments = new D.Collection();
    this.history = [];
    this.setFrom(payload, true);
    this.url = `https://discord.com/channels/${this.guildId ?? '@me'}/${this.channelId}/${this.id}`;
  }
  get flags() { return new D.MessageFlagsBitField(this._flags); }
  get isV2() { return !!(this._flags & D.MessageFlags.IsComponentsV2); }
  setFrom(p, first = false) {
    const n = typeof p?.hasKey === 'object' && p.components !== undefined && p.files !== undefined ? p : normPayload(p);
    check(first ? '메시지 전송' : '메시지 수정', n, first ? null : this.isV2, this.id);
    if (first) { this.content = n.content ?? ''; this.embeds = n.embeds; this.components = n.components; this._flags = n.flags; this.files = n.files; }
    else {
      this.history.push({ content: this.content, embeds: this.embeds, components: this.components });
      if (n.hasKey.content) this.content = n.content ?? '';
      if (n.hasKey.embeds) this.embeds = n.embeds;
      if (n.hasKey.components) this.components = n.components;
      if (n.hasKey.files) this.files = { ...(this.files || {}), ...n.files };
      this._flags = (this._flags & D.MessageFlags.Ephemeral) | (n.flags & ~D.MessageFlags.Ephemeral) | (this.isV2 ? D.MessageFlags.IsComponentsV2 : 0);
      this.editedTimestamp = Date.now();
    }
    bump();
  }
  async edit(p) { if (this.deleted) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); this.setFrom(p); return this; }
  async delete() { if (this.deleted) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); this.deleted = true; note('메시지', `🗑️ 메시지 삭제됨(${this.id.slice(-5)})`); bump(); return this; }
  async fetch() { if (this.deleted) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); return this; }
  async reply(p) { return this.channel.send({ ...(typeof p === 'string' ? { content: p } : p), __replyTo: this.id }); }
  async react() { return {}; }
  async pin() { this.pinned = true; bump(); return this; }
  async unpin() { this.pinned = false; bump(); return this; }
  inGuild() { return !!this.guildId; }
  get editable() { return this.author.bot; }
  get deletable() { return true; }
  get createdAt() { return new Date(this.createdTimestamp); }
  toJSON() { return { id: this.id }; }
}

function getChannel(id) {
  if (channels.has(id)) return channels.get(id);
  const dm = id.startsWith('dm:');
  const def = channelDefs().find(c => c.id === id);
  const ch = {
    id, name: dm ? `DM` : (def?.name ?? `채널${id.slice(-4)}`), guildId: dm ? null : undefined, type: dm ? 1 : 0, client,
    list: [], lastMessageId: null, parentId: null, topic: null, nsfw: false,
  };
  Object.defineProperty(ch, 'guildId', { get: () => (dm ? null : curGuildId()) });
  Object.defineProperty(ch, 'guild', { get: () => (dm ? null : getGuild(curGuildId())) });
  ch.isTextBased = () => true; ch.isDMBased = () => dm; ch.isVoiceBased = () => false; ch.isThread = () => false;
  ch.toString = () => `<#${id}>`; ch.permissionsFor = () => ({ has: () => true, toArray: () => [] });
  ch.send = async (p) => {
    if (typeof p === 'object' && p?.__replyTo) { const rt = p.__replyTo; p = { ...p }; delete p.__replyTo; return post(ch, botUser, p, { replyTo: rt }); }
    return post(ch, botUser, p);
  };
  ch.sendTyping = async () => {};
  ch.messages = {
    cache: new D.Collection(),
    fetch: async (arg) => {
      const live = ch.list.filter(m => !m.deleted && !m.ephemeralTo);
      if (typeof arg === 'string') { const m = live.find(x => x.id === arg); if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); return m; }
      let arr = live.slice().reverse();
      if (arg?.before) { const i = arr.findIndex(m => m.id === arg.before); if (i >= 0) arr = arr.slice(i + 1); }
      return new D.Collection(arr.slice(0, arg?.limit ?? 50).map(m => [m.id, m]));
    },
    delete: async (mid) => { const m = ch.list.find(x => x.id === (mid?.id ?? mid)); if (m) await m.delete(); },
    resolve: (mid) => ch.list.find(x => x.id === mid) ?? null,
  };
  ch.bulkDelete = async (arg) => { const ms = arg instanceof Map || Array.isArray(arg) ? [...(arg.values?.() ?? arg)] : ch.list.filter(m => !m.deleted && !m.ephemeralTo).slice(-(Number(arg) || 0)); for (const m of ms) await (m.delete?.() ?? Promise.resolve()); return new D.Collection(ms.map(m => [m.id, m])); };
  ch.delete = async () => {};
  channels.set(id, guardApi(ch, `채널`));
  return channels.get(id);
}

function post(ch, author, payload, meta = {}) {
  const m = new FakeMessage(ch, author, payload, meta);
  ch.list.push(m); ch.lastMessageId = m.id;
  if (ch.list.length > 400) ch.list.splice(0, ch.list.length - 400);
  if (!m.ephemeralTo) note('메시지', `${author.bot ? '🤖 봇' : author.username}: ${summary(m)} → #${ch.name}`);
  return m;
}
function summary(m) {
  const t = (m.content || '').slice(0, 40);
  if (t) return `"${t}"`;
  const findText = (list) => { for (const c of list || []) { if (c.content) return c.content; const r = findText(c.components); if (r) return r; } return ''; };
  const x = findText(m.components) || m.embeds?.[0]?.title || m.embeds?.[0]?.description || '';
  return x ? `"${x.replace(/\s+/g, ' ').slice(0, 40)}"` : '(컴포넌트 메시지)';
}

// ───────────────────────── 디스코드 규칙 검사 ─────────────────────────
const V2_TYPES = new Set([9, 10, 11, 12, 13, 14, 17]);
function countC(list) { let n = 0; for (const c of list || []) { n += 1 + countC(c.components); if (c.accessory) n++; } return n; }
function textLen(list) { let n = 0; for (const c of list || []) { if (typeof c.content === 'string') n += c.content.length; n += textLen(c.components); } return n; }
function eachC(list, fn) { for (const c of list || []) { fn(c); eachC(c.components, fn); if (c.accessory) fn(c.accessory); } }
function check(where, n, targetIsV2, id) {
  const bad = (msg) => note('규칙위반', `⚠️ ${where}: ${msg} — 실제 디스코드라면 거부/오류`);
  const isV2 = !!(n.flags & D.MessageFlags.IsComponentsV2);
  const usesV2 = n.components.some(c => V2_TYPES.has(c.type));
  if (usesV2 && !isV2) bad('v2 컴포넌트인데 IsComponentsV2 플래그가 없음');
  if (isV2) {
    if (n.content) bad('v2 메시지에 content 가 있음');
    if (n.embeds.length) bad('v2 메시지에 embeds 가 있음');
    if (n.components.length > 10) bad(`최상위 컴포넌트 ${n.components.length}개(최대 10)`);
    if (countC(n.components) > 40) bad(`컴포넌트 ${countC(n.components)}개(최대 40)`);
    if (textLen(n.components) > 4000) bad(`글자 ${textLen(n.components)}자(최대 4000)`);
  } else {
    if ((n.content || '').length > 2000) bad(`content ${(n.content || '').length}자(최대 2000)`);
    if (n.embeds.length > 10) bad('임베드 10개 초과');
    if (n.components.length > 5) bad('액션 줄 5개 초과');
  }
  if (targetIsV2 === true && !isV2 && (n.hasKey.content || n.hasKey.components || n.hasKey.embeds)) bad('이미 v2인 메시지를 평문으로 고침(디스코드가 거부함)');
  const ids = new Map();
  eachC(n.components, (c) => {
    if (c.type === 2 && c.style !== 5) { if (!c.custom_id) bad('버튼에 custom_id 가 없음'); if (!c.label && !c.emoji) bad('라벨·이모지 둘 다 없는 버튼'); }
    if (c.label && c.label.length > 80) bad(`버튼 글자 ${c.label.length}자(최대 80)`);
    if (c.custom_id) { if (c.custom_id.length > 100) bad(`custom_id ${c.custom_id.length}자(최대 100): ${c.custom_id.slice(0, 30)}…`); ids.set(c.custom_id, (ids.get(c.custom_id) || 0) + 1); }
    if (c.type === 1 && (c.components || []).filter(x => x.type === 2).length > 5) bad('한 줄에 버튼 5개 초과');
    if (c.type === 3 && (c.options || []).length > 25) bad('선택 메뉴 옵션 25개 초과');
  });
  for (const [cid, k] of ids) if (k > 1) bad(`custom_id 중복: ${cid}`);
}

// ───────────────────────── 가짜 상호작용 ─────────────────────────
class AlreadyReplied extends Error { constructor() { super('The reply to this interaction has already been sent or deferred.'); this.code = 'InteractionAlreadyReplied'; this.name = 'DiscordjsError'; } }
class NotReplied extends Error { constructor() { super('The reply to this interaction has not been sent or deferred.'); this.code = 'InteractionNotReplied'; this.name = 'DiscordjsError'; } }

function makeOptions(def, given) {
  const opts = (def?.options || []);
  const val = (name) => given?.[name];
  const sub = opts.find(o => o.type === 1 && given?.__sub === o.name);
  return {
    get: (n) => val(n) ?? null,
    getString: (n, req) => { const v = val(n); if (v == null && req) throw new Error(`필수 옵션 ${n} 없음`); return v ?? null; },
    getInteger: (n) => (val(n) == null ? null : parseInt(val(n), 10)),
    getNumber: (n) => (val(n) == null ? null : Number(val(n))),
    getBoolean: (n) => (val(n) == null ? null : val(n) === true || val(n) === 'true'),
    getUser: (n) => (val(n) ? getUser(val(n)) : null),
    getMember: (n) => (val(n) ? memberOf(getGuild(curGuildId()), val(n)) : null),
    getChannel: (n) => (val(n) ? getChannel(val(n)) : null),
    getRole: (n) => { const r = ROLES.find(x => x.id === val(n)); return r ? roleObj(r) : null; },
    getSubcommand: () => given?.__sub ?? null,
    getSubcommandGroup: () => null,
    data: sub ? [] : [],
  };
}

function makeInteraction(kind, a) {
  const user = getUser(a.userId);
  const ch = getChannel(a.channelId);
  const gid = curGuildId();
  const guild = getGuild(gid);
  const startedAt = Date.now();
  const it = {
    id: nextId(), applicationId: BOT_ID, client, user, guildId: gid, guild, channel: ch, channelId: ch.id,
    member: memberOf(guild, user.id), memberPermissions: { has: () => !!env.users[user.id]?.admin },
    appPermissions: { has: () => true },
    locale: 'ko', guildLocale: 'ko', createdTimestamp: startedAt, createdAt: new Date(startedAt), token: 'sim',
    customId: a.customId, commandName: a.commandName, values: a.values, message: a.message ?? null,
    component: a.component ?? null,
    replied: false, deferred: false, ephemeral: null, _reply: null, _acked: null, _flagsReply: 0,
    fields: {
      getTextInputValue: (k) => { if (!(k in (a.fields || {}))) throw new Error(`모달에 ${k} 칸이 없음`); return a.fields[k] ?? ''; },
      getField: (k) => ({ value: a.fields?.[k] }),
      getStringSelectValues: (k) => a.fields?.[k] ?? [],
    },
    options: makeOptions(a.commandDef, a.options),
    users: new D.Collection((a.userValues || []).map(id => [id, getUser(id)])),
    members: new D.Collection((a.userValues || []).map(id => [id, memberOf(guild, id)])),
    isRepliable: () => true, inGuild: () => true, inCachedGuild: () => true,
    isChatInputCommand: () => kind === 'slash', isCommand: () => kind === 'slash',
    isButton: () => kind === 'button', isStringSelectMenu: () => kind === 'select', isUserSelectMenu: () => kind === 'userselect',
    isAnySelectMenu: () => kind === 'select' || kind === 'userselect', isChannelSelectMenu: () => false, isRoleSelectMenu: () => false, isMentionableSelectMenu: () => false,
    isModalSubmit: () => kind === 'modal', isMessageComponent: () => kind === 'button' || kind === 'select' || kind === 'userselect',
    isFromMessage: () => !!a.message && kind !== 'slash', isAutocomplete: () => false, isContextMenuCommand: () => false,
  };
  const ack = (what) => {
    if (!it._acked) {
      it._acked = Date.now();
      const ms = it._acked - startedAt;
      if (ms > 3000) note('규칙위반', `⏱️ 응답이 ${ms}ms 걸림 — 3초를 넘기면 디스코드에서 "상호작용 실패(Unknown interaction)"`);
    }
    note('응답', what);
  };
  const eph = (n) => !!(n.flags & D.MessageFlags.Ephemeral);
  it.reply = async (p) => {
    if (it.replied || it.deferred) throw new AlreadyReplied();
    const n = normPayload(p);
    it.replied = true; it.ephemeral = eph(n);
    const m = post(ch, botUser, n, { ephemeralTo: eph(n) ? user.id : null, interactionLabel: a.label });
    it._reply = m;
    ack(`reply — ${eph(n) ? '🔒 나만 보이는 메시지' : '💬 채널 메시지'}: ${summary(m)}`);
    const res = Object.assign(m, { resource: { message: m } });
    return res;
  };
  it.deferReply = async (o = {}) => {
    if (it.replied || it.deferred) throw new AlreadyReplied();
    const isEph = !!(o.ephemeral || (bitsOf(o.flags) & D.MessageFlags.Ephemeral));
    it.deferred = true; it.ephemeral = isEph;
    const m = post(ch, botUser, { content: '⏳ ARCADE 봇이 생각하는 중…', flags: isEph ? D.MessageFlags.Ephemeral : 0 }, { ephemeralTo: isEph ? user.id : null, interactionLabel: a.label });
    m.thinking = true; it._reply = m;
    ack(`deferReply — ${isEph ? '🔒 나만 보이는' : '💬'} "생각하는 중" 표시`);
    return it;
  };
  it.deferUpdate = async () => {
    if (it.replied || it.deferred) throw new AlreadyReplied();
    it.deferred = true; ack('deferUpdate — 화면 변화 없이 응답만 받음'); return it;
  };
  it.update = async (p) => {
    if (it.replied || it.deferred) throw new AlreadyReplied();
    if (!a.message) throw new Error('update 는 버튼/선택 메뉴에서만 쓸 수 있음');
    it.replied = true; a.message.setFrom(p);
    ack(`update — ✏️ 누른 메시지를 수정: ${summary(a.message)}`);
    return it;
  };
  it.editReply = async (p) => {
    if (!it.replied && !it.deferred) throw new NotReplied();
    const t = it._reply ?? a.message;
    if (!t) throw new NotReplied();
    if (t.thinking) { t.thinking = false; t.content = ''; }
    t.setFrom(p); t.interactionLabel ??= a.label;
    ack(`editReply — ✏️ 응답 수정: ${summary(t)}`);
    return t;
  };
  it.followUp = async (p) => {
    if (!it.replied && !it.deferred) throw new NotReplied();
    const n = normPayload(p);
    const m = post(ch, botUser, n, { ephemeralTo: eph(n) ? user.id : null, interactionLabel: a.label });
    ack(`followUp — ${eph(n) ? '🔒 나만 보이는' : '💬 채널'} 추가 메시지: ${summary(m)}`);
    return m;
  };
  it.deleteReply = async () => { const t = it._reply; if (!t) throw new NotReplied(); t.deleted = true; ack('deleteReply — 🗑️ 응답 삭제'); bump(); };
  it.fetchReply = async () => { const t = it._reply ?? a.message; if (!t) throw new NotReplied(); return t; };
  it.showModal = async (modal) => {
    if (it.replied || it.deferred) throw new AlreadyReplied();
    it.replied = true;
    const j = toJSON(modal);
    pendingModal = { id: nextId(), userId: user.id, customId: j.custom_id, title: j.title, components: j.components, channelId: ch.id };
    ack(`showModal — 📝 입력창 "${j.title}" 띄움(${j.custom_id})`);
    return it;
  };
  it.awaitModalSubmit = async () => { throw new Error('awaitModalSubmit 은 시뮬레이터가 아직 지원하지 않음'); };
  return it;
}
let pendingModal = null;

// ───────────────────────── 가짜 Client + 실제 봇 불러오기 ─────────────────────────
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.user = botUser; this.readyAt = null; this.readyTimestamp = null; this.uptime = 0;
    this.application = {
      id: BOT_ID,
      emojis: { fetch: async () => new D.Collection(), create: async ({ name }) => ({ id: nextId(), name, animated: false, toString: () => `<:${name}:0>` }) },
      commands: { set: async () => new D.Collection(), fetch: async () => new D.Collection() },
      fetch: async () => this.application,
    };
    this.ws = { ping: 0 }; this.rest = Object.assign(new EventEmitter(), {});
    this.guilds = { cache: new D.Collection(), fetch: async (id) => getGuild(id) };
    this.channels = { cache: new D.Collection(), fetch: async (id) => { if (!id) throw new Error('id 없음'); return getChannel(String(id)); } };
    this.users = { cache: new D.Collection(), fetch: async (id) => getUser(id) };
    this.options = {};
  }
  isReady() { return !!this.readyAt; }
  async login() { return 'sim'; }
  destroy() {}
}
const client = new FakeClient();
for (const g of [MAIN_GUILD, TEST_GUILD]) client.guilds.cache.set(g, getGuild(g));
D.Client = function () { return client; };

// 네트워크·타이머를 쓰는 시작 작업은 끈다(레이드·퀴즈는 환경 패널의 버튼으로 직접 띄운다)
const stub = (rel, name, fn = () => {}) => { const m = require(path.join(ROOT, rel)); m[name] = fn; };
stub('handlers/관리/패치노트.js', 'startPatchNoteWatcher');
stub('handlers/게임/퀴즈.js', 'startQuizScheduler');
stub('handlers/레이드/index.js', 'startRaidScheduler');
stub('handlers/전적/index.js', 'warmUpRecordSearch');
stub('handlers/게임/룰렛그림.js', 'warmUp');
stub('forms/코블몬/index.js', 'startCobblemonOpenTimer');
stub('handlers/레벨/레벨링.js', 'startVoiceXpTicker');

process.on('exit', () => {});
require(path.join(ROOT, 'index.js'));

const listeners = (ev) => client.listeners(ev);
let readyDone = false;
async function ensureReady() {
  if (readyDone) return;
  readyDone = true;
  client.readyAt = new Date(); client.readyTimestamp = Date.now();
  await Promise.all(listeners(D.Events.ClientReady).map(f => f(client)));
}

// 켜자마자 "로그인 완료" 처리 — 안 하면 index.js 의 로그인 대기 진단이 진짜 디스코드 API 에 접속을 시도하며 로그를 계속 찍는다
ensureReady().catch(e => origErr('준비 처리 실패:', e));

// ───────────────────────── 환경 적용 ─────────────────────────
function applyEnv() {
  timeOffset = Math.round((env.timeOffsetHours || 0) * 3600e3);
  // 관리자·소유자 여부는 config.js 의 배열을 제자리에서 고쳐 적용한다(핸들러들이 같은 배열을 들고 있음)
  const admins = new Set(ADMIN_DEFAULT.filter(id => !(id in env.users)));
  const owners = new Set(OWNER_DEFAULT.filter(id => !(id in env.users)));
  for (const [id, u] of Object.entries(env.users)) { if (u.admin) admins.add(id); if (u.owner) owners.add(id); }
  cfg.ADMIN_IDS.splice(0, cfg.ADMIN_IDS.length, ...admins);
  if (cfg.OWNER_IDS) cfg.OWNER_IDS.splice(0, cfg.OWNER_IDS.length, ...owners);
  for (const [id, u] of Object.entries(env.users)) if (userCache.has(id)) { const fu = userCache.get(id); fu.username = fu.globalName = fu.displayName = fu.tag = u.name; }
  bump();
}
applyEnv();
try { // 재시작 직전의 환경 설정이 남아 있으면 이어받는다(한 번만)
  const all = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8'));
  if (all.__직전) { env = { ...defaultEnv(), ...all.__직전, users: { ...defaultEnv().users, ...all.__직전.users } }; delete all.__직전; fs.writeFileSync(PRESET_FILE, JSON.stringify(all, null, 2)); applyEnv(); }
} catch {}

// ───────────────────────── 요청 처리 ─────────────────────────
const toolsByName = {};
function commandList() {
  return [...client.commands.values()].map(c => ({ ...c.data.toJSON() })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

async function runInteraction(label, kind, a) {
  await ensureReady();
  const trace = { id: String(++seq), at: Date.now(), user: getUser(a.userId).username, label, steps: [], done: false, ms: 0 };
  traces.push(trace); if (traces.length > 200) traces.shift();
  a.label = `${trace.user} 님이 ${label}`;
  const it = makeInteraction(kind, a);
  const started = Date.now();
  await als.run(trace, async () => {
    note('입력', `${trace.user} · ${label}  (서버 ${env.guild === 'main' ? '본서버' : '테스트서버'} · #${getChannel(a.channelId).name})`);
    if (env.latencyMs > 0) { note('설정', `⏳ 인위적 지연 ${env.latencyMs}ms`); await wait(env.latencyMs); }
    try { for (const f of listeners('interactionCreate')) await f(it); }
    catch (e) { note('오류', `핸들러 밖으로 예외가 새어 나옴: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`); }
    await wait(60);
    if (!it._acked) note('규칙위반', '⚠️ 아무 응답도 하지 않음 — 디스코드에서는 사용자 화면에 "상호작용 실패"가 뜸');
  });
  trace.done = true; trace.ms = Date.now() - started;
  bump();
  return trace;
}

function findMessage(id) { for (const ch of channels.values()) { const m = ch.list.find(x => x.id === id); if (m) return m; } return null; }
function findComponent(list, customId) { let r = null; eachC(list, (c) => { if (c.custom_id === customId && !r) r = c; }); return r; }

function serializeMessage(m) {
  return {
    id: m.id, author: { id: m.author.id, name: m.author.username, bot: !!m.author.bot }, content: m.content, embeds: m.embeds,
    components: m.components, files: m.files, flags: m._flags, ephemeral: !!m.ephemeralTo, at: m.createdTimestamp, edited: !!m.editedTimestamp,
    replyTo: m.replyTo, label: m.interactionLabel, thinking: !!m.thinking, v2: m.isV2,
  };
}

function viewState(q) {
  const channelId = q.channel || env.channelId;
  const ch = getChannel(channelId);
  const dmId = `dm:${env.userId}`;
  const cur = channelId === 'dm' ? getChannel(dmId) : ch;
  const visible = cur.list.filter(m => !m.deleted && (!m.ephemeralTo || m.ephemeralTo === env.userId));
  return {
    revision, env, guilds: [{ key: 'test', name: '테스트 서버' }, { key: 'main', name: '본서버' }],
    channels: channelDefs(), roles: ROLES, users: DEFAULT_USERS.map(u => ({ id: u.id, name: env.users[u.id].name })),
    commands: commandList(),
    messages: visible.slice(-120).map(serializeMessage),
    modal: pendingModal && pendingModal.userId === env.userId ? pendingModal : null,
    traces: traces.slice(-60).map(t => ({ ...t })), sysLog: sysLog.slice(-40),
    raid: (() => { try { return require(path.join(ROOT, 'handlers/레이드/index.js')).isPlaygroundPaused(curGuildId()); } catch { return false; } })(),
  };
}

const readJson = (req) => new Promise((res, rej) => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } }); });
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }; // 화면.html 을 파일로 직접 열어도(file://) 붙을 수 있게
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(obj)); };

// 화면.html 은 임시 복사본이 아니라 원본 파일(SIM_UI)을 매번 읽는다 → 고치고 저장하면 바로 반영, 열려 있는 화면은 자동 새로고침
const UI_FILE = process.env.SIM_UI || path.join(ROOT, '화면.html');
let reloadTimer = null;
try {
  fs.watch(UI_FILE, () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { for (const res of sse) res.write('data: reload\n\n'); }, 150); });
} catch (e) { origWarn('화면.html 변경 감시 실패(수동 새로고침 필요):', e.message); }
const presets = () => { try { return JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8')); } catch { return {}; } };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(UI_FILE)); }
  if (p === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...CORS });
    res.write(`data: ${revision}\n\n`); sse.add(res); req.on('close', () => sse.delete(res)); return;
  }
  if (req.method === 'GET' && p === '/api/state') return send(res, 200, viewState(Object.fromEntries(url.searchParams)));
  if (req.method === 'GET' && p === '/api/presets') return send(res, 200, presets());
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
  const b = await readJson(req);
  const curCh = () => (b.channelId === 'dm' ? `dm:${env.userId}` : (b.channelId || env.channelId));

  if (p === '/api/restart') { // 봇 코드를 고친 뒤 새로 복사해서 다시 띄운다(실행.js 가 종료 코드 75 를 보고 재시작)
    const all = presets(); all.__직전 = JSON.parse(JSON.stringify(env)); try { fs.writeFileSync(PRESET_FILE, JSON.stringify(all, null, 2)); } catch {} // 재시작해도 환경 설정 유지
    send(res, 200, { ok: true }); for (const r of sse) r.write('data: restarting\n\n');
    setTimeout(() => process.exit(75), 200); return;
  }
  if (p === '/api/env') { // 환경 설정 바꾸기(일부 항목만 보내도 됨)
    const { users, ...rest } = b;
    Object.assign(env, rest);
    if (users) for (const [id, u] of Object.entries(users)) Object.assign(env.users[id] ??= {}, u);
    applyEnv(); return send(res, 200, { ok: true });
  }
  if (p === '/api/env/reset') { env = defaultEnv(); applyEnv(); return send(res, 200, { ok: true }); }
  if (p === '/api/preset/save') { const all = presets(); all[b.name] = JSON.parse(JSON.stringify(env)); fs.writeFileSync(PRESET_FILE, JSON.stringify(all, null, 2)); return send(res, 200, { ok: true }); }
  if (p === '/api/preset/load') { const all = presets(); if (!all[b.name]) return send(res, 404, { error: '없는 프리셋' }); env = { ...defaultEnv(), ...all[b.name], users: { ...defaultEnv().users, ...all[b.name].users } }; applyEnv(); return send(res, 200, { ok: true }); }
  if (p === '/api/preset/delete') { const all = presets(); delete all[b.name]; fs.writeFileSync(PRESET_FILE, JSON.stringify(all, null, 2)); return send(res, 200, { ok: true }); }
  if (p === '/api/clear') { for (const ch of channels.values()) ch.list.length = 0; traces.length = 0; sysLog.length = 0; pendingModal = null; bump(); return send(res, 200, { ok: true }); }

  if (p === '/api/slash') {
    const def = client.commands.get(b.command)?.data.toJSON();
    if (!def) return send(res, 404, { error: '없는 명령어' });
    const optText = Object.entries(b.options || {}).filter(([k]) => k !== '__sub').map(([k, v]) => `${k}:${v}`).join(' ');
    runInteraction(`/${b.command}${optText ? ' ' + optText : ''}`, 'slash', { userId: env.userId, channelId: curCh(), commandName: b.command, commandDef: def, options: b.options });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/click' || p === '/api/select') {
    const m = findMessage(b.messageId);
    if (!m) return send(res, 404, { error: '메시지가 없음(이미 삭제됨)' });
    const c = findComponent(m.components, b.customId);
    if (!c) return send(res, 404, { error: '그 버튼은 더 이상 메시지에 없음' });
    if (c.disabled) return send(res, 400, { error: '비활성화된 버튼' });
    const isSel = p === '/api/select';
    const kind = isSel ? (c.type === 5 ? 'userselect' : 'select') : 'button';
    const label = isSel ? `선택 메뉴 ${b.customId} → [${(b.values || []).join(', ')}]` : `버튼 "${c.label ?? c.emoji?.name ?? ''}" 클릭 (${b.customId})`;
    runInteraction(label, kind, { userId: env.userId, channelId: m.channelId, message: m, customId: b.customId, values: b.values, userValues: c.type === 5 ? b.values : [], component: c });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/modal') {
    const pm = pendingModal; if (!pm) return send(res, 400, { error: '열린 입력창이 없음' });
    pendingModal = null; bump();
    runInteraction(`입력창 제출 (${pm.customId})`, 'modal', { userId: pm.userId, channelId: pm.channelId, customId: pm.customId, fields: b.fields, message: null });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/modal/cancel') { pendingModal = null; bump(); return send(res, 200, { ok: true }); }
  if (p === '/api/say') {
    await ensureReady();
    const ch = getChannel(curCh());
    const author = getUser(env.userId);
    const m = post(ch, author, { content: b.text }, { replyTo: b.replyTo });
    const trace = { id: String(++seq), at: Date.now(), user: author.username, label: `채팅 "${String(b.text).slice(0, 30)}"`, steps: [{ kind: '입력', text: `${author.username} · 채팅 "${b.text}" (#${ch.name})` }], done: false, ms: 0 };
    traces.push(trace);
    await als.run(trace, async () => { for (const f of listeners('messageCreate')) { try { await f(m); } catch (e) { note('오류', `messageCreate 예외: ${e.message}`); } } });
    trace.done = true; bump();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/tool') { // 개발용 상황 만들기
    await ensureReady();
    const ch = getChannel(curCh());
    const fakeIt = { guildId: curGuildId(), channel: ch, client };
    const trace = { id: String(++seq), at: Date.now(), user: '도구', label: `도구: ${b.name}`, steps: [], done: false, ms: 0 };
    traces.push(trace);
    await als.run(trace, async () => {
      try {
        const raid = require(path.join(ROOT, 'handlers/레이드/index.js'));
        if (b.name === 'raid-spawn') { note('설정', '👾 레이드 몬스터 출현'); const r = await raid.forceSpawnRaid(fakeIt, b.arg || null); if (typeof r === 'string') note('경고', r); }
        else if (b.name === 'raid-end') note('설정', `레이드 종료: ${await raid.forceEndRaid(curGuildId())}`);
        else if (b.name === 'time') { env.timeOffsetHours = Number(env.timeOffsetHours || 0) + Number(b.arg || 0); applyEnv(); note('설정', `🕒 가상 시계 ${env.timeOffsetHours}시간 이동`); }
        else note('경고', `알 수 없는 도구 ${b.name}`);
      } catch (e) { note('오류', `도구 실행 실패: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`); }
    });
    trace.done = true; bump();
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

http.createServer((req, res) => { handle(req, res).catch(e => { origErr(e); try { send(res, 500, { error: e.message }); } catch {} }); }).listen(PORT, '127.0.0.1', () => {
  console.log(`\n🎮 디스코드 시뮬레이터: http://localhost:${PORT}\n   (실제 봇 코드가 가짜 디스코드 위에서 돕니다. 저장 파일은 임시 폴더라 진짜 DB는 건드리지 않아요)\n`);
});
