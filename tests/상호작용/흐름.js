// 상호작용 흐름 테스트: 실제 핸들러를 가짜 디스코드 객체로 돌려, 모든 응답이 디스코드 규칙을 지키는지 본다.
// 직접 실행하지 말고 node tests/상호작용/실행.js 로 — 임시 폴더에 복사해서 돌린다(DB/ 를 건드리지 않게).
//
// 응답마다 검사하는 것:
//  - v2 컴포넌트면 IsComponentsV2 플래그가 있고 content/embeds 가 비어 있다
//  - 컴포넌트 데이터가 discord.js 검증(toJSON)을 통과한다, 글자 4000자·컴포넌트 40개·최상위 10개 이내
//  - 이미 v2로 올라간 메시지를 평문(content)으로 되돌려 고치지 않는다(디스코드가 거부함)
const path = require('path');
const root = __dirname; // 실행.js 가 임시 폴더 맨 위(run.js)로 복사해 돌리므로 handlers/ 는 바로 옆에 있다
const { MessageFlags } = require('discord.js');

const V2 = MessageFlags.IsComponentsV2;
const problems = [];
let checks = 0;
let flowName = '';
const fail = (msg) => { problems.push(`[${flowName}] ${msg}`); };

// ── 응답 검사 ─────────────────────────────────────
function countComponents(list) {
  let n = 0;
  for (const c of list || []) { n += 1 + countComponents(c.components); if (c.accessory) n += 1; }
  return n;
}
function totalText(list) {
  let n = 0;
  for (const c of list || []) { if (typeof c.content === 'string') n += c.content.length; n += totalText(c.components); }
  return n;
}
const V2_TYPES = new Set([9, 10, 11, 12, 13, 14, 17]);

function lint(where, p, targetIsV2 = null) {
  checks++;
  if (typeof p === 'string') { fail(`${where}: 문자열로 보냄(평문)`); return false; }
  const isV2 = !!((p.flags ?? 0) & V2);
  let json = [];
  try {
    json = (p.components || []).map(c => (c.toJSON ? c.toJSON() : c));
  } catch (err) {
    fail(`${where}: 컴포넌트 검증 실패 — ${err.message.split('\n')[0]}`);
    return isV2;
  }
  const usesV2 = json.some(c => V2_TYPES.has(c.type));
  if (usesV2 && !isV2) fail(`${where}: v2 컴포넌트인데 IsComponentsV2 플래그가 없음`);
  if (isV2) {
    if (p.content) fail(`${where}: v2 메시지에 content 가 있음("${String(p.content).slice(0, 20)}")`);
    if (p.embeds && p.embeds.length) fail(`${where}: v2 메시지에 embeds 가 있음`);
    if (json.length > 10) fail(`${where}: 최상위 컴포넌트 ${json.length}개(>10)`);
    if (countComponents(json) > 40) fail(`${where}: 컴포넌트 ${countComponents(json)}개(>40)`);
    if (totalText(json) > 4000) fail(`${where}: 글자 ${totalText(json)}자(>4000)`);
  }
  if (targetIsV2 === true && !isV2 && (p.content !== undefined || p.components !== undefined || p.embeds !== undefined)) {
    fail(`${where}: 이미 v2인 메시지를 평문으로 고침(디스코드가 거부함)`);
  }
  return isV2;
}

// ── 가짜 디스코드 객체 ───────────────────────────────
let seq = 1000;
class FakeMsg {
  constructor(payload, channel) {
    this.id = String(++seq);
    this.channel = channel; this.channelId = channel?.id ?? 'c1'; this.guildId = 'g1';
    this.url = `https://discord.com/channels/g1/${this.channelId}/${this.id}`;
    this.author = { id: 'bot' };
    this.setFrom(payload, true);
    this.deleted = false;
  }
  setFrom(p, first = false) {
    const isV2 = lint(first ? '메시지 전송' : '메시지 수정', p, first ? null : this.isV2);
    if (first || (p.flags ?? 0) & V2) this.isV2 = isV2;
    if (p.components) this.components = p.components.map(c => (c.toJSON ? c.toJSON() : c));
    this.embeds = [];
  }
  async edit(p) { if (this.deleted) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); this.setFrom(p); return this; }
  async delete() { this.deleted = true; }
  async fetch() { return this; }
}
function mkChannel(id = 'c1') {
  const ch = { id, name: id, guildId: 'g1', sent: [], isTextBased: () => true };
  ch.send = async (p) => { const m = new FakeMsg(p, ch); ch.sent.push(m); return m; };
  ch.messages = { fetch: async (mid) => ch.sent.find(m => m.id === mid) ?? null, delete: async () => {} };
  ch.bulkDelete = async () => new Map();
  return ch;
}
const client = {
  user: { id: 'bot', username: 'ARCADE', displayAvatarURL: () => 'https://x/a.png' },
  users: { fetch: async (id) => ({ id, username: id, send: async (p) => new FakeMsg(p, mkChannel('dm')) }) },
  channels: { fetch: async () => channel, cache: new Map() },
  guilds: { cache: new Map() },
};
const channel = mkChannel('c1');
channel.client = client;
client.channels.fetch = async () => channel;

