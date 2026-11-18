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
    this.channel = channel; this.channelId = channel?.id ?? 'c1'; this.guildId = 'g1'; this.client = channel?.client;
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
  users: { fetch: async (id) => ({ id, username: id, displayAvatarURL: () => 'https://x/u.png', send: async (p) => new FakeMsg(p, mkChannel('dm')) }) },
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
    async followUp(p) { lint('followUp', p); this.followedUp = true; return new FakeMsg(p, channel); },
    async deleteReply() { this.replyDeleted = true; },
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
    assert(pub.replyDeleted, '게시했는데 미리보기가 안 지워짐');
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
    for (const cid of [`naejeon:match_reopen:${id}`, `naejeon:match_close:${id}`, `naejeon:manage_back:${id}`, `naejeon:match_mention:${id}`, `naejeon:match_cancel:${id}`, `naejeon:manage_back:${id}`]) {
      await naejeon.handleNaejeonButton(mkInteraction({ user: ADMIN, customId: cid, message: menuMsg }));
    }
    await team.handleTeamButton(mkInteraction({ user: ADMIN, customId: `team:open:${id}`, message: menuMsg }));
    await naejeon.handleNaejeonButton(mkInteraction({ user: ADMIN, customId: `naejeon:match_cancel_confirm:${id}`, message: menuMsg }));
    assert(!client.naejeonMatches.has(id), '취소했는데 매치가 남아 있음');
    assert(match.message.isV2, '게시글이 v2가 아님');
  });

  await flow('내전: 마감되면 팀 짜기 카드 → 팀 입력(티어 저장) → 밸런스 → 랜덤 → 내 티어', async () => {
    await naejeon.handleNaejeonModal(mkInteraction({ user: ADMIN, customId: 'naejeon:modal:lol', fields: { title: '팀 내전', datetime: '내일 8시', players: '4', description: '' } }));
    await naejeon.handleNaejeonButton(mkInteraction({ user: ADMIN, customId: 'naejeon:publish', message: new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('p'), channel) }));
    const match = [...client.naejeonMatches.values()].at(-1);
    const id = match.message.id;
    for (const u of ['u1', 'u2', 'u3', 'u4']) await naejeon.handleNaejeonButton(mkInteraction({ user: u, customId: 'naejeon:join', message: match.message }));
    await new Promise(r => setTimeout(r, 20)); // 마감 훅은 비동기로 돈다
    assert(match.board?.messageId, '마감했는데 팀 짜기 카드가 안 올라감');
    const boardMsg = () => channel.sent.find(m => m.id === match.board.messageId);
    assert(boardMsg() && !boardMsg().deleted, '카드 메시지를 못 찾음');
    assert(match.board.current?.draft && match.board.current.how === 'random', '티어가 없으면 초안이 랜덤이어야 함');
    const panelTier = mkInteraction({ user: 'u7', customId: 'team:tier:lol:panel', message: new FakeMsg(team.buildTierGamePayload(), channel) });
    await team.handleTeamButton(panelTier);
    await team.handleTeamSelect(mkInteraction({ user: 'u7', customId: 'team:tier_pick:lol:panel', values: ['challenger'], message: panelTier.message }));
    await team.handleTeamButton(mkInteraction({ user: 'u7', customId: 'team:tier_save:lol:challenger:panel', message: panelTier.message }));
    assert(require(path.join(root, 'handlers/매치/티어.js')).getTier('u7', 'lol')?.tier === 'challenger', '패널에서 고른 티어가 저장되지 않음');
    // 뒤로 가기: 저장 완료 → 🔁 다시 설정(티어 고르기) → ↩️ 게임 다시 고르기(내 티어 목록이 보임) → 단계 고르기에서 ↩️ 뒤로
    await team.handleTeamButton(mkInteraction({ user: 'u7', customId: 'team:tier_back:lol:panel', message: panelTier.message }));
    await team.handleTeamButton(mkInteraction({ user: 'u7', customId: 'team:tier_games:panel', message: panelTier.message }));
    assert(JSON.stringify(panelTier.message.components).includes('내 티어'), '게임 고르기 화면에 저장된 내 티어가 안 보임');
    assert(JSON.stringify(panelTier.message.components).includes('team:tier_resetall:panel'), '내 티어 정보 옆에 전체 초기화 버튼이 없음');
    await team.handleTeamButton(mkInteraction({ user: 'u7', customId: 'team:tier:pubg:panel', message: panelTier.message }));
    await team.handleTeamSelect(mkInteraction({ user: 'u7', customId: 'team:tier_pick:pubg:panel', values: ['crystal'], message: panelTier.message }));
    await team.handleTeamButton(mkInteraction({ user: 'u7', customId: 'team:tier_back:pubg:panel', message: panelTier.message }));
    await team.handleTeamSelect(mkInteraction({ user: 'u7', customId: 'team:tier_pick:pubg:panel', values: ['master'], message: panelTier.message }));
    await team.handleTeamButton(mkInteraction({ user: 'u7', customId: 'team:tier_back:pubg:panel', message: panelTier.message }));

    const input = mkInteraction({ user: ADMIN, customId: `team:input:${id}` });
    await team.handleTeamButton(input);
    assert(input.modalShown, '팀 입력 창이 안 뜸');
    const outsider = mkInteraction({ user: 'u2', customId: `team:input:${id}` });
    await team.handleTeamButton(outsider);
    assert(!outsider.modalShown, '주최자·관리자가 아닌 참가자인데 입력 창이 뜸');

    const first = boardMsg();
    // 이름u1 = 참가자 u1 의 표시 이름. 티어를 같이 적으면 저장된다.
    await team.handleTeamModal(mkInteraction({ user: ADMIN, customId: `team:modal:${id}`, fields: { teams: ['이름u1 다2-이름u2 골1', '이름u3-이름u4 마스터'].join(String.fromCharCode(10)) } }));
    assert(match.board.current?.teams?.length === 2, '입력한 팀이 저장되지 않음');
    assert(first.deleted && boardMsg() !== first, '카드가 맨 아래로 다시 올라오지 않음');
    assert(JSON.stringify(boardMsg().components).includes('#2') && JSON.stringify(boardMsg().components).includes('team:hist:'), '카드 부제에 지금 순번(#2)과 📜 내전 내역 버튼이 없음(자동 초안 #1 은 내역으로 넘어감)');
    const tierMod = require(path.join(root, 'handlers/매치/티어.js'));
    assert(tierMod.getTier('u1', 'lol')?.tier === 'diamond' && tierMod.getTier('u1', 'lol')?.div === 2, '팀 입력의 티어(다2)가 저장되지 않음');
    assert(tierMod.getTier('u4', 'lol')?.tier === 'master', '팀 입력의 티어(마스터)가 저장되지 않음');
    assert(match.board.current.teams[0].members.join() === '이름u1,이름u2', `티어 글자가 이름에 섞임(${match.board.current.teams[0].members})`);

    // ✏️ 직접 입력(팀별 칸): 맨 앞 역할은 고정, 이름 뒤 티어는 저장, 첫 줄 [이름]은 팀 이름
    const NL = String.fromCharCode(10);
    const boxModal = team.buildInputModal(match, id).toJSON();
    assert(boxModal.components.length === 2 && boxModal.components[0].components[0].custom_id === 'team0', '직접 입력 창이 팀별 칸으로 안 나옴');
    await team.handleTeamModal(mkInteraction({ user: ADMIN, customId: `team:modal:${id}`, fields: { team0: ['[공격]', '미드 이름u1', '정글 이름u3 골2'].join(NL), team1: ['이름u2', '서포터 이름u4'].join(NL) } }));
    const cur = match.board.current;
    assert(cur.teams[0].name === '공격' && cur.teams[0].members.join() === '이름u1,이름u3', `팀별 칸이 잘못 읽힘(${JSON.stringify(cur.teams)})`);
    assert(cur.teams[0].pos?.join() === 'mid,jungle' && cur.teams[1].pos?.join() === ',support', `고정 역할이 저장되지 않음(${JSON.stringify(cur.teams.map(t => t.pos))})`);
    assert(tierMod.getTier('u3', 'lol')?.tier === 'gold', '직접 입력의 티어(골2)가 저장되지 않음');
    assert(team.buildInputModal(match, id).toJSON().components[0].components[0].value.includes('미드 이름u1'), '다시 열면 고정 역할이 채워져 있어야 함');
    assert(team.parseTeamBoxes(['윤진-승훈' + NL + '시형-연우', ''], { game: 'lol' }).teams.length === 2, '한 칸에 예전 방식으로 붙여넣으면 예전처럼 읽어야 함');
    assert(team.parseTeamBoxes(['돌격 가' + NL + '힐 나', '딜 다' + NL + '라'], { game: 'overwatch' }).teams[0].pos.join() === 'tank,support', '오버워치 줄임말(돌격·힐)을 못 읽음');
    // 구분 글자 아무거나·붙여 쓰기·역할을 뒤에, 참가자 이름과 같으면 쪼개지 않음
    const P = ['민호', '미드라', '승훈', '지수'].map((n, i) => ({ id: 'x' + i, displayName: n }));
    const flex = team.parseTeamBoxes(['탑민호' + NL + '미드라' + NL + '정글-승훈-다2', '서포터,지수' + NL + '가 바텀'], { game: 'lol', participants: P });
    assert(flex.teams[0].members.join() === '민호,미드라,승훈' && flex.teams[0].pos.join() === 'top,,jungle', `붙여 쓴 역할·구분 글자를 못 읽음(${JSON.stringify(flex.teams)})`);
    assert(flex.teams[1].pos.join() === 'support,adc' && flex.hints.some(h => h.name === '승훈' && h.tier.div === 2), `쉼표·역할 뒤에 쓰기·티어를 못 읽음(${JSON.stringify(flex)})`);
    const glued = team.parseTeamBoxes(['민호다이아2' + NL + '승훈(골1)', '지수/미드' + NL + '나'], { game: 'lol', participants: P });
    assert(glued.teams[0].members.join() === '민호,승훈' && glued.hints.length === 2 && glued.teams[1].pos[0] === 'mid', `이름에 붙인 티어·괄호·/ 를 못 읽음(${JSON.stringify(glued)})`);

    await team.handleTeamButton(mkInteraction({ user: ADMIN, customId: `team:balance:${id}` }));
    assert(match.board.current.how === 'balance' && match.board.history.length === 3, '밸런스 후 이전 팀표로 안 밀림');
    await team.handleTeamButton(mkInteraction({ user: ADMIN, customId: `team:random:${id}` }));
    assert(match.board.history.length === 4, '랜덤 후 이전 팀표가 안 쌓임');

    const bad = mkInteraction({ user: ADMIN, customId: `team:modal:${id}`, fields: { teams: '혼자' } });
    await team.handleTeamModal(bad);
    assert(match.board.history.length === 4, '잘못된 입력인데 팀이 바뀜');

    // 🏅 내 티어: 티어 고르기 → 단계 고르기 → 저장 / 단계 없는 티어 / 지우기
    const tierBtn = mkInteraction({ user: 'u3', customId: `team:tier:lol:${id}` });
    await team.handleTeamButton(tierBtn);
    assert(tierBtn._reply, '내 티어 메뉴가 안 뜸');
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_pick:lol:${id}`, values: ['emerald'], message: tierBtn._reply }));
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_div:lol:emerald:${id}`, values: ['3'], message: tierBtn._reply }));
    assert(tierMod.getTier('u3', 'lol')?.tier === 'emerald' && tierMod.getTier('u3', 'lol')?.div === 3, '내 티어(에메랄드3)가 저장되지 않음');
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_pick:valorant:${id}`, values: ['radiant'], message: tierBtn._reply }));
    await team.handleTeamButton(mkInteraction({ user: 'u3', customId: `team:tier_save:valorant:radiant:${id}`, message: tierBtn._reply }));
    assert(tierMod.getTier('u3', 'valorant')?.tier === 'radiant', '단계 없는 티어(레디언트)가 저장되지 않음');
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_pick:valorant:${id}`, values: ['none'], message: tierBtn._reply }));
    assert(!tierMod.getTier('u3', 'valorant'), '티어 지우기가 안 됨');
    // 점수제 티어: 마스터 → ✏️ LP 적기 → 입력창 → 저장 / 점수 없이 저장
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_pick:lol:${id}`, values: ['master'], message: tierBtn._reply }));
    const scoreBtn = mkInteraction({ user: 'u3', customId: `team:tier_score:lol:master:${id}`, message: tierBtn._reply });
    await team.handleTeamButton(scoreBtn);
    assert(scoreBtn.modalShown, '점수 입력창이 안 뜸');
    await team.handleTeamModal(mkInteraction({ user: 'u3', customId: `team:tier_modal:lol:master:${id}`, fields: { score: '350LP' }, message: tierBtn._reply }));
    assert(tierMod.getTier('u3', 'lol')?.score === 350, '마스터 LP가 저장되지 않음');
    await team.handleTeamButton(mkInteraction({ user: 'u3', customId: `team:tier_save:pubg:survivor:${id}`, message: tierBtn._reply }));
    assert(tierMod.getTier('u3', 'pubg')?.tier === 'survivor', '배그 서바이버(점수 없이)가 저장되지 않음');
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_pick:overwatch:${id}`, values: ['champion'], message: tierBtn._reply }));
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_div:overwatch:champion:${id}`, values: ['5'], message: tierBtn._reply }));
    assert(tierMod.getTier('u3', 'overwatch')?.div === 5, '오버워치 챔피언5가 저장되지 않음');

    // 오버워치 롤별 티어: 🏅(오버워치) → 롤 고르기 → 🛡️ 탱커 → 티어 → 단계 → 저장 → ↩️ 롤 고르기
    const owBtn = mkInteraction({ user: 'u2', customId: `team:tier:overwatch:${id}` });
    await team.handleTeamButton(owBtn);
    assert(JSON.stringify(owBtn._reply.components).includes('team:tier:overwatch.tank'), '오버워치 롤 고르기 화면이 안 뜸');
    await team.handleTeamButton(mkInteraction({ user: 'u2', customId: `team:tier:overwatch.tank:${id}`, message: owBtn._reply }));
    await team.handleTeamSelect(mkInteraction({ user: 'u2', customId: `team:tier_pick:overwatch.tank:${id}`, values: ['diamond'], message: owBtn._reply }));
    await team.handleTeamSelect(mkInteraction({ user: 'u2', customId: `team:tier_div:overwatch.tank:diamond:${id}`, values: ['2'], message: owBtn._reply }));
    assert(tierMod.getTier('u2', 'overwatch.tank')?.tier === 'diamond', '오버워치 탱커 티어가 저장되지 않음');
    assert(!tierMod.getTier('u2', 'overwatch.support'), '저장 안 한 롤(힐러)에 티어가 생김');
    assert(tierMod.getTier('u2', 'overwatch')?.tier === 'diamond', '오버워치 대표 티어(가장 높은 롤)가 안 나옴');
    await team.handleTeamButton(mkInteraction({ user: 'u2', customId: `team:tier_roles:${id}`, message: owBtn._reply }));
    assert(JSON.stringify(owBtn._reply.components).includes('돌격'), '↩️ 뒤로가 롤 고르기로 안 돌아감');

    // 롤 포지션: 🧭 포지션 설정 → 주(미드) → 부(정글) → 주를 지우면 부도 지워짐
    await team.handleTeamButton(mkInteraction({ user: 'u3', customId: `team:tier_posset:lol:${id}`, message: tierBtn._reply }));
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_pos:main:lol:${id}`, values: ['mid'], message: tierBtn._reply }));
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_pos:sub:lol:${id}`, values: ['jungle'], message: tierBtn._reply }));
    assert(tierMod.getPositions('u3', 'lol').join() === 'mid,jungle', `포지션 저장이 안 됨(${tierMod.getPositions('u3', 'lol')})`);
    assert(tierMod.getTier('u3', 'lol')?.tier === 'master', '포지션을 저장했더니 티어가 사라짐');
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_pos:main:lol:${id}`, values: ['jungle'], message: tierBtn._reply }));
    assert(tierMod.getPositions('u3', 'lol').join() === 'jungle', '주를 부와 같게 바꾸면 하나만 남아야 함');
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_pos:main:lol:${id}`, values: ['none'], message: tierBtn._reply }));
    assert(tierMod.getPositions('u3', 'lol').length === 0, '포지션 지우기가 안 됨');

    // 🔄 초기화: 티어와 포지션을 한 번에 지운다(오버워치는 그 롤만)
    await team.handleTeamSelect(mkInteraction({ user: 'u3', customId: `team:tier_pos:main:lol:${id}`, values: ['mid'], message: tierBtn._reply }));
    await team.handleTeamButton(mkInteraction({ user: 'u3', customId: `team:tier_back:lol:${id}`, message: tierBtn._reply }));
    assert(JSON.stringify(tierBtn._reply.components).includes('team:tier_reset:lol'), '저장된 티어가 있는데 초기화 버튼이 없음');
    await team.handleTeamButton(mkInteraction({ user: 'u3', customId: `team:tier_reset:lol:${id}`, message: tierBtn._reply }));
    assert(!tierMod.getTier('u3', 'lol') && tierMod.getPositions('u3', 'lol').length === 0, '초기화했는데 티어·포지션이 남음');
    assert(!JSON.stringify(tierBtn._reply.components).includes('team:tier_reset:lol'), '초기화 후에도 초기화 버튼이 보임');
    tierMod.setTier('u2', 'overwatch.support', { tier: 'gold', div: 1 });
    await team.handleTeamButton(mkInteraction({ user: 'u2', customId: `team:tier_reset:overwatch.tank:${id}`, message: owBtn._reply }));
    assert(!tierMod.getTier('u2', 'overwatch.tank') && tierMod.getTier('u2', 'overwatch.support'), '오버워치 초기화가 그 롤만 지우지 않음');

    // 🗑️ 전체 초기화: 확인 화면 → 모두 지우기 → 모든 게임 티어·포지션이 사라짐
    tierMod.setPositions('u2', 'lol', ['mid']);
    const allMsg = new FakeMsg(team.buildTierGamePayload('u2'), channel);
    await team.handleTeamButton(mkInteraction({ user: 'u2', customId: 'team:tier_resetall:panel', message: allMsg }));
    assert(JSON.stringify(allMsg.components).includes('team:tier_resetall_ok:panel'), '전체 초기화 확인 화면이 안 뜸');
    await team.handleTeamButton(mkInteraction({ user: 'u2', customId: 'team:tier_resetall_ok:panel', message: allMsg }));
    assert(!tierMod.getTier('u2', 'overwatch') && !tierMod.getTier('u2', 'lol') && tierMod.getPositions('u2', 'lol').length === 0, '전체 초기화했는데 티어·포지션이 남음');

    // 포지션을 안 정한 사람은 자동으로(롤): 안 맡은 자리부터 채워 같은 자리가 몰리지 않게
    {
      const f4 = team.autoFillSlots(['top', 'jungle', null, null], 'lol');
      assert(f4.slice(2).join() === 'mid,adc', `롤 자동 배정(${f4})`);
      const f5 = team.autoFillSlots([null, null, null], 'lol');
      assert(f5.join() === 'top,jungle,mid', `롤: 아무도 안 정했어도 겹치지 않게 전부 정해 줌(${f5})`);
      const f6 = team.autoFillSlots([null, 'duelist'], 'valorant');
      assert(f6[0] === null, '발로란트는 자동 배정하지 않음(역할 고정이 아님)');
    }

    match.closed = false; // 마감 해제 후 다시 마감돼도 카드를 또 올리지 않는다
    const before = channel.sent.length;
    common.markClosed(client.naejeonMatches, id, match, '내전', false);
    await new Promise(r => setTimeout(r, 20));
    assert(channel.sent.length === before, '다시 마감됐는데 카드를 또 올림');

    const sel = mkInteraction({ user: ADMIN, customId: `team:open:${id}` });
    await team.handleTeamButton(sel);
    assert(boardMsg() && !boardMsg().deleted, '📌 팀 불러오기로 카드를 다시 못 올림');
    common.clearNotifyTimer?.(match);
    client.naejeonMatches.delete(id);
  });

  await flow('내전(테스트 서버): 🧪 가짜 인원 채우기 → 마감 → 팀 짜기 카드', async () => {
    const G = '1282694117255548960';
    await naejeon.handleNaejeonModal(mkInteraction({ user: ADMIN, guildId: G, customId: 'naejeon:modal:valorant', fields: { title: '발로 테스트', datetime: '내일 8시', players: '10', description: '' } }));
    await naejeon.handleNaejeonButton(mkInteraction({ user: ADMIN, guildId: G, customId: 'naejeon:publish', message: new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('p'), channel) }));
    const match = [...client.naejeonMatches.values()].at(-1);
    const id = match.message.id;
    await naejeon.handleNaejeonButton(mkInteraction({ user: ADMIN, guildId: G, customId: 'naejeon:join', message: match.message }));
    const manage = mkInteraction({ user: ADMIN, guildId: G, customId: 'naejeon:manage', message: match.message });
    await naejeon.handleNaejeonButton(manage);
    assert(JSON.stringify(manage._reply.components).includes('naejeon:test_fill:'), '테스트 서버 관리 메뉴에 가짜 인원 버튼이 없음');
    await naejeon.handleNaejeonButton(mkInteraction({ user: ADMIN, guildId: G, customId: `naejeon:test_fill:${id}`, message: manage._reply }));
    assert(match.participants.length === 10 && match.closed, `가짜 인원으로 정원이 안 참(${match.participants.length})`);
    await new Promise(r => setTimeout(r, 20));
    assert(match.board?.messageId, '가짜 인원으로 마감됐는데 팀 짜기 카드가 안 올라감');
    assert(match.board.current?.draft && match.board.current.how === 'balance', `티어 8/10명이면 초안이 밸런스여야 함(${match.board.current?.how})`);
    await team.handleTeamButton(mkInteraction({ user: ADMIN, guildId: G, customId: `team:balance:${id}` }));
    assert(match.board.current?.how === 'balance', '밸런스가 안 됨');
    assert(match.board.history.length === 1 && match.board.history[0].no === 1 && match.board.current.no === 2, `자동으로 나눈 #1 이 내역에 남고 다음은 #2 여야 함(내역 ${match.board.history.length}, 지금 #${match.board.current.no})`);
    // 📜 내전 내역: 누구나 나만 보이는 창으로 열고(삭제 버튼은 없음), 쌓인 #1 내역이 보인다
    {
      const view = mkInteraction({ user: 'u2', guildId: G, customId: `team:hist:${id}` });
      await team.handleTeamButton(view);
      const vj = view._reply ? JSON.stringify(view._reply.components) : '';
      assert(vj.includes('#1') && !vj.includes('hist_clear'), '내전 내역 창이 안 뜸(#1 내역이 있어야 하고 삭제 버튼은 없어야 함)');
    }
    const normal = mkInteraction({ user: ADMIN, customId: 'naejeon:manage', message: match.message });
    common.clearNotifyTimer?.(match);
    client.naejeonMatches.delete(id);
  });

  await flow('팀 짜기: 예외 상황(같은 이름·마크다운 이름·빈 팀·동시 클릭·끝난 내전·팀 6개·많은 인원)', async () => {
    const card = require(path.join(root, 'handlers/공통/카드.js'));
    const tierMod = require(path.join(root, 'handlers/매치/티어.js'));
    const mkMatch = async (players, title) => {
      await naejeon.handleNaejeonModal(mkInteraction({ user: ADMIN, customId: 'naejeon:modal:lol', fields: { title, datetime: '내일 8시', players: String(players), description: '' } }));
      await naejeon.handleNaejeonButton(mkInteraction({ user: ADMIN, customId: 'naejeon:publish', message: new FakeMsg(card.notice('p'), channel) }));
      return [...client.naejeonMatches.values()].at(-1);
    };
    const liveBoards = (m) => channel.sent.filter(x => !x.deleted && x.id === m.board?.messageId);

    // 같은 표시 이름 두 명 + 마크다운 글자가 든 이름
    const m1 = await mkMatch(4, '예외1');
    const id1 = m1.message.id;
    m1.participants.push({ id: 'd1', displayName: '윤진' }, { id: 'd2', displayName: '윤진' }, { id: 'd3', displayName: '**굵게**_밑줄_' }, { id: 'd4', displayName: '`코드`~~취소~~' });
    common.markClosed(client.naejeonMatches, id1, m1, '내전', false);
    await new Promise(r => setTimeout(r, 20));
    assert(m1.board?.messageId, '같은 이름이 있어도 카드가 올라가야 함');
    const allNames = m1.board.current.teams.flatMap(t => t.members);
    assert(new Set(allNames).size === 4, `같은 이름을 구분 못 함(${allNames})`);
    const prefilled = require(path.join(root, 'handlers/매치/팀.js')).teamsToText(m1.board.current.teams);
    assert(!team.parseTeamsText(prefilled, { game: 'lol' }).error, '자동으로 채운 팀을 그대로 제출하면 오류가 나면 안 됨');
    const json1 = JSON.stringify(liveBoards(m1)[0]?.components ?? []);
    assert(!json1.includes('**굵게**_밑줄_') && json1.includes('\\\\*\\\\*굵게'), '이름 속 마크다운 글자를 그대로 넣음(굵게·밑줄로 깨짐)');

    // 두 사람이 동시에 ⚖️ 밸런스 / 🎲 랜덤 → 카드는 한 장만 남아야 함
    await Promise.all([
      team.handleTeamButton(mkInteraction({ user: ADMIN, customId: `team:balance:${id1}` })),
      team.handleTeamButton(mkInteraction({ user: ADMIN, customId: `team:random:${id1}` })),
      team.handleTeamButton(mkInteraction({ user: ADMIN, customId: `team:balance:${id1}` })),
    ]);
    const boardsLeft = channel.sent.filter(x => !x.deleted && JSON.stringify(x.components).includes(`team:input:${id1}`));
    assert(boardsLeft.length === 1, `동시에 눌렀더니 카드가 ${boardsLeft.length}장 남음`);
    assert(m1.board.history.length === 3, `동시 클릭 3번이면 내역 3개여야 함(${m1.board.history.length})`);

    // 팀 6개(짧게 보기)와 빈 줄·이상한 입력
    await team.handleTeamModal(mkInteraction({ user: ADMIN, customId: `team:modal:${id1}`, fields: { teams: ['a b', 'c d', 'e f', 'g h', 'i j', 'k l'].join(String.fromCharCode(10)) } }));
    assert(m1.board.current.teams.length === 6, '팀 6개 입력이 안 됨');
    for (const bad of ['', '   ', '혼자', ['a-b', 'a-c'].join(String.fromCharCode(10)), Array.from({ length: 11 }, (_, i) => `x${i} y${i}`).join(String.fromCharCode(10))]) {
      const before = m1.board.history.length;
      await team.handleTeamModal(mkInteraction({ user: ADMIN, customId: `team:modal:${id1}`, fields: { teams: bad } }));
      assert(m1.board.history.length === before, `잘못된 입력("${bad.slice(0, 10)}")인데 팀이 바뀜`);
    }

    // 끝난(삭제된) 내전의 카드 버튼
    client.naejeonMatches.delete(id1);
    for (const cid of [`team:input:${id1}`, `team:balance:${id1}`, `team:random:${id1}`, `team:open:${id1}`]) {
      const it = mkInteraction({ user: ADMIN, customId: cid });
      await team.handleTeamButton(it);
      assert(it.replied && !it.modalShown, `끝난 내전에서 ${cid} 가 안내 없이 넘어감`);
    }
    const tierAfter = mkInteraction({ user: 'u5', customId: `team:tier:lol:${id1}` });
    await team.handleTeamButton(tierAfter);
    assert(tierAfter._reply, '끝난 내전 카드에서도 🏅 내 티어 설정은 열려야 함');

    // 혼자 마감 → 카드 자동으로 안 올림, 📌 팀 불러오기로는 올라가고 빈 팀은 "없음"
    const m2 = await mkMatch(1, '예외2');
    const id2 = m2.message.id;
    await naejeon.handleNaejeonButton(mkInteraction({ user: 'u1', customId: 'naejeon:join', message: m2.message }));
    await new Promise(r => setTimeout(r, 20));
    assert(m2.closed && !m2.board?.messageId, '혼자인 내전은 카드를 자동으로 올리지 않아야 함');
    await team.handleTeamButton(mkInteraction({ user: ADMIN, customId: `team:open:${id2}` }));
    assert(m2.board?.messageId, '📌 팀 불러오기로는 혼자여도 올라가야 함');
    client.naejeonMatches.delete(id2);

    // 저장된 티어 값이 지금 목록에 없으면 없는 것으로
    tierMod.setTier('weird', 'lol', { tier: 'mythic', div: 1 });
    assert(tierMod.getTier('weird', 'lol') === null, '목록에 없는 티어 값을 그대로 씀');

    // 많은 인원: 20명(전부 비교)·24명(빠른 방식) 밸런스가 빨리 끝나고 인원이 맞아야 함
    for (const n of [20, 24]) {
      const ps = Array.from({ length: n }, (_, i) => ({ id: `b${n}_${i}`, displayName: `사람${i}` }));
      ps.forEach((u, i) => tierMod.setTier(u.id, 'lol', i % 3 ? { tier: ['iron', 'gold', 'diamond', 'master'][i % 4], div: (i % 4) + 1 } : null));
      const t0 = Date.now();
      const teams = team.balanceTeams(ps, 'lol');
      const ms = Date.now() - t0;
      const total = teams[0].members.length + teams[1].members.length;
      assert(total === n && new Set([...teams[0].members, ...teams[1].members]).size === n, `${n}명 밸런스 인원이 안 맞음`);
      assert(ms < 1500, `${n}명 밸런스가 너무 느림(${ms}ms)`);
    }
  });

  // 카드(컴포넌트 JSON)에서 🗺️ 맵 뽑기 버튼 하나를 찾는다
  const findMapBtn = (comps) => {
    const all = JSON.parse(JSON.stringify(comps));
    let found = null;
    const walk = (n) => { if (!n || typeof n !== 'object' || found) return; if (typeof n.custom_id === 'string' && n.custom_id.startsWith('team:map:')) { found = n; return; } Object.values(n).forEach(walk); };
    walk(all);
    return found;
  };
  await flow('맵 뽑기: 발로란트·오버워치 카드에만 🗺️ 버튼 · 결과가 있으면 이미지와 이름이 보인다', async () => {
    const mapMod = require(path.join(root, 'handlers/매치/맵.js'));
    const made = {};
    for (const game of ['valorant', 'overwatch', 'lol']) {
      await naejeon.handleNaejeonModal(mkInteraction({ user: ADMIN, customId: `naejeon:modal:${game}`, fields: { title: `${game} 내전`, datetime: '내일 8시', players: '4', description: '' } }));
      await naejeon.handleNaejeonButton(mkInteraction({ user: ADMIN, customId: 'naejeon:publish', message: new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('p'), channel) }));
      const m = [...client.naejeonMatches.values()].at(-1);
      for (const u of ['u1', 'u2', 'u3', 'u4']) await naejeon.handleNaejeonButton(mkInteraction({ user: u, customId: 'naejeon:join', message: m.message }));
      await new Promise(r => setTimeout(r, 20));
      made[game] = m;
    }
    const boardJson = (m) => JSON.stringify(channel.sent.find(x => x.id === m.board.messageId).components);
    assert(boardJson(made.valorant).includes('team:map:') && boardJson(made.overwatch).includes('team:map:'), '발로란트·오버워치 카드에 🗺️ 맵 뽑기 버튼이 있어야 함');
    assert(!boardJson(made.lol).includes('team:map:'), '롤 카드에는 맵 뽑기 버튼이 없어야 함');
    const v = made.valorant;
    const vid = v.message.id;
    assert(!JSON.stringify(team.buildBoardPayload(v, vid).components).includes('attachment://map-'), '맵을 안 뽑았으면 맵 구역이 없어야 함');
    v.board.map = { game: 'valorant', key: 'ascent', at: Date.now() };
    const withMap = team.buildBoardPayload(v, vid);
    const wj = JSON.stringify(withMap.components);
    assert(wj.includes('어센트') && wj.includes('attachment://map-final.jpg') && withMap.files?.length === 1, '뽑은 맵의 이름과 결과 이미지가 카드에 있어야 함');
    assert(wj.includes('## 맵 뽑기 완료') && !wj.includes('맵 뽑는 중'), '확정되면 헤더가 맵 뽑기 완료여야 함');
    const lockedBtn = findMapBtn(withMap.components);
    assert(lockedBtn.disabled === true && lockedBtn.label.includes('5분'), '뽑은 직후 5분간은 버튼이 잠겨야 함');
    v.board.map = { game: 'valorant', key: 'ascent', at: Date.now() - team.MAP_LOCK_MS - 1000 };
    const openBtn = findMapBtn(team.buildBoardPayload(v, vid).components);
    assert(!openBtn.disabled && openBtn.label.includes('다시 뽑기'), '5분이 지나면 다시 뽑기가 눌려야 함');
    v.board.map = { game: 'valorant', key: 'nope', at: Date.now() - team.MAP_LOCK_MS - 1000 };
    const broken = team.buildBoardPayload(v, vid);
    assert(!(broken.files?.length), '이미지 파일이 없으면 첨부 없이 카드가 만들어져야 함');
    v.board.map = undefined;
  });

  await flow('맵 뽑기: 버튼 → 5프레임+확정 연출 · 권한 · 동시 클릭 · 연출 중 갱신 · 수정 실패 · 팀을 다시 나눠도 유지', async () => {
    const mapMod = require(path.join(root, 'handlers/매치/맵.js'));
    await naejeon.handleNaejeonModal(mkInteraction({ user: ADMIN, customId: 'naejeon:modal:valorant', fields: { title: '맵 내전', datetime: '내일 8시', players: '4', description: '' } }));
    await naejeon.handleNaejeonButton(mkInteraction({ user: ADMIN, customId: 'naejeon:publish', message: new FakeMsg(require(path.join(root, 'handlers/공통/카드.js')).notice('p'), channel) }));
    const m = [...client.naejeonMatches.values()].at(-1);
    for (const u of ['u1', 'u2', 'u3', 'u4']) await naejeon.handleNaejeonButton(mkInteraction({ user: u, customId: 'naejeon:join', message: m.message }));
    await new Promise(r => setTimeout(r, 20));
    const id = m.message.id;
    const boardMsg = () => channel.sent.find(x => x.id === m.board.messageId);
    const press = (user, extra = {}) => mkInteraction({ user, customId: `team:map:${id}`, message: boardMsg(), ...extra });
    team.__setMapSleep(() => Promise.resolve());
    let clock = 1_700_000_000_000;
    team.__setMapClock(() => clock);
    const unlock = () => { clock += team.MAP_LOCK_MS + 1000; };

    // 주최자(관리자)가 누르면: 결과 저장 + 첫 수정은 뽑는 중, 마지막은 확정 이미지와 이름
    const calls = [];
    const it = press(ADMIN);
    const origEdit = it.editReply.bind(it);
    it.editReply = async (p) => { calls.push(JSON.stringify(p.components) + '|' + (p.files || []).map(x => x.name).join()); return origEdit(p); };
    await team.handleTeamButton(it);
    const picked = m.board.map;
    assert(picked && mapMod.MAP_POOLS.valorant.some(x => x.key === picked.key) && picked.game === 'valorant', '뽑은 결과가 board.map 에 저장돼야 함');
    assert(calls.length === mapMod.SPIN_DELAYS_MS.length + 1, `카드는 ${mapMod.SPIN_DELAYS_MS.length + 1}번 고쳐져야 함(${calls.length})`);
    assert(calls[0].includes('## 맵 뽑는 중...') && calls[0].includes('map-1.jpg') && calls[4].includes('map-5.jpg'), '돌아가는 프레임은 map-1..5.jpg 이고 헤더가 맵 뽑는 중이어야 함');
    assert(calls.at(-1).includes('map-final.jpg') && calls.at(-1).includes('## 맵 뽑기 완료') && calls.at(-1).includes(mapMod.mapName('valorant', picked.key)), '마지막은 확정 이미지·이름·헤더(맵 뽑기 완료)');
    const lockedNow = findMapBtn(boardMsg().components);
    assert(lockedNow.disabled === true && lockedNow.label.includes('5분'), '뽑은 직후 버튼은 5분간 잠겨야 함');
    assert(!team.__mapSpin.has(id), '연출이 끝나면 프레임 상태가 비워져야 함');

    // 일반 참가자는 못 뽑는다(결과가 그대로)
    const before = { ...m.board.map };
    const stranger = press('u2');
    await team.handleTeamButton(stranger);
    assert(stranger.replied && m.board.map.at === before.at && m.board.map.key === before.key, '주최자·관리자가 아니면 뽑히지 않아야 함');

    // 잠금 중(5분 안)에 누르면 안내만, 결과 그대로
    const lockedPress = press(ADMIN);
    await team.handleTeamButton(lockedPress);
    assert(lockedPress._reply && JSON.stringify(lockedPress._reply.components).includes('다시 할 수 있어요') && m.board.map.at === before.at, '5분 안에 누르면 잠금 안내만 받고 결과는 그대로여야 함');
    unlock();

    // 연출 중에 또 누르면 안내만(두 번째 클릭은 결과를 바꾸지 않음) + 연출 도중 카드가 다시 그려져도 현재 프레임 이미지가 유지됨
    let hold = true; const waiters = [];
    team.__setMapSleep(() => (hold ? new Promise(r => waiters.push(r)) : Promise.resolve()));
    const first = team.handleTeamButton(press(ADMIN));
    await new Promise(r => setTimeout(r, 20));
    const at1 = m.board.map.at;
    const second = press(ADMIN);
    await team.handleTeamButton(second);
    assert(second._reply && JSON.stringify(second._reply.components).includes('뽑는 중'), '연출 중 두 번째 클릭은 "뽑는 중" 안내를 받아야 함');
    assert(m.board.map.at === at1, '연출 중 두 번째 클릭이 결과를 바꾸면 안 됨');
    const mid = JSON.stringify(team.buildBoardPayload(m, id).components);
    assert(mid.includes('attachment://map-1.jpg') && !mid.includes('map-final.jpg'), '연출 도중 카드를 다시 그려도 현재 프레임이 유지돼야 함');
    const spinBtn = findMapBtn(team.buildBoardPayload(m, id).components);
    assert(spinBtn.disabled === true && spinBtn.label.includes('뽑는 중'), '연출 중에는 버튼이 잠기고 뽑는 중 라벨이어야 함');
    assert(mid.includes('## 맵 뽑는 중...'), '연출 중 헤더는 맵 뽑는 중...');
    hold = false; waiters.forEach(r => r()); await first;
    assert(!team.__mapSpin.has(id), '연출이 끝나면 프레임 상태가 비워져야 함(동시 클릭 뒤에도)');
    team.__setMapSleep(() => Promise.resolve());

    unlock();
    // 수정이 실패해도(메시지가 지워짐 등) 예외 없이 멈추고, 결과는 저장돼 있고, 다시 누를 수 있다
    const broken = press(ADMIN);
    broken.editReply = async () => { throw new Error('Unknown Message'); };
    await team.handleTeamButton(broken);
    assert(m.board.map && !team.__mapSpin.has(id), '수정이 실패해도 결과는 저장되고 프레임 상태는 비워져야 함');
    unlock();
    const again = [];
    const retry = press(ADMIN);
    const retryEdit = retry.editReply.bind(retry);
    retry.editReply = async (p) => { again.push(1); return retryEdit(p); };
    await team.handleTeamButton(retry);
    assert(again.length === mapMod.SPIN_DELAYS_MS.length + 1, '실패 뒤에 다시 누르면 처음부터 연출돼야 함');

    // 팀을 다시 나눠도 맵은 그대로
    const keep = { ...m.board.map };
    await team.handleTeamButton(mkInteraction({ user: ADMIN, customId: `team:random:${id}` }));
    assert(m.board.map && m.board.map.key === keep.key, '팀을 다시 나눠도 뽑은 맵은 그대로여야 함');
    assert(JSON.stringify(boardMsg().components).includes('map-final.jpg'), '다시 올라온 카드에도 맵 이미지가 있어야 함');

    // 끝났거나 없는 내전
    const gone = mkInteraction({ user: ADMIN, customId: 'team:map:999999' });
    await team.handleTeamButton(gone);
    assert(gone._reply && JSON.stringify(gone._reply.components).includes('끝났거나'), '없는 내전이면 안내만');
    team.__setMapClock(() => Date.now());
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

  await flow('룰렛: 블랙월 게이트웨이를 사용하고 돌리면 100% 잭팟 · 아이템 1개 소모 · 취소하면 소모 안 함', async () => {
    const gw = require(path.join(root, 'handlers/게임/블랙월게이트웨이.js'));
    lv.applyXp('g1', 'gwuser', 800, 'test');
    assert(gw.grantGateway('g1', 'gwuser') && !gw.grantGateway('g1', 'gwuser'), '게이트웨이는 최대 1개');
    channel.sent.length = 0;
    // 사용 버튼이 로비에 떠야 하고, 켜고 끌 수 있다
    const s = mkInteraction({ user: 'gwuser', command: '룰렛' });
    await roulette.startRouletteCommand(s);
    const lobbyId = s.id;
    const lobbyJson = () => JSON.stringify(s._reply?.edit ?? s._lastPayload ?? {});
    await roulette.handleRouletteButton(mkInteraction({ user: 'gwuser', customId: `roulette:bet:${lobbyId}:10`, message: s._reply }));
    const gate = mkInteraction({ user: 'gwuser', customId: `roulette:gate:${lobbyId}`, message: s._reply });
    await roulette.handleRouletteButton(gate);
    await roulette.handleRouletteButton(mkInteraction({ user: 'gwuser', customId: `roulette:spin:${lobbyId}`, message: s._reply }));
    const shown = channel.sent.map(m => JSON.stringify(m.components || [])).join(' ');
    assert(shown.includes('JACKPOT') && shown.includes('블랙월 게이트웨이 사용'), '게이트웨이를 사용하고 돌리면 결과가 JACKPOT + 발동 표시');
    const left = gw.getGateways('g1', 'gwuser');
    assert(left === 0 || left === Infinity, '아이템은 돌릴 때 1개만 소모됨(남은 ' + left + '개)');
    // 사용 버튼을 누르면 걸 수 있는 최댓값으로 자동 베팅 — 베팅을 따로 고르지 않아도 바로 돌릴 수 있다
    // (룰렛은 하루 1회라 위에서 돌린 gwuser 와 다른 유저로)
    lv.applyXp('g1', 'gwuser2', 800, 'test'); gw.grantGateway('g1', 'gwuser2');
    const s2 = mkInteraction({ user: 'gwuser2', command: '룰렛' });
    await roulette.startRouletteCommand(s2);
    channel.sent.length = 0;
    await roulette.handleRouletteButton(mkInteraction({ user: 'gwuser2', customId: `roulette:gate:${s2.id}`, message: s2._reply }));
    const spin2 = mkInteraction({ user: 'gwuser2', customId: `roulette:spin:${s2.id}`, message: s2._reply });
    await roulette.handleRouletteButton(spin2);
    const shown2 = channel.sent.map(m => JSON.stringify(m.components || [])).join(' ');
    assert(shown2.includes('JACKPOT') && !JSON.stringify(spin2._replied ?? '').includes('먼저 베팅'), '게이트웨이 사용 버튼만 눌러도 최대 베팅으로 자동 베팅 → 바로 돌려 JACKPOT');
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

  // ── 해킹 툴: 레이드 보상(최대 3개) · 룰렛 꽝 번복 ──
  const hack = require(path.join(root, 'handlers/게임/해킹툴.js'));
  await flow('해킹 툴: 최대 3개 · 꽝이면 본인에게만 묻고 번복 · 넘기기', async () => {
    assert(hack.grantHackTool('g1', 'h0') && hack.grantHackTool('g1', 'h0') && hack.grantHackTool('g1', 'h0'), '3개까지 못 받음');
    assert(!hack.grantHackTool('g1', 'h0') && hack.getHackTools('g1', 'h0') === 3, '4개째를 받아 버림');

    const realRandom = Math.random;
    const queue = [];
    Math.random = () => (queue.length ? queue.shift() : realRandom());
    try {
      lv.applyXp('g1', 'h1', 800, 'test');
      hack.grantHackTool('g1', 'h1');
      const xp0 = lv.getXp('g1', 'h1');
      const s = mkInteraction({ user: 'h1', command: '룰렛' });
      await roulette.startRouletteCommand(s);
      assert(JSON.stringify(s._reply.components).includes('1/3개'), '로비에 해킹 툴 보유 수가 안 보임');
      await roulette.handleRouletteButton(mkInteraction({ user: 'h1', customId: `roulette:bet:${s.id}:10`, message: s._reply }));
      const spin = mkInteraction({ user: 'h1', customId: `roulette:spin:${s.id}`, message: s._reply });
      queue.push(0.1, 0.4, 0.6); // 🍒 🍋 🍇 → 꽝
      await roulette.handleRouletteButton(spin);
      assert(lv.getXp('g1', 'h1') === xp0 - 10, `꽝인데 XP가 ${lv.getXp('g1', 'h1') - xp0} 바뀜`);
      const prompt = client.rouletteHacks?.get(spin.id);
      assert(prompt?.msg, '꽝인데 해킹 툴 확인을 결과 아래에 안 띄움');
      assert(JSON.stringify(prompt.msg.components).includes(`roulette:hack:${spin.id}`), '확인 메시지에 사용 버튼이 없음');
      assert(!spin.replyDeleted, '확인이 떠 있는데 로비(돌리는 중 안내)를 지움 — 답장이 "메시지를 불러올 수 없어요"로 깨짐');
      const resultCard = prompt.message;
      assert(!JSON.stringify(resultCard.components).includes('roulette:hack'), '공개 결과 카드에 해킹 버튼이 붙음');

      await roulette.handleRouletteButton(mkInteraction({ user: 'u2', customId: `roulette:hack:${spin.id}`, message: s._reply }));
      assert(hack.getHackTools('g1', 'h1') === 1, '남이 눌렀는데 해킹 툴이 쓰임');

      queue.push(0.1, 0.1, 0.1); // 🍒 트리플 ×2 → 지급 20, 그날 손익 +10
      const use = mkInteraction({ user: 'h1', customId: `roulette:hack:${spin.id}`, message: prompt.msg });
      await roulette.handleRouletteButton(use);
      assert(hack.getHackTools('g1', 'h1') === 0, '해킹 툴이 안 줄어듦');
      assert(lv.getXp('g1', 'h1') === xp0 + 10, `번복 후 손익 ${lv.getXp('g1', 'h1') - xp0}(+10 기대)`);
      assert(JSON.stringify(resultCard.components).includes('1회 사용'), '공개 카드에 해킹 툴 사용 표시가 없음');
      assert(!client.rouletteHacks.has(use.id), '꽝이 아닌데 또 물어봄');
      assert(use.replyDeleted && spin.replyDeleted, '다시 돌린 결과가 나왔는데 "사용했어요" 안내나 "돌리는 중" 안내가 안 지워짐');
      await roulette.handleRouletteButton(mkInteraction({ user: 'h1', customId: `roulette:hack:${spin.id}`, message: prompt.msg }));
      assert(lv.getXp('g1', 'h1') === xp0 + 10, '같은 버튼을 다시 눌러 또 돌아감');

      // 해킹 툴이 남아 있어도 '넘기기'이면 쓰지 않는다
      lv.applyXp('g1', 'h2', 800, 'test');
      hack.grantHackTool('g1', 'h2');
      const s2 = mkInteraction({ user: 'h2', command: '룰렛' });
      await roulette.startRouletteCommand(s2);
      await roulette.handleRouletteButton(mkInteraction({ user: 'h2', customId: `roulette:bet:${s2.id}:10`, message: s2._reply }));
      const spin2 = mkInteraction({ user: 'h2', customId: `roulette:spin:${s2.id}`, message: s2._reply });
      queue.push(0.1, 0.4, 0.6);
      await roulette.handleRouletteButton(spin2);
      const p2 = client.rouletteHacks.get(spin2.id);
      const keep2 = mkInteraction({ user: 'h2', customId: `roulette:keep:${spin2.id}`, message: p2.msg });
      await roulette.handleRouletteButton(keep2);
      assert(keep2.replyDeleted && spin2.replyDeleted, '넘기기인데 확인 메시지나 "돌리는 중" 안내가 안 지워짐');
      assert(hack.getHackTools('g1', 'h2') === 1 && !client.rouletteHacks.has(spin2.id), '넘기기인데 해킹 툴이 쓰이거나 판이 남음');

      // 테스트 서버: 해킹 툴이 없어도 무제한으로 쓸 수 있고 개수가 줄지 않는다
      const TG = '1282694117255548960';
      const s3 = mkInteraction({ user: 'h3', command: '룰렛', guildId: TG });
      await roulette.startRouletteCommand(s3);
      assert(JSON.stringify(s3._reply.components).includes('무제한'), '테스트 서버 로비에 무제한 표시가 없음');
      await roulette.handleRouletteButton(mkInteraction({ user: 'h3', customId: `roulette:bet:${s3.id}:10`, message: s3._reply, guildId: TG }));
      const spin3 = mkInteraction({ user: 'h3', customId: `roulette:spin:${s3.id}`, message: s3._reply, guildId: TG });
      queue.push(0.1, 0.4, 0.6);
      await roulette.handleRouletteButton(spin3);
      const p3 = client.rouletteHacks.get(spin3.id);
      assert(p3?.msg && JSON.stringify(p3.msg.components).includes('무제한'), '테스트 서버에서 꽝인데 해킹 툴을 안 물어봄');
      queue.push(0.1, 0.4, 0.6); // 또 꽝 → 또 물어봐야 한다
      const use3 = mkInteraction({ user: 'h3', customId: `roulette:hack:${spin3.id}`, message: p3.msg, guildId: TG });
      await roulette.handleRouletteButton(use3);
      assert(hack.getHackTools(TG, 'h3') === 0 && client.rouletteHacks.has(use3.id), '테스트 서버에서 또 꽝인데 다시 안 물어봄');
      clearTimeout(client.rouletteHacks.get(use3.id).timeoutId); client.rouletteHacks.delete(use3.id);
    } finally {
      Math.random = realRandom;
    }
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
    // 🏅 티어 정보 초기화: 확인 화면 → 가짜 인원만 → 전부
    const tierM = require(path.join(root, 'handlers/매치/티어.js'));
    tierM.setTier('test_가짜', 'lol', { tier: 'gold', div: 2 });
    tierM.setTier('real1', 'valorant', { tier: 'imm', div: 1 });
    await home.handleAdminButton(mkInteraction({ user: ADMIN, customId: 'admin:tier:reset', message: msg }));
    assert(JSON.stringify(msg.components).includes('티어 정보 초기화'), '티어 초기화 확인 화면이 안 뜸');
    await home.handleAdminButton(mkInteraction({ user: ADMIN, customId: 'admin:tier:reset:test', message: msg }));
    assert(!tierM.getTier('test_가짜', 'lol') && tierM.getTier('real1', 'valorant'), '가짜 인원만 지우기가 진짜 사람 티어까지 지움');
    await home.handleAdminButton(mkInteraction({ user: ADMIN, customId: 'admin:tier:reset', message: msg }));
    await home.handleAdminButton(mkInteraction({ user: ADMIN, customId: 'admin:tier:reset:all', message: msg }));
    assert(tierM.tierStats().users === 0, '전부 초기화했는데 티어가 남음');
    const denied = mkInteraction({ user: 'u1', customId: 'admin:tier:reset:all', message: msg });
    await home.handleAdminButton(denied);
    assert(denied.replied, '관리자가 아닌데 초기화 버튼이 막히지 않음');
    for (const cid of ['xp:menu:manage', 'xp:mng:boost', 'xp:mng:raidauto', 'xp:mng:farm', 'xp:mngno', 'xp:menu:home', 'xp:menu:adjust', 'xp:menu:home']) {
      await xp.handleXpButton(mkInteraction({ user: ADMIN, customId: cid, message: msg }));
    }
    // XP 조정 유저 패널: 해킹 툴 지급(최대 3개에서 멈춤) · 회수
    const hackMod = require(path.join(root, 'handlers/게임/해킹툴.js'));
    for (let i = 0; i < 4; i++) await xp.handleXpButton(mkInteraction({ user: ADMIN, customId: 'xp:itemadd:hx1:hack', message: msg }));
    assert(hackMod.getHackTools('g1', 'hx1') === 3, `관리자 지급이 최대 3개에서 멈추지 않음(${hackMod.getHackTools('g1', 'hx1')})`);
    assert(JSON.stringify(msg.components).includes('3 / 3개'), '인벤토리에 해킹 툴 보유 개수가 안 보임');
    const gwMod = require(path.join(root, 'handlers/게임/블랙월게이트웨이.js'));
    await xp.handleXpButton(mkInteraction({ user: ADMIN, customId: 'xp:inv:hx1', message: msg }));
    for (let i = 0; i < 2; i++) await xp.handleXpButton(mkInteraction({ user: ADMIN, customId: 'xp:itemadd:hx1:gateway', message: msg }));
    assert(gwMod.getGateways('g1', 'hx1') === 1, '인벤토리 게이트웨이 지급이 최대 1개에서 멈추지 않음');
    await xp.handleXpButton(mkInteraction({ user: ADMIN, customId: 'xp:itemsub:hx1:gateway', message: msg }));
    assert(gwMod.getGateways('g1', 'hx1') === 0, '인벤토리 게이트웨이 회수가 안 됨');
    await xp.handleXpButton(mkInteraction({ user: ADMIN, customId: 'xp:invback:hx1', message: msg }));
    await xp.handleXpButton(mkInteraction({ user: ADMIN, customId: 'xp:itemsub:hx1:hack', message: msg }));
    assert(hackMod.getHackTools('g1', 'hx1') === 2, '관리자 회수가 안 됨');
    await xp.handleXpButton(mkInteraction({ user: 'u9', customId: 'xp:itemadd:hx1:hack', message: msg }));
    assert(hackMod.getHackTools('g1', 'hx1') === 2, '관리자가 아닌데 해킹 툴이 지급됨');
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