function mkInteraction({ user = 'u1', customId, values, fields = {}, message = null, command = null, options = {}, guildId = 'g1' } = {}) {
  const it = {
    id: String(++seq), client, guildId, guild: { id: guildId, roles: { cache: { find: () => null } }, members: { fetch: async () => null }, channels: { fetch: async () => new Map() } },
    channel, channelId: channel.id,
    user: { id: user, username: `이름${user}`, globalName: `이름${user}`, displayAvatarURL: () => 'https://x/u.png' },
    member: { displayName: `이름${user}` },
    customId, values, commandName: command, message, replied: false, deferred: false,
    fields: { getTextInputValue: (k) => fields[k] ?? '' },
    options: { getUser: (k) => options[k] ?? null, getMember: () => null },
    isFromMessage() { return !!message; },
    isButton() { return !!customId; },
    isChatInputCommand() { return !!command; },
    async reply(p) { lint('reply', p); this.replied = true; this._reply = new FakeMsg(p, channel); return this._reply; },
    async deferReply() { this.deferred = true; },
    async deferUpdate() { this.deferred = true; },
    async update(p) {
      if (!message) { fail('update 인데 메시지 없음'); return; }
      message.setFrom(p); this.replied = true;
    },
    async editReply(p) {
      const t = this._reply ?? message;
      if (t) t.setFrom(p); else { lint('editReply', p); this._reply = new FakeMsg(p, channel); }
    },
    async followUp(p) { lint('followUp', p); return new FakeMsg(p, channel); },
    async deleteReply() {},
    async fetchReply() { return this._reply ?? message; }, // update 로 응답했으면 그 메시지가 곧 응답 메시지
    async showModal() { this.modalShown = true; },
  };
  return it;
}

// ── 흐름 ────────────────────────────────────────────
const ADMIN = '457437911869161472';
async function flow(name, fn) {
  flowName = name;
  const before = problems.length;
  try { await fn(); } catch (err) { fail(`예외 발생: ${err.stack.split('\n').slice(0, 3).join(' | ')}`); }
  console.log(`${problems.length === before ? '✅' : '❌'} ${name}`);
}
const assert = (cond, msg) => { if (!cond) fail(msg); };

(async () => {
  const naejeon = require(path.join(root, 'handlers/매치/내전.js'));
  const mojip = require(path.join(root, 'handlers/매치/모집.js'));
  const team = require(path.join(root, 'handlers/매치/팀.js'));
  const common = require(path.join(root, 'handlers/매치/공용.js'));

  // ── 내전 ──
  await flow('내전: 만들기 → 공개 게시 → 참가 → 관리 메뉴 → 마감/해제 → 취소', async () => {
    await naejeon.handleNaejeonModal(mkInteraction({ user: ADMIN, customId: 'naejeon:modal:lol', fields: { title: '롤 내전', datetime: '내일 8시', players: '2', description: '메모' } }));
    const pub = mkInteraction({ user: ADMIN, customId: 'naejeon:publish', message: new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('미리보기'), channel) });
    await naejeon.handleNaejeonButton(pub);
    const match = [...client.naejeonMatches.values()][0];
    assert(match, '매치가 만들어지지 않음');
    if (!match) return;
    const id = match.message.id;
    for (const u of ['u2', 'u3']) await naejeon.handleNaejeonButton(mkInteraction({ user: u, customId: 'naejeon:join', message: match.message }));
    assert(match.participants.length === 2, `참가자 ${match.participants.length}명(2 기대)`);
    assert(match.closed, '정원이 차도 자동 마감되지 않음');
    const manage = mkInteraction({ user: ADMIN, customId: 'naejeon:manage', message: match.message });
    await naejeon.handleNaejeonButton(manage);
    const menuMsg = manage._reply;
    assert(menuMsg, '관리 메뉴가 안 뜸');
    for (const cid of [`naejeon:match_reopen:${id}`, `naejeon:match_close:${id}`, `naejeon:manage_back:${id}`, `naejeon:team_builder:${id}`, `naejeon:match_mention:${id}`, `naejeon:match_cancel:${id}`, `naejeon:manage_back:${id}`]) {
      await naejeon.handleNaejeonButton(mkInteraction({ user: ADMIN, customId: cid, message: menuMsg }));
    }
    await naejeon.handleTeamAssign(mkInteraction({ user: ADMIN, customId: `naejeon:team_assign:${id}`, values: ['u1', 'u2'].filter(x => match.participants.some(p => p.id === x)), message: menuMsg }));
    await team.handleTeamButton(mkInteraction({ user: ADMIN, customId: `team:shuffle_start:${id}`, message: menuMsg }));
    await naejeon.handleNaejeonButton(mkInteraction({ user: ADMIN, customId: `naejeon:match_cancel_confirm:${id}`, message: menuMsg }));
    assert(!client.naejeonMatches.has(id), '취소했는데 매치가 남아 있음');
    assert(match.message.isV2, '게시글이 v2가 아님');
  });

  await flow('내전: 권한 없음·만료·잘못된 입력 안내', async () => {
    await naejeon.handleNaejeonModal(mkInteraction({ customId: 'naejeon:modal:lol', fields: { title: '', datetime: 'x', players: 'abc', description: '' } }));
    await naejeon.handleNaejeonButton(mkInteraction({ customId: 'naejeon:join', message: new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('x'), channel) }));
    await naejeon.handleNaejeonButton(mkInteraction({ customId: 'naejeon:manage', message: new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('x'), channel) }));
    await naejeon.handleNaejeonButton(mkInteraction({ customId: 'naejeon:publish' }));
  });

  // ── 모집 ──
  await flow('모집: 만들기 → 게시 → 참가/취소 → 관리 → 마감 → 취소', async () => {
    await mojip.handleMojipModal(mkInteraction({ user: ADMIN, customId: 'mojip:modal:custom', fields: { game_name: '마인크래프트', title: '', datetime: '내일', players: '4', description: '' } }));
    await mojip.handleMojipButton(mkInteraction({ user: ADMIN, customId: 'mojip:publish', message: new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('p'), channel) }));
    const match = [...client.mojipMatches.values()][0];
    assert(match, '모집이 만들어지지 않음');
    if (!match) return;
    const id = match.message.id;
    await mojip.handleMojipButton(mkInteraction({ user: 'u2', customId: 'mojip:join', message: match.message }));
    await mojip.handleMojipButton(mkInteraction({ user: 'u2', customId: `mojip:leave:${id}`, message: new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('l'), channel) }));
    const manage = mkInteraction({ user: ADMIN, customId: 'mojip:manage', message: match.message });
    await mojip.handleMojipButton(manage);
    for (const cid of [`mojip:match_close:${id}`, `mojip:match_reopen:${id}`, `mojip:match_cancel:${id}`, `mojip:match_cancel_confirm:${id}`]) {
      await mojip.handleMojipButton(mkInteraction({ user: ADMIN, customId: cid, message: manage._reply }));
    }
  });

  await flow('모집: 참가해서 카드를 고쳐도 역할 멘션 줄이 남는다', async () => {
    await mojip.handleMojipModal(mkInteraction({ user: ADMIN, customId: 'mojip:modal:lol', fields: { title: '', datetime: '내일', players: '5', description: '' } }));
    const pub = mkInteraction({ user: ADMIN, customId: 'mojip:publish', message: new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('p'), channel) });
    pub.guild.roles.cache.find = () => ({ id: 'ROLE1' });
    await mojip.handleMojipButton(pub);
    const m = [...client.mojipMatches.values()].at(-1);
    const has = () => JSON.stringify(m.message.components).includes('<@&ROLE1>');
    assert(has(), '게시 직후 역할 멘션 줄');
    await mojip.handleMojipButton(mkInteraction({ user: 'u9', customId: 'mojip:join', message: m.message }));
    assert(has(), '참가 후 카드를 고쳐도 역할 멘션 줄 유지');
    // 멘션 줄은 카드(컨테이너) 안 맨 위 글자
    // (게임 썸네일이 있으면 썸네일과 같은 섹션의 첫 글자로 들어간다)
    const first = m.message.components.find(c => c.type === 17)?.components?.[0];
    const top = first?.type === 9 ? first.components?.[0] : first;
    assert(top?.type === 10 && top.content.includes('<@&ROLE1>'), '역할 멘션은 카드 안 맨 위 글자');

    // 불러오기: 새 메시지로 다시 올리면서 역할 멘션도 다시 한 번(allowedMentions 에 역할)
    const reload = require(path.join(root, 'handlers/매치/불러오기.js'));
    const origSend = channel.send; let sentPayload = null;
    channel.send = async (p) => { sentPayload = p; return origSend(p); };
    const rit = mkInteraction({ user: ADMIN, customId: 'reload:select', values: [`mojip:${m.message.id}`], message: new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('r'), channel) });
    rit.guild.roles.cache.find = () => ({ id: 'ROLE1' });
    await reload.handleRMatchSelect(rit);
    channel.send = origSend;
    assert(sentPayload && sentPayload.allowedMentions.roles?.join() === 'ROLE1', '불러오기로 다시 올릴 때 역할 멘션 알림');
    const m2 = [...client.mojipMatches.values()].at(-1);
    assert(JSON.stringify(m2.message.components).includes('<@&ROLE1>'), '다시 올린 카드에도 역할 멘션 줄');
    await mojip.handleMojipButton(mkInteraction({ user: 'u8', customId: 'mojip:join', message: m2.message }));
    assert(JSON.stringify(m2.message.components).includes('<@&ROLE1>'), '다시 올린 뒤 고쳐도 멘션 줄 유지');

    // 새로고침(게시물 최신화): 멘션 줄이 없던 옛 카드에도 역할 줄이 붙는다(알림 없이 수정만)
    const { refreshPostedMessages } = require(path.join(root, 'handlers/관리/최신화.js'));
    m2.roleContent = ''; // 옛 카드처럼 저장된 역할 값이 없는 상태
    await m2.message.edit(require(path.join(root, 'handlers/매치/모집.js')).buildMojipMessagePayload(m2));
    assert(!JSON.stringify(m2.message.components).includes('<@&ROLE1>'), '(전제) 멘션 줄 없는 옛 카드');
    const guild = { roles: { cache: { find: () => ({ id: 'ROLE1' }) } } };
    m2.guildId = 'g1'; client.guilds.cache.set('g1', guild);
    await refreshPostedMessages(client, { includeMatches: true });
    client.guilds.cache.delete('g1');
    assert(JSON.stringify(m2.message.components).includes('<@&ROLE1>'), '새로고침하면 옛 카드에도 역할 멘션 줄이 붙음');
  });

  // ── 틱택토 ──
  const ttt =require(path.join(root, 'handlers/게임/틱택토.js'));
  await flow('틱택토: 로비 → 참가 → 시작 → 한 판 → 재대결 → 종료', async () => {
    const start = mkInteraction({ user: 'u1', command: '틱택토' });
    await ttt.startTttCommand(start);
    const lobby = start._reply;
    const gid = [...client.tttGames?.keys?.() ?? []][0] ?? start.id;
    await ttt.handleTttButton(mkInteraction({ user: 'u2', customId: `ttt:join:${start.id}`, message: lobby }));
    await ttt.handleTttButton(mkInteraction({ user: 'u1', customId: `ttt:toggleinf:${start.id}`, message: lobby })); // 무한모드 켰다가
    await ttt.handleTttButton(mkInteraction({ user: 'u1', customId: `ttt:toggleinf:${start.id}`, message: lobby })); // 다시 끈다(일반 판에서 승부가 나도록)
    await ttt.handleTttButton(mkInteraction({ user: 'u1', customId: `ttt:start:${start.id}`, message: lobby }));
    // 번갈아 두기(선공은 무작위라 현재 차례 유저를 찾아서 둔다)
    const games = client.tttGames || client.dummy;
    const order = [0, 3, 1, 4, 2]; // X 가 0,1,2 로 승리
    let turnUsers = null;
    for (let i = 0; i < 9; i++) { // 빈 칸을 순서대로 채우면 X 가 2-4-6 대각선으로 이긴다
      const g = [...(client.tttGames?.values?.() ?? [])][0];
      if (!g) break;
      const who = g.players[g.currentTurn];
      await ttt.handleTttButton(mkInteraction({ user: who, customId: `ttt:move:${g.id}:${g.board.findIndex(c => c === '') + 0}`, message: lobby }));
      if (g.status === 'finished') break;
    }
    // 끝났으면 재대결/종료 버튼
    const finished = lobby;
    const comps = JSON.stringify(finished.components || []);
    const m = /ttt:rematch:([^"]+)/.exec(comps);
    assert(m, '틱택토 한 판이 끝나지 않았거나 재대결 버튼이 없음 — 남은 게임 ' + JSON.stringify([...(client.tttGames?.values?.() ?? [])].map(g => ({ st: g.status, board: g.board.join(','), turn: g.currentTurn }))) + ' / 마지막 화면 ' + comps.slice(0, 300));
    if (m) {
      await ttt.handleTttButton(mkInteraction({ user: 'u1', customId: `ttt:rematch:${m[1]}`, message: finished }));
      await ttt.handleTttButton(mkInteraction({ user: 'u1', customId: `ttt:close:${m[1].split(':')[0]}:${m[1].split(':')[1]}`, message: finished }));
    }
    // 방장 취소
    const s2 = mkInteraction({ user: 'u1', command: '틱택토' });
    await ttt.startTttCommand(s2);
    await ttt.handleTttButton(mkInteraction({ user: 'u1', customId: `ttt:cancel:${s2.id}`, message: s2._reply }));
  });

  // ── 오목 ──
  const omok = require(path.join(root, 'handlers/게임/오목.js'));
  await flow('오목: 로비 → 봇과 시작 → 포기 → 재대결 → 종료', async () => {
    const s = mkInteraction({ user: 'u1', command: '오목' });
    await omok.startOmokCommand(s);
    await omok.handleOmokButton(mkInteraction({ user: 'u1', customId: `omok:bot_start:${s.id}`, message: s._reply }));
    await omok.handleOmokButton(mkInteraction({ user: 'u1', customId: `omok:resign:${s.id}`, message: s._reply }));
    await new Promise(r => setTimeout(r, 200));
    const comps = JSON.stringify(s._reply.components || []);
    const m = /omok:rematch:([^"]+)/.exec(comps);
    assert(m, '오목 포기 뒤 재대결 버튼이 없음 — 남은 게임 ' + JSON.stringify([...(client.omokGames?.values?.() ?? [])].map(g => g.status)) + ' / 마지막 화면 ' + comps.slice(0, 300));
    if (m) {
      await omok.handleOmokButton(mkInteraction({ user: 'u1', customId: `omok:rematch:${m[1]}`, message: s._reply }));
      await omok.handleOmokButton(mkInteraction({ user: 'u1', customId: `omok:close:${m[1]}`, message: s._reply }));
    }
    const s2 = mkInteraction({ user: 'u1', command: '오목' });
    await omok.startOmokCommand(s2);
    await omok.handleOmokButton(mkInteraction({ user: 'u1', customId: `omok:cancel:${s2.id}`, message: s2._reply }));
  });

  // ── 끝말잇기 ──
  const wc = require(path.join(root, 'handlers/게임/끝말잇기.js'));
  await flow('끝말잇기: 로비 → 참가 → 취소 / 봇과 시작 → 포기', async () => {
    const s = mkInteraction({ user: 'u1', command: '끝말잇기' });
    await wc.startWcCommand(s);
    await wc.handleWcButton(mkInteraction({ user: 'u2', customId: `wc:join:${s.id}`, message: s._reply }));
    await wc.handleWcButton(mkInteraction({ user: 'u1', customId: `wc:cancel:${s.id}`, message: s._reply }));
    const s2 = mkInteraction({ user: 'u1', command: '끝말잇기' });
    await wc.startWcCommand(s2);
    await wc.handleWcButton(mkInteraction({ user: 'u1', customId: `wc:bot_start:${s2.id}`, message: s2._reply }));
    await wc.handleWcButton(mkInteraction({ user: 'u1', customId: `wc:giveup:${s2.id}`, message: s2._reply }));
    await new Promise(r => setTimeout(r, 200));
  });

  // ── 룰렛 ──
  const lv = require(path.join(root, 'handlers/레벨/레벨링.js'));
  const roulette = require(path.join(root, 'handlers/게임/룰렛.js'));
  await flow('룰렛: 로비 → 베팅 → 돌리기 → 결과 / 취소', async () => {
    lv.loadLevels(); lv.applyXp('g1', 'u1', 800, 'test');
    const s = mkInteraction({ user: 'u1', command: '룰렛' });
    await roulette.startRouletteCommand(s);
    const lobbyId = s.id;
    await roulette.handleRouletteButton(mkInteraction({ user: 'u1', customId: `roulette:bet:${lobbyId}:50`, message: s._reply }));
    await roulette.handleRouletteButton(mkInteraction({ user: 'u1', customId: `roulette:max:${lobbyId}`, message: s._reply }));
    const spin = mkInteraction({ user: 'u1', customId: `roulette:spin:${lobbyId}`, message: s._reply });
    await roulette.handleRouletteButton(spin);
    assert(channel.sent.some(m => JSON.stringify(m.components || []).includes('룰렛머신')), '룰렛 결과 카드가 채널에 안 올라옴');
    const s2 = mkInteraction({ user: 'u2', command: '룰렛' });
    lv.applyXp('g1', 'u2', 500, 'test');
    await roulette.startRouletteCommand(s2);
    await roulette.handleRouletteButton(mkInteraction({ user: 'u2', customId: `roulette:cancel:${s2.id}`, message: s2._reply }));
  });

  // ── 룰렛 동시 사용 부하: 여러 명이 한꺼번에 돌려도 모두 결과를 받고 서버가 버텨야 한다 ──
  await flow('룰렛: 50명이 동시에 돌려도 전원 결과를 받고 메모리가 늘지 않는다', async () => {
    const N = 50;
    const users = Array.from({ length: N }, (_, i) => `bulk${i}`);
    for (const u of users) lv.applyXp('g1', u, 800, 'test');
    channel.sent.length = 0;
    const rssBefore = process.memoryUsage().rss;
    const t0 = Date.now();
    await Promise.all(users.map(async (u) => {
      const s = mkInteraction({ user: u, command: '룰렛' });
      await roulette.startRouletteCommand(s);
      // 800 XP 를 받으면 현재 레벨 안 XP 가 30 이라 최소 베팅(10 XP)으로 건다
      await roulette.handleRouletteButton(mkInteraction({ user: u, customId: `roulette:bet:${s.id}:10`, message: s._reply }));
      await roulette.handleRouletteButton(mkInteraction({ user: u, customId: `roulette:spin:${s.id}`, message: s._reply }));
    }));
    const ms = Date.now() - t0;
    const probe = mkInteraction({ user: users[0], command: '룰렛' });
    await roulette.startRouletteCommand(probe);
    const probeText = JSON.stringify(probe._reply?.components || []).slice(0, 200);
    const results = channel.sent.filter(m => JSON.stringify(m.components || []).includes('## 🎰') || JSON.stringify(m.components || []).includes('룰렛머신'));
    assert(results.length === N, `결과 메시지 ${results.length}개(${N} 기대) — 첫 유저 재시도 응답: ${probeText}`);
    // 모든 결과가 최종 화면(결과 문구 포함)으로 끝났는지 — 마지막 수정이 '결과'를 담고 있어야 한다
    const done = channel.sent.filter(m => JSON.stringify(m.components || []).includes('결과')).length;
    assert(done === N, `최종 결과 화면 ${done}개(${N} 기대)`);
    assert(ms < 15000, `50명 동시 처리에 ${ms}ms(15초 이내 기대)`);
    const grewMb = (process.memoryUsage().rss - rssBefore) / 1048576;
    assert(grewMb < 60, `메모리가 ${grewMb.toFixed(1)}MB 늘어남(60MB 이내 기대)`);
    console.log(`   (50명 동시: ${ms}ms, 메모리 +${grewMb.toFixed(1)}MB)`);
  });

  // ── /관리 ──
  const home = require(path.join(root, 'handlers/관리/홈.js'));
  const panel = require(path.join(root, 'handlers/관리/패널.js'));
  const xp = require(path.join(root, 'handlers/관리/XP.js'));
  const quizAdmin = require(path.join(root, 'handlers/관리/퀴즈관리.js'));
  await flow('/관리: 홈 → 소식 알림 → 퀴즈 → 패널 → 채널 관리 → XP 관리/조정 → 홈', async () => {
    const s = mkInteraction({ user: ADMIN, command: '관리' });
    await home.openAdminHome(s);
    const msg = s._reply;
    assert(msg, '/관리 홈이 안 뜸');
    for (const cid of ['admin:home', 'admin:patch:toggle', 'admin:patch:check', 'admin:patch:test', 'admin:quiz', 'admin:home', 'admin:panels', 'admin:home', 'admin:channel', 'panel:menu:admin', 'admin:home']) {
      const it = mkInteraction({ user: ADMIN, customId: cid, message: msg });
      if (cid.startsWith('panel:')) await panel.handlePanelButton(it);
      else await home.handleAdminButton(it);
    }
    for (const cid of ['xp:menu:manage', 'xp:mng:boost', 'xp:mng:raidauto', 'xp:mng:farm', 'xp:mngno', 'xp:menu:home', 'xp:menu:adjust', 'xp:menu:home']) {
      await xp.handleXpButton(mkInteraction({ user: ADMIN, customId: cid, message: msg }));
    }
    for (const cid of ['quiz:refresh', 'quiz:pause', 'quiz:resume']) {
      await quizAdmin.handleQuizAdminButton(mkInteraction({ user: ADMIN, customId: cid, message: msg }));
    }
    // 권한 없는 사람
    const deny = mkInteraction({ user: 'u9', command: '관리' });
    await home.openAdminHome(deny);
    const deny2 = mkInteraction({ user: 'u9', customId: 'admin:home', message: msg });
    await home.handleAdminButton(deny2);
  });

  await flow('채널 청소: 어느 채널에서 눌러도 게임모집 채널만 청소', async () => {
    const config = require(path.join(root, 'config.js'));
    const menuMsg = new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('메뉴'), channel);
    const recruit = mkChannel(config.RECRUIT_CHANNEL_ID);
    let cleanedRecruit = false;
    recruit.bulkDelete = async () => { cleanedRecruit = true; return new Map(); };
    recruit.messages.fetch = async () => new Map();
    // 누른 곳은 놀이터 — 절대 청소되면 안 된다
    channel.id = 'c-playground';
    let cleanedHere = false;
    channel.bulkDelete = async () => { cleanedHere = true; return new Map(); };
    channel.messages.fetch = async () => new Map();
    const origFetch = client.channels.fetch;
    let fetchedId = null;
    client.channels.fetch = async id => { fetchedId = id; return recruit; };
    const ok = mkInteraction({ user: ADMIN, customId: 'panel:purge:admin', message: menuMsg });
    ok.channelId = channel.id;
    await panel.handlePanelButton(ok);
    client.channels.fetch = origFetch;
    assert(fetchedId === config.RECRUIT_CHANNEL_ID, '게임모집 채널을 대상으로 잡지 않음');
    assert(!cleanedHere, '누른 채널(놀이터)이 청소됨');
    assert(JSON.stringify(menuMsg.components).includes('삭제하였습니다'), '청소 완료 안내가 안 보임');
    channel.id = 'c1';
  });

  await flow('안내 패널·명령어 목록·알림 DM 카드', async () => {
    lint('안내 패널', panel.buildSetupPanelPayload({ client, guild: { id: 'g1' } }));
    lint('명령어 목록', panel.buildCommandListPayload());
    const match = { data: { gameInfo: { name: '롤', emoji: '<:Lol:1510933684750913626>', color: 1 }, title: 't' }, message: { url: 'https://discord.com/channels/1/2/3' } };
    lint('시작 DM', common.buildMatchDmPayload({ kind: 'start', match, label: '내전' }));
    lint('마감 DM', common.buildMatchDmPayload({ kind: 'close', match, label: '내전' }));
  });

  console.log(`\n응답 ${checks}개 검사 · 문제 ${problems.length}개`);
  for (const p of problems) console.log('❌', p);
  process.exit(problems.length ? 1 : 0);
})().catch(err => { console.error('테스트 실행 오류:', err); process.exit(2); });
