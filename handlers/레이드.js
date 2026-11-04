// 레이드.js — 레이드: 약 3일마다 놀이터에 몬스터가 출현해 XP 시스템을 멈춰 세우고,
// 4인 선착순 파티가 턴제로 토벌하면 다시 풀린다. 전투 규칙·몬스터 데이터는 레이드전투.js, 패널 그림은
// 레이드그림.js에 있고, 이 파일은 출현 스케줄·화면 조립·버튼·타이머·XP 정지/보상을 맡는다.
//
// 흐름: 출현(XP 정지) → 모집 대기 1시간(역할 선택, 4명 차면 즉시 시작, 아무도 없으면 도주) → 턴제 전투(제한 15분)
//       → 토벌 성공(보상 XP) / 전멸·시간 초과·무참가(몬스터 도주) → XP 정지 해제.
//
// 화면: 게임 화면처럼 — 그림 한 장이 곧 게임 화면이고(몬스터·카드 상태 리본·지난 턴 말풍선·피해 숫자),
// 그 아래에는 컨테이너(임베드 창) 안에 실시간 타이머 한 줄(<t:..:R> — 디스코드 앱이 알아서 줄여 보여줘 봇이 고칠
// 필요가 없다)과 버튼만 둔다. 누가 행동을 고를 때마다 카드 리본이 바뀌도록 그림을 다시 그린다
// (화면 대기열이 300ms 모아 한 번에). 그림을 못 그리는 환경이면 같은 정보를 글자로 대신 보여준다.
//
// 반응 속도: 버튼 응답(interaction.update)으로 바로 화면을 고친다. 마지막 파티원이 행동을 고르면
// 그 응답 안에서 턴을 계산해 결과까지 한 번에 그린다. 타이머로 넘어가는 턴만 message.edit을 쓴다.
// 전투 상태는 메모리에만 두고 시작/끝에만 저장한다.

const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, AttachmentBuilder,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MediaGalleryBuilder, MediaGalleryItemBuilder,
  ComponentType, EmbedBuilder,
} = require('discord.js');
const { applyXp, isExcludedGuild, announceLevelUp, setRaidXpFrozen } = require('./레벨링');
const { KST_OFFSET_MS } = require('./시간');
const { GUILD_ID, PLAYGROUND_CHANNEL_ID, ADMIN_IDS } = require('../config');
const { logSystem, logError, userLabel } = require('./로그');
const { writeJsonIfChanged } = require('./저장');
const { displayNameFromInteraction } = require('./이름');
const {
  PLAYER_MAX_HP, ROLES, ROLE_ORDER, ACTIONS, MONSTERS,
  createBattle, checkChoice, choose, allChosen, resolveTurn,
} = require('./레이드전투');
const { renderRecruit, renderBattle, renderEnd, warmUp } = require('./레이드그림');

// ── 설정 ────────────────────────────────────────────────────────
const SPAWN_INTERVAL_DAYS = 3;     // 출현 주기(일). 출현한 날로부터 이만큼 뒤의 날, 아래 시간대 중 무작위 시각
const SPAWN_WINDOW_START_HOUR = 12; // KST. 사람이 없는 새벽에 떠서 아무도 못 잡는 일이 없게 시간대를 둔다
const SPAWN_WINDOW_END_HOUR = 23;
const RECRUIT_MS = 60 * 60 * 1000;  // 출현 후 모집 대기 시간 — 그동안 아무도 참가하지 않으면 몬스터 자동 도주
const TURN_MS = 60 * 1000;          // 턴당 행동 선택 시간(못 고르면 자동 공격)
const RESULT_MS = 2500;             // 턴 결과 화면을 보여주는 시간 — 그동안 버튼이 꺼지고, 끝나면 다음 턴 선택 화면으로
const BATTLE_LIMIT_MS = 15 * 60 * 1000; // 전투 제한 시간 — 넘기면 몬스터 도주
const PARTY_MAX = 4;
const CLEAR_XP = 300;               // 토벌 성공 시 파티원 1인당
const MVP_BONUS_XP = 100;           // 가장 많은 피해를 준 파티원 추가 보상
const SCHEDULER_TICK_MS = 60 * 1000;
// 남은 시간 표시(00:52:30)를 글자만 고쳐 갱신하는 주기. 디스코드는 채널당 메시지 수정이 대략 5초에 5번까지라
// 1초마다는 불가능하고 버튼 반응까지 밀린다 — 모집(최대 1시간)은 10초, 전투 턴(60초)은 5초마다.
const COUNTDOWN_TICK_MS = { recruit: 10 * 1000, battle: 5 * 1000 };
const IMAGE_NAME = 'raid.png';

const STATE_PATH = path.join(__dirname, '..', 'DB', 'raid.json');

// 디스크 상태: { autoSpawn, nextSpawnAt, active: { [guildId]: { channelId, messageId } } }
// autoSpawn: 본서버 자동 출현 가동 여부(/xp → XP 관리에서 켜고 끔). 값이 없으면 중지로 본다.
// active는 "재시작 직전에 진행 중이던 레이드" 표시용이다. 전투 자체는 저장하지 않으므로, 켜질 때
// 남아 있으면 그 메시지를 '봇 점검으로 사라졌다'로 정리한다(XP 정지는 메모리 플래그라 자동으로 풀린다).
function loadState() {
  let st = null;
  try {
    if (fs.existsSync(STATE_PATH)) st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    console.error('raid.json 읽기 실패(새로 시작):', err);
  }
  st = { autoSpawn: false, nextSpawnAt: null, active: {}, ...st };
  // 예전 형식(레이드 하나: { guildId, channelId, messageId })이면 서버별 형식으로 옮긴다.
  if (!st.active) st.active = {};
  else if (st.active.guildId) st.active = { [st.active.guildId]: { channelId: st.active.channelId, messageId: st.active.messageId } };
  return st;
}
function saveState(state) {
  try {
    writeJsonIfChanged(STATE_PATH, state);
  } catch (err) {
    console.error('raid.json 저장 실패:', err);
    logError('저장 오류', 'raid.json 저장 실패 — 레이드 출현 일정이 재시작 후 어긋날 수 있음', err);
  }
}
let state = loadState();

// 진행 중인 레이드는 서버(길드)마다 따로 — 테스트 서버에서 띄운 레이드와 본서버 레이드는 서로 막지 않는다.
const raids = new Map(); // guildId → r
const isCurrent = (r) => raids.get(r.guildId) === r;

// ── 출현 시각 계산 ──────────────────────────────────────────────
function kstDayStartUtc(epochMs, addDays = 0) {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + addDays) - KST_OFFSET_MS;
}
function randomTimeInWindow(dayStartUtc) {
  const start = dayStartUtc + SPAWN_WINDOW_START_HOUR * 3600_000;
  const end = dayStartUtc + SPAWN_WINDOW_END_HOUR * 3600_000;
  return start + Math.floor(Math.random() * (end - start));
}
function scheduleNextSpawn(fromMs = Date.now()) {
  state.nextSpawnAt = randomTimeInWindow(kstDayStartUtc(fromMs, SPAWN_INTERVAL_DAYS));
  saveState(state);
}
// 봇이 꺼져 있던 사이 출현 시각을 한참 넘겼으면(새벽에 켜지는 등) 그 자리에서 바로 띄우지 않고
// 오늘 남은 시간대(없으면 내일 시간대)의 무작위 시각으로 다시 잡는다.
function rescheduleOverdue(now = Date.now()) {
  const todayEnd = kstDayStartUtc(now) + SPAWN_WINDOW_END_HOUR * 3600_000;
  const todayStart = kstDayStartUtc(now) + SPAWN_WINDOW_START_HOUR * 3600_000;
  if (now < todayEnd - 30 * 60_000) {
    const from = Math.max(now, todayStart);
    state.nextSpawnAt = from + Math.floor(Math.random() * (todayEnd - from));
  } else {
    state.nextSpawnAt = randomTimeInWindow(kstDayStartUtc(now, 1));
  }
  saveState(state);
}

// ── 화면 ────────────────────────────────────────────────────────
const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
// 마감까지 남은 시간 → withHours면 항상 '00:52:30', 아니면 1시간 미만일 때 '04:30'
function clock(deadline, withHours = false) {
  const sec = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  const two = (n) => String(n).padStart(2, '0');
  return withHours || hh > 0 ? `${two(hh)}:${two(mm)}:${two(ss)}` : `${two(mm)}:${two(ss)}`;
}
// 컨테이너(임베드 창) 왼쪽 색 줄: 모집 빨강 · 전투 금색 · 분노 빨강 · 클리어 초록 · 그 외 종료 회색
const ACCENT = { recruit: 0xED4245, battle: 0xD9A93F, rage: 0xED4245, clear: 0x57F287, end: 0x4E5058 };

function bar(value, max, length) {
  const filled = Math.max(0, Math.min(length, Math.round((value / max) * length)));
  return '▰'.repeat(filled) + '▱'.repeat(length - filled);
}
function freezeNotice(r) {
  return r.freezesXp ? '\n> 🔧 **XP 시스템 고장!** 놀이터 미니게임 · 통화방 · 채팅 XP가 멈췄습니다.' : '';
}

// 컨테이너(임베드 창) 하나 안에 그림 → 글자 → 버튼을 담는다. sections: [{ text } | { separator } | { row }]
// image: { png } 새 그림 첨부 / { url } 지난번 올린 그림 재사용 / null 그림 없음.
function assemble(accent, image, sections) {
  const container = new ContainerBuilder().setAccentColor(accent);
  const mediaUrl = image?.png ? `attachment://${IMAGE_NAME}` : image?.url;
  if (mediaUrl) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(mediaUrl)));
  for (const s of sections) {
    if (s.text) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(s.text));
    else if (s.separator) container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    else if (s.row) container.addActionRowComponents(s.row);
  }
  const payload = { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
  // 새 그림을 올릴 때는 이전 첨부를 지우고 교체한다. 글자만 고칠 때는 첨부를 건드리지 않아 기존 그림이 남는다.
  if (image?.png) { payload.files = [new AttachmentBuilder(image.png, { name: IMAGE_NAME })]; payload.attachments = []; }
  else if (image === null) payload.attachments = [];
  return payload;
}

// redraw면 새로 그리고, 아니면 지난번 그림을 재사용한다. 그림을 못 그리면 null(글자 화면).
// 재사용할 때 디스코드 그림 주소를 못 읽어왔으면 첨부 파일 이름으로 가리킨다(첨부는 그대로 남아 있다).
async function pickImage(r, redraw, render) {
  if (!redraw) {
    // 디스코드가 돌려준 CDN 주소를 다시 넣으면 '외부 링크 그림'으로 취급돼 수정할 때마다 다시 불러와
    // 그림이 깜빡였다(타이머가 5~10초마다 바뀔 때마다). 첨부 파일 이름으로 가리키면 이미 붙어 있는
    // 같은 첨부를 그대로 쓴다(글자만 고칠 때는 attachments를 보내지 않아 첨부가 유지된다).
    return r.hasImage ? { url: `attachment://${IMAGE_NAME}` } : null;
  }
  const png = await render();
  r.hasImage = !!png;
  return png ? { png } : null;
}

// 보낸/고친 메시지에서 디스코드가 붙여준 그림 주소를 기억해, 다음 글자만 고치는 응답에 재사용한다.
function rememberImageUrl(r, message) {
  try {
    const top = (message?.components ?? []).map(c => c.toJSON?.()).filter(Boolean);
    const all = top.flatMap(c => (c.type === ComponentType.Container ? c.components : [c]));
    const gallery = all.find(c => c?.type === ComponentType.MediaGallery);
    r.imageUrl = gallery?.items?.[0]?.media?.url ?? null;
  } catch {
    r.imageUrl = null;
  }
}

async function recruitView(r, { redraw = true } = {}) {
  const image = await pickImage(r, redraw, () => renderRecruit(r));
  const m = r.monster;
  const sections = [];
  if (!image) {
    // 그림이 없을 때는 그림에 있던 정보(몬스터·파티 자리)를 글자로 대신한다.
    sections.push({
      text: `# 🚨 레이드 발생!\n## ${m.emoji} ${m.name} 출현!\n${m.lore}\n\n` +
        ROLE_ORDER.map(k => {
          const p = r.party.find(x => x.role === k);
          return `${ROLES[k].emoji} **${ROLES[k].name}** — ${p ? `**${p.name}**` : '-'}\n-# ✨ ${ROLES[k].skill.name}: ${ROLES[k].skill.desc}`;
        }).join('\n'),
    });
  }
  // 큰 타이머 → 파티 인원과 할 일, 한 줄에 하나씩
  sections.push({
    text: `## ⏳ ${clock(r.recruitEndsAt, true)}\n` +
      `**파티 ${r.party.length} / ${PARTY_MAX}** · 역할 버튼을 눌러 참가하세요\n` +
      // 몬스터 때문에 XP가 멈췄다는 걸 알려 참가 동기를 준다(레벨 시스템이 없는 테스트 서버에서도 문구는 보여줌)
      '> ⚠️ 몬스터가 XP 시스템을 장악해 **채팅 · 통화방 · 미니게임 XP 지급이 멈췄어요!**',
  });
  sections.push({
    row: new ActionRowBuilder().addComponents(
      ...ROLE_ORDER.map(roleKey => {
        const role = ROLES[roleKey];
        const taken = r.party.find(x => x.role === roleKey);
        return new ButtonBuilder()
          .setCustomId(`raid:role:${roleKey}`)
          .setEmoji(role.emoji)
          .setLabel(taken ? `${role.name} · ${taken.name}`.slice(0, 80) : `${role.name} 참가`)
          .setStyle(taken ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(!!taken);
      }),
    ),
  });
  sections.push({
    row: new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('raid:start').setEmoji('▶️').setLabel('바로 시작').setStyle(ButtonStyle.Success).setDisabled(r.party.length === 0),
      new ButtonBuilder().setCustomId('raid:leave').setEmoji('⛔').setLabel('참가 취소').setStyle(ButtonStyle.Danger).setDisabled(r.party.length === 0),
      new ButtonBuilder().setCustomId('raid:help').setEmoji('❔').setLabel('플레이 방법').setStyle(ButtonStyle.Secondary),
    ),
  });
  sections.push({
    // 이름표를 붙인 인용 블록 두 줄 — 보상과 시작 규칙을 한눈에
    text: `> 🎁 **보상** : +${CLEAR_XP} XP\n` +
      '> ▶️ **바로 시작** : 첫 참가자가 방장이 되며 시작 여부를 결정할 수 있어요.',
  });
  return assemble(ACCENT.recruit, image, sections);
}

function memberStatus(mem) {
  if (mem.hp <= 0) return `💀 ${mem.name}`;
  return `${mem.choice ? '✅' : '⏳'} ${mem.name}`;
}

async function battleView(r, { redraw = true } = {}) {
  const b = r.battle;
  const image = await pickImage(r, redraw, () => renderBattle(r));
  const m = b.monster;
  const sections = [];
  if (!image) {
    const intent = m.moves[b.intent];
    sections.push({
      text: `## ${b.rage ? `🔥 ${m.rageName}` : `${m.emoji} ${m.name}`}\n` +
        `\`${bar(b.hp, b.maxHp, 16)}\` **${b.hp.toLocaleString()}** / ${b.maxHp.toLocaleString()}\n` +
        `⚠️ 다음 행동: **${intent.telegraph}**${b.intent === 'smash' ? ' — **방어 추천!**' : ''}\n\n` +
        b.members.map(mem => `${ROLES[mem.role].emoji} **${mem.name}** \`${bar(mem.hp, PLAYER_MAX_HP, 8)}\` ${mem.hp}/${PLAYER_MAX_HP}` +
          ` · ✨${mem.cooldown > 0 ? `${mem.cooldown}턴` : '준비'} · 🍖×${mem.potions}`).join('\n'),
    });
  }
  // 제목을 크게 바꿔 턴 전환이 눈에 띄게: 결과 화면 '📜 TURN N 종료' → 선택 화면 '⚔️ TURN N+1 · 행동을 고르세요'
  if (r.showingResult) {
    sections.push({ text: `## 📜 TURN ${b.lastTurn?.turn ?? b.turn - 1} 종료\n-# 잠시 후 TURN ${b.turn}이 시작돼요` });
  } else {
    const pending = b.members.filter(mem => mem.hp > 0 && !mem.choice).map(mem => mem.name);
    sections.push({
      text: `## ⚔️ TURN ${b.turn} · 행동을 고르세요\n` +
        `⏳ **${clock(r.turnEndsAt)}** 남음\n` +
        (pending.length ? `-# 아직 고르지 않음: ${pending.join(', ')}` : '-# 모두 골랐어요 — 곧 턴이 진행돼요'),
    });
  }
  if (!image) {
    // 그림이 없을 때만 지난 턴 기록을 글자로 보여준다(그림에는 말풍선·피해 숫자로 들어가 있다).
    sections.push({ text: b.members.map(memberStatus).join('　') });
    if (b.log.length) sections.push({ text: `**📜 지난 턴**\n${b.log.join('\n')}` });
  }
  sections.push({ separator: true });
  sections.push({
    row: new ActionRowBuilder().addComponents(
      ...Object.entries(ACTIONS).map(([key, a]) =>
        new ButtonBuilder()
          .setCustomId(`raid:act:${key}`)
          .setEmoji(a.emoji)
          .setLabel(a.name)
          .setStyle(key === 'attack' ? ButtonStyle.Danger : key === 'skill' ? ButtonStyle.Primary : key === 'potion' ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(!!r.showingResult),
      ),
      new ButtonBuilder().setCustomId('raid:help').setEmoji('❔').setStyle(ButtonStyle.Secondary),
    ),
  });
  // 전투 전체 제한 시간은 턴 타이머와 헷갈리지 않게 버튼 아래 작은 글씨로 따로 둔다.
  sections.push({ text: `-# ⌛ 전투 종료까지 ${clock(r.battleEndsAt)}` });
  return assemble(b.rage ? ACCENT.rage : ACCENT.battle, image, sections);
}

const OUTCOME_TEXT = {
  clear:   '🎉 RAID CLEAR',
  wipe:    '☠️ 파티 전멸… 몬스터가 도망쳤다',
  timeout: '💨 시간 초과… 몬스터가 도망쳤다',
  noshow:  '💨 아무도 오지 않아 몬스터가 사라졌다',
  restart: '💨 봇 점검으로 몬스터가 사라졌다',
  admin:   '🛑 관리자가 레이드를 종료했다',
};

// 종료 화면 그림 아래 요약 카드: 큰 제목 · 인용 블록(핵심 결과) · 작은 글씨(기록·복구·다음 출현).
const END_HEADING = {
  clear: '🏆 RAID CLEAR!', wipe: '☠️ RAID FAILED', timeout: '⌛ RAID FAILED',
  noshow: '💨 아무도 오지 않았다', restart: '💨 봇 점검으로 중단', admin: '🛑 레이드 종료',
};
function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
}
// 이름 끝 글자 받침에 따라 '이'/'가'를 고른다(한글이 아니면 '이(가)')
function subjectJosa(name) {
  const code = String(name).trim().slice(-1).charCodeAt(0) - 0xAC00;
  if (code < 0 || code > 11171) return '이(가)';
  return code % 28 ? '이' : '가';
}
function endSummary(r, outcome, rewards) {
  const b = r.battle;
  const lines = [`## ${END_HEADING[outcome]}`];
  if (outcome === 'clear') {
    const mvp = rewards.find(x => x.mvp);
    const mvpName = mvp && b?.members.find(mem => mem.userId === mvp.userId)?.name;
    if (mvpName) lines.push(`> 👑 **MVP** : ${mvpName} · (+${mvp.xp} XP)`);
    const others = rewards.filter(x => !x.mvp).map(x => b.members.find(mem => mem.userId === x.userId)?.name).filter(Boolean);
    if (others.length) lines.push(`> 🎁 **보상** : ${others.join(', ')} · (+${CLEAR_XP} XP)`);
    if (!rewards.length) lines.push('> 직접 행동한 파티원이 없어 보상이 없어요');
  } else if (outcome === 'wipe' || outcome === 'timeout' || outcome === 'noshow') {
    lines.push(`> 💨 ${r.monster.name}${subjectJosa(r.monster.name)} 도망쳤다...`);
  } else if (outcome === 'admin') {
    lines.push('> 관리자가 레이드를 종료했어요');
  }
  const meta = [];
  if (b) meta.push(`⏱️ ${b.turn}턴${r.battleStartedAt ? ` · ${formatDuration((r.endedAt || Date.now()) - r.battleStartedAt)}` : ''}`);
  if (r.freezesXp) meta.push('🔧 XP 시스템 복구됨');
  if (meta.length) lines.push(`-# ${meta.join(' · ')}`);
  return lines.join('\n');
}

async function endView(r, outcome, rewards = []) {
  const image = await pickImage(r, true, () => renderEnd(r, outcome, rewards));
  const b = r.battle;
  const sections = [];
  if (!image) {
    let body = `# ${OUTCOME_TEXT[outcome]}\n## ${r.monster.emoji} ${r.monster.name}\n`;
    if (b) {
      body += `남은 HP **${b.hp.toLocaleString()}** / ${b.maxHp.toLocaleString()} · ${b.turn}턴\n\n` +
        b.members.map(mem => {
          const reward = rewards.find(x => x.userId === mem.userId);
          const xp = reward ? ` · **+${reward.xp} XP**${reward.mvp ? ' 👑MVP' : ''}` : '';
          const idle = outcome === 'clear' && !reward ? ' · *(직접 행동하지 않아 보상 없음)*' : '';
          return `${ROLES[mem.role].emoji} **${mem.name}** — 피해 ${mem.damage.toLocaleString()} · 회복 ${mem.healing}${xp}${idle}`;
        }).join('\n');
    }
    if (r.freezesXp) body += '\n\n> 🔧 **XP 시스템이 복구되었습니다!**';
    sections.push({ text: body });
  } else {
    sections.push({ text: endSummary(r, outcome, rewards) });
  }
  return assemble(outcome === 'clear' ? ACCENT.clear : ACCENT.end, image, sections);
}

function buildHelpText() {
  return [
    '## ❔ 레이드 플레이 방법',
    '- 매 턴 **60초 안에** 행동을 하나 고르세요. 못 고르면 자동으로 공격합니다.',
    '- 턴이 넘어가기 전까지는 다시 눌러 선택을 바꿀 수 있어요.',
    '- 파티원 전원이 고르면 바로 턴이 진행됩니다.',
    '- 몬스터는 **다음 행동을 미리 예고**합니다. 💥 큰 공격 예고에는 🛡️**방어**(피해 70% 감소)!',
    '- HP가 절반 아래로 떨어지면 몬스터가 **분노**해 더 아프게 때립니다.',
    '- 🍖**회복약**: HP +45 (전투당 2개) · ✨**스킬**: 역할마다 다름, 쓰면 몇 턴 쿨타임',
    '',
    ...ROLE_ORDER.map(k => `${ROLES[k].emoji} **${ROLES[k].name}** — ✨${ROLES[k].skill.name}: ${ROLES[k].skill.desc}`),
    '',
    `-# 제한 시간 ${BATTLE_LIMIT_MS / 60000}분 안에 쓰러뜨리지 못하거나 전멸하면 몬스터가 도망칩니다(보상 없음).`,
  ].join('\n');
}

// ── 화면 대기열 ─────────────────────────────────────────────────
// 4명이 거의 동시에 누르면 클릭마다 따로 보낸 응답이 디스코드에 도착하는 순서가 보장되지 않아,
// 늦게 도착한 옛 화면(지난 턴·옛 그림 주소)이 새 화면을 덮어쓸 수 있었다. 그래서 버튼은 즉시
// ack(deferUpdate)만 하고 상태를 바꾸며, 메시지 수정은 이 대기열 하나가 차례로 맡는다:
//  - 한 번에 하나만 수정하고, 보낼 때마다 "지금 상태"로 화면을 새로 만든다(옛 화면은 절대 안 나감)
//  - 선택 현황처럼 글자만 바뀌는 건 RENDER_DEBOUNCE_MS 동안 모아 한 번에 보낸다
//  - 턴 결과·참가자 변동처럼 그림이 바뀌는 건 바로(immediate) 보낸다
// 그림 그리기·PNG 압축도 이 안에서만 일어나 버튼 응답 경로를 막지 않고, 압축은 비동기라 그동안
// 내전/모집·임시 통화방 같은 다른 기능도 계속 처리된다.
const RENDER_DEBOUNCE_MS = 300;

function requestRender(r, { image = false, immediate = false } = {}) {
  r.dirty = true;
  if (image) r.imageDirty = true;
  if (r.flushing) return; // 도는 중인 루프가 끝나기 전에 이 변경까지 이어서 보낸다
  if (r.flushTimer && !immediate) return;
  if (r.flushTimer) clearTimeout(r.flushTimer);
  r.flushTimer = setTimeout(() => flush(r).catch(err => console.error('레이드 화면 갱신 실패:', err)), immediate ? 0 : RENDER_DEBOUNCE_MS);
}

async function flush(r) {
  r.flushTimer = null;
  r.flushing = true;
  try {
    while (r.dirty) {
      r.dirty = false;
      const redraw = r.imageDirty;
      r.imageDirty = false;
      // 놀이터 채팅에 묻혔으면(채널의 마지막 메시지가 레이드 메시지가 아니면) 맨 아래로 다시 올린다.
      // 새 메시지에는 그림을 다시 첨부해야 하므로 그림도 새로 그린다. 끝난 레이드(결과 화면)는 그대로 둔다.
      const buried = r.phase !== 'ended' && isBuried(r);
      const payload = await currentView(r, redraw || (buried && r.hasImage));
      const ok = buried ? await repostRaidMessage(r, payload) : await editRaidMessage(r, payload);
      // 메시지가 지워졌으면 계속 돌릴 화면이 없으므로 도주 처리한다.
      if (!ok && r.phase === 'battle') finishRaid(r, 'timeout');
    }
  } finally {
    r.flushing = false;
  }
}

function currentView(r, redraw) {
  if (r.phase === 'recruit') return recruitView(r, { redraw });
  if (r.phase === 'battle') return battleView(r, { redraw });
  return endView(r, r.outcome, r.rewards);
}

async function editRaidMessage(r, payload) {
  try {
    const message = await r.message.edit(payload);
    if (payload.files || payload.attachments) rememberImageUrl(r, message);
    return true;
  } catch (err) {
    console.error('레이드 메시지 수정 실패:', err);
    return false;
  }
}

function isBuried(r) {
  const lastId = r.message?.channel?.lastMessageId;
  return !!lastId && lastId !== r.message.id;
}

async function repostRaidMessage(r, payload) {
  const old = r.message;
  let message;
  try {
    message = await old.channel.send(payload);
  } catch (err) {
    console.error('레이드 메시지 다시 올리기 실패(제자리 수정으로 대신):', err);
    return editRaidMessage(r, payload);
  }
  r.message = message;
  rememberImageUrl(r, message);
  r.movedFrom.add(old.id);
  saveActive(r);
  old.delete().catch(err => console.error('예전 레이드 메시지 삭제 실패:', err));
  return true;
}

// 놀이터에 다른 메시지가 올라오면 잠깐(BUMP_DELAY_MS) 모았다가 레이드 메시지를 맨 아래로 다시 올린다.
// 채팅이 몰려도 이 간격에 한 번만 다시 올린다(타이머·버튼으로 화면이 바뀔 때도 묻혀 있으면 다시 올라간다).
const BUMP_DELAY_MS = 3000;
function noteChannelMessage(message) {
  const r = raids.get(message.guildId);
  if (!r || r.phase === 'ended' || !r.message || message.channelId !== r.channelId) return;
  if (message.author?.id === message.client.user?.id) return; // 봇이 보낸 메시지(다시 올린 레이드 메시지 포함)
  if (r.bumpTimer) return;
  r.bumpTimer = setTimeout(() => {
    r.bumpTimer = null;
    if (isCurrent(r) && r.phase !== 'ended' && isBuried(r)) requestRender(r, { immediate: true });
  }, BUMP_DELAY_MS);
}

// ── 진행 ────────────────────────────────────────────────────────
function saveActive(r) {
  state.active[r.guildId] = { channelId: r.channelId, messageId: r.message.id };
  saveState(state);
}

function clearTimer(r) {
  if (r.timer) clearTimeout(r.timer);
  r.timer = null;
}

// 남은 시간 글자를 주기적으로 갱신한다(그림은 다시 올리지 않음 — 화면 대기열이 글자만 고친다).
// 결과 단계(턴 전환)·종료 후에는 멈춘다. 레이드가 끝날 때까지 스스로 다음 틱을 예약한다.
function startCountdown(r) {
  if (r.countdownTimer) clearTimeout(r.countdownTimer);
  const tick = () => {
    r.countdownTimer = null;
    if (!isCurrent(r) || r.phase === 'ended') return;
    if (!(r.phase === 'battle' && r.showingResult)) requestRender(r);
    r.countdownTimer = setTimeout(tick, COUNTDOWN_TICK_MS[r.phase] ?? COUNTDOWN_TICK_MS.recruit);
  };
  r.countdownTimer = setTimeout(tick, COUNTDOWN_TICK_MS[r.phase] ?? COUNTDOWN_TICK_MS.recruit);
}

// 레이드를 띄운다. channel: 출현할 채널. 실패하면 사유 문구, 성공하면 null.
async function spawnRaid(client, channel, { forced = false } = {}) {
  if (raids.has(channel.guildId)) return '이 서버에 이미 진행 중인 레이드가 있어요.';
  const monster = MONSTERS[Math.floor(Math.random() * MONSTERS.length)];
  const now = Date.now();
  const r = {
    client,
    monster,
    guildId: channel.guildId,
    channelId: channel.id,
    message: null,
    imageUrl: null,
    phase: 'recruit',
    party: [], // { userId, name, role }
    recruitEndsAt: now + RECRUIT_MS,
    battle: null,
    battleEndsAt: 0,
    turnEndsAt: 0,
    timer: null,
    // 레벨 시스템이 없는 서버(테스트 서버)에서 띄운 레이드는 본서버 XP를 멈추지 않는다.
    freezesXp: !isExcludedGuild(channel.guildId),
    movedFrom: new Set(), // 아래로 다시 올리면서 지운 예전 메시지 id(그 버튼을 누르면 안내)
  };
  raids.set(r.guildId, r);
  try {
    r.message = await channel.send(await recruitView(r));
    rememberImageUrl(r, r.message);
  } catch (err) {
    raids.delete(r.guildId);
    console.error('레이드 출현 메시지 전송 실패:', err);
    logError('레이드', '레이드 출현 메시지 전송 실패', err);
    return '출현 메시지를 보내지 못했어요(채널 권한 확인).';
  }
  if (r.freezesXp) setRaidXpFrozen(true);
  saveActive(r);
  r.timer = setTimeout(() => onRecruitEnd(r).catch(err => console.error('레이드 모집 마감 처리 실패:', err)), RECRUIT_MS);
  startCountdown(r);
  logSystem({ 유형: '레이드', 채널: `#${channel.name ?? channel.id}`, 내용: `레이드 출현 — ${monster.name}${forced ? ' (관리자 소환)' : ''}${r.freezesXp ? ', XP 정지' : ''}` });
  return null;
}

// 모집 시간이 끝났을 때(타이머). 4명이 차서 이미 시작했으면 아무것도 하지 않는다.
async function onRecruitEnd(r) {
  if (!isCurrent(r) || r.phase !== 'recruit') return;
  if (r.party.length === 0) finishRaid(r, 'noshow');
  else startBattle(r);
}

function startBattle(r) {
  clearTimer(r);
  r.phase = 'battle';
  r.party.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)); // 화면에 역할 순서대로
  r.battle = createBattle(r.monster, r.party);
  r.battleStartedAt = Date.now(); // 종료 화면의 '걸린 시간'용
  r.battleEndsAt = r.battleStartedAt + BATTLE_LIMIT_MS;
  armTurnTimer(r);
  logSystem({ 유형: '레이드', 내용: `전투 시작 — ${r.party.map(p => `${p.name}(${ROLES[p.role].name})`).join(', ')} / HP ${r.battle.maxHp}` });
  requestRender(r, { image: true, immediate: true });
  startCountdown(r); // 전투는 5초 주기로
}

function armTurnTimer(r) {
  clearTimer(r);
  r.turnEndsAt = Math.min(Date.now() + TURN_MS, r.battleEndsAt);
  const turn = r.battle.turn;
  r.timer = setTimeout(() => {
    if (!isCurrent(r) || r.phase !== 'battle' || r.battle.turn !== turn) return;
    advanceTurn(r);
  }, Math.max(0, r.turnEndsAt - Date.now()));
}

// 턴을 하나 진행한다. 전투가 끝났으면 결과 화면, 아니면 턴 전환 연출:
// ① 결과 화면(TURN N 결과 띠, 버튼 꺼짐)을 RESULT_MS 동안 보여주고 ② 다음 턴 선택 화면으로 넘어가며
// 그때부터 행동 선택 시간을 잰다. 같은 메시지에서 그림만 조금 바뀌면 턴이 넘어간 걸 알아채기 어려워서다.
function advanceTurn(r) {
  clearTimer(r);
  const outcome = resolveTurn(r.battle);
  if (outcome) { finishRaid(r, outcome); return; }
  if (Date.now() >= r.battleEndsAt) { finishRaid(r, 'timeout'); return; }
  r.showingResult = true;
  requestRender(r, { image: true, immediate: true });
  const turn = r.battle.turn;
  r.timer = setTimeout(() => {
    if (!isCurrent(r) || r.phase !== 'battle' || r.battle.turn !== turn) return;
    r.showingResult = false;
    armTurnTimer(r);
    requestRender(r, { image: true, immediate: true });
  }, RESULT_MS);
}

// 레이드를 끝낸다. XP 정지 해제 · 보상 지급 · 상태 저장 · 복구 안내 후 결과 화면을 바로 보내게 한다.
function finishRaid(r, outcome) {
  clearTimer(r);
  if (r.countdownTimer) { clearTimeout(r.countdownTimer); r.countdownTimer = null; }
  if (r.bumpTimer) { clearTimeout(r.bumpTimer); r.bumpTimer = null; }
  r.phase = 'ended';
  r.outcome = outcome;
  r.endedAt = Date.now();
  if (isCurrent(r)) raids.delete(r.guildId);
  if (r.freezesXp) setRaidXpFrozen(false);
  delete state.active[r.guildId];
  saveState(state);

  const rewards = [];
  if (outcome === 'clear' && r.battle) {
    // 한 번도 직접 행동하지 않은(전부 자동 공격) 파티원은 자리만 차지한 것으로 보고 보상하지 않는다.
    const eligible = r.battle.members.filter(mem => mem.manualActions > 0);
    const mvp = eligible.reduce((best, mem) => (!best || mem.damage > best.damage ? mem : best), null);
    for (const mem of eligible) {
      const xp = CLEAR_XP + (mem === mvp ? MVP_BONUS_XP : 0);
      rewards.push({ userId: mem.userId, xp, mvp: mem === mvp });
      if (isExcludedGuild(r.guildId)) continue;
      const result = applyXp(r.guildId, mem.userId, xp, `레이드 토벌 '${r.monster.name}'${mem === mvp ? ' (MVP)' : ''}`);
      if (result.leveledUp) announceLevelUp(r.client, r.guildId, mem.userId, result.newLevel);
    }
  }

  logSystem({
    유형: '레이드',
    내용: `레이드 종료 — ${r.monster.name} / ${OUTCOME_TEXT[outcome]}` +
      (r.battle ? ` / ${r.battle.turn}턴, 남은 HP ${r.battle.hp}/${r.battle.maxHp}` : '') +
      (rewards.length ? ` / 보상: ${rewards.map(x => `${userLabel(x.userId)} +${x.xp}`).join(', ')}` : ''),
  });

  // 복구 안내는 채널에 따로 한 줄 올린다 — 결과 화면은 위쪽 메시지라 묻혀 있을 수 있어서.
  if (r.freezesXp && r.message?.channel) {
    r.message.channel.send({ content: '🔧 **XP 시스템이 다시 작동합니다!**', allowedMentions: { parse: [] } }).catch(() => {});
  }
  r.rewards = rewards;
  requestRender(r, { image: true, immediate: true });
}

// ── 버튼 ('raid:' 프리픽스) ─────────────────────────────────────
async function handleRaidButton(interaction) {
  const [, kind, arg] = interaction.customId.split(':');

  if (kind === 'help') {
    await interaction.reply({ content: buildHelpText(), flags: MessageFlags.Ephemeral });
    return;
  }

  // 혼자 시작 확인 메시지의 버튼 — 레이드 메시지가 아니라 그 사람에게만 보이는 메시지에 달려 있다.
  if (kind === 'solo') {
    const rr = raids.get(interaction.guildId);
    if (arg !== 'yes') {
      await interaction.update({ content: '취소했어요. 동료를 더 기다려 볼게요!', components: [] });
      return;
    }
    if (!rr || rr.phase !== 'recruit') {
      await interaction.update({ content: '⌛ 이미 시작됐거나 끝난 레이드예요.', components: [] });
      return;
    }
    const uid = interaction.user.id;
    if (!rr.party.length || (rr.party[0].userId !== uid && !ADMIN_IDS.includes(uid))) {
      await interaction.update({ content: '▶️ 바로 시작은 방장과 관리자만 할 수 있어요.', components: [] });
      return;
    }
    logSystem({ 유형: '레이드', 유저: userLabel(uid), 내용: `바로 시작(혼자 확인) — ${rr.party.length}명으로 출발` });
    startBattle(rr);
    // 시작했다는 안내는 따로 띄우지 않고, 혼자 시작 확인 메시지만 지운다(전투 화면이 바로 바뀌므로).
    await interaction.deferUpdate();
    await interaction.deleteReply().catch(() => {});
    return;
  }

  const r = raids.get(interaction.guildId);
  if (r?.movedFrom.has(interaction.message.id)) {
    await interaction.reply({ content: '⬇️ 레이드 메시지가 채팅 맨 아래로 옮겨졌어요. 아래 메시지에서 다시 눌러 주세요!', flags: MessageFlags.Ephemeral });
    return;
  }
  if (!r || r.message?.id !== interaction.message.id) {
    await interaction.reply({ content: '⌛ 이미 끝난 레이드예요.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (kind === 'role' || kind === 'leave' || kind === 'start') {
    if (r.phase !== 'recruit') {
      await interaction.reply({ content: '⚔️ 이미 전투가 시작됐어요.', flags: MessageFlags.Ephemeral });
      return;
    }
    const userId = interaction.user.id;
    // 바로 시작: 방장(지금 남아 있는 가장 먼저 참가한 사람)과 관리자만. 모집 시간을 다 기다리지 않고 출발한다.
    if (kind === 'start') {
      if (r.party.length === 0) {
        await interaction.reply({ content: '아직 참가자가 없어요.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (r.party[0].userId !== userId && !ADMIN_IDS.includes(userId)) {
        await interaction.reply({ content: `▶️ 바로 시작은 방장 **${r.party[0].name}**님과 관리자만 누를 수 있어요.`, flags: MessageFlags.Ephemeral });
        return;
      }
      // 혼자면 실수로 누른 건 아닌지 본인에게만 한 번 더 묻는다. 파티에 없는 관리자가 누르면 그 1명 기준으로 묻는다.
      if (r.party.length === 1) {
        const self = r.party[0].userId === userId;
        await interaction.reply({
          content: self
            ? '🙋 **지금 파티에 혼자예요.**\n정말 혼자 시작할까요? 도와줄 동료 없이 혼자 싸워야 해요.'
            : `🙋 **지금 파티에 1명뿐이에요.**\n정말 이대로 시작할까요? **${r.party[0].name}**님이 동료 없이 혼자 싸워야 해요.`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('raid:solo:yes').setEmoji('⚔️').setLabel(self ? '혼자 시작' : '1명으로 시작').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('raid:solo:no').setLabel('취소').setStyle(ButtonStyle.Secondary),
          )],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      logSystem({ 유형: '레이드', 유저: userLabel(userId), 내용: `바로 시작 — ${r.party.length}명으로 출발` });
      startBattle(r);
      await interaction.deferUpdate();
      return;
    }
    const mine = r.party.find(p => p.userId === userId);
    if (kind === 'leave') {
      if (!mine) {
        await interaction.reply({ content: '참가하지 않았어요.', flags: MessageFlags.Ephemeral });
        return;
      }
      r.party = r.party.filter(p => p.userId !== userId);
      requestRender(r, { image: true });
      await interaction.deferUpdate();
      return;
    }
    if (!ROLES[arg]) return;
    if (r.party.some(p => p.role === arg && p.userId !== userId)) {
      await interaction.reply({ content: '이미 다른 사람이 고른 역할이에요.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (mine) {
      mine.role = arg; // 참가 중이면 역할만 바꾼다
    } else {
      if (r.party.length >= PARTY_MAX) {
        await interaction.reply({ content: '파티가 가득 찼어요.', flags: MessageFlags.Ephemeral });
        return;
      }
      r.party.push({ userId, name: displayNameFromInteraction(interaction), role: arg });
    }
    // 4명이 차면 모집 시간이 남아 있어도 바로 출발한다.
    if (r.party.length >= PARTY_MAX) startBattle(r);
    else requestRender(r, { image: true });
    await interaction.deferUpdate();
    return;
  }

  if (kind === 'act') {
    if (r.phase !== 'battle') {
      await interaction.reply({ content: '⏳ 아직 모집 중이에요.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (r.showingResult) {
      await interaction.reply({ content: '📜 턴이 끝났어요. 곧 다음 턴이 시작돼요!', flags: MessageFlags.Ephemeral });
      return;
    }
    const error = checkChoice(r.battle, interaction.user.id, arg);
    if (error) {
      await interaction.reply({ content: `⚠️ ${error}`, flags: MessageFlags.Ephemeral });
      return;
    }
    choose(r.battle, interaction.user.id, arg);
    // 마지막 사람이 고르면 턴을 처리하고 결과(새 그림)를 바로 보낸다.
    // 아직 남았으면 카드 리본(행동 선택! → 준비)을 바꾼 그림을 잠깐 모았다가 한 번에 보낸다.
    if (allChosen(r.battle)) advanceTurn(r);
    else requestRender(r, { image: true });
    await interaction.deferUpdate();
  }
}

// ── 스케줄러 ────────────────────────────────────────────────────
async function recoverInterruptedRaids(client) {
  const list = Object.values(state.active);
  if (!list.length) return;
  state.active = {};
  saveState(state);
  for (const active of list) await recoverInterruptedRaid(client, active).catch(err => console.error('중단된 레이드 정리 실패:', err));
}
async function recoverInterruptedRaid(client, active) {
  const channel = await client.channels.fetch(active.channelId).catch(() => null);
  const message = channel && await channel.messages.fetch(active.messageId).catch(() => null);
  if (!message) return;
  const ghost = { monster: MONSTERS[0], battle: null, party: [], freezesXp: false, imageUrl: null };
  // 예전 버전(임베드)으로 띄운 메시지는 V2로 바꿀 수 없을 수 있어, 실패하면 임베드로 정리한다.
  await message.edit(await endView(ghost, 'restart')).catch(() =>
    message.edit({ embeds: [new EmbedBuilder().setColor(ACCENT.end).setDescription(`# ${OUTCOME_TEXT.restart}`)], components: [] }).catch(() => {}),
  );
}

async function spawnScheduled(client) {
  if (raids.has(GUILD_ID)) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  const channel = guild && await client.channels.fetch(PLAYGROUND_CHANNEL_ID).catch(() => null);
  scheduleNextSpawn(); // 성공 여부와 관계없이 다음 일정을 잡는다(실패한 출현을 1분마다 재시도하지 않게)
  if (!channel) {
    logError('레이드', '레이드 자동 출현 실패 — 놀이터 채널을 찾을 수 없음', null);
    return;
  }
  await spawnRaid(client, channel);
}

function startRaidScheduler(client) {
  warmUp(MONSTERS); // 그림 엔진·글자 모양을 잘게 나눠 미리 준비(첫 레이드가 봇을 멈추지 않게)
  recoverInterruptedRaids(client).catch(err => console.error('중단된 레이드 정리 실패:', err));
  if (!state.autoSpawn) {
    if (state.nextSpawnAt) { state.nextSpawnAt = null; saveState(state); } // 중지 중엔 일정을 두지 않는다
  } else if (!state.nextSpawnAt) scheduleNextSpawn();
  else if (Date.now() - state.nextSpawnAt > 60 * 60_000) rescheduleOverdue();
  setInterval(() => {
    if (!state.autoSpawn || raids.has(GUILD_ID) || !state.nextSpawnAt || Date.now() < state.nextSpawnAt) return;
    spawnScheduled(client).catch(err => console.error('레이드 자동 출현 실패:', err));
  }, SCHEDULER_TICK_MS);
}

// 그 서버에 레이드가 진행 중이라 놀이터(미니게임·/레벨·/랭킹·일일 퀴즈)를 멈춰야 하는지.
// 서버마다 따로 본다 — 테스트 서버 레이드는 테스트 서버만, 본서버 레이드는 본서버만 막는다.
function isPlaygroundPaused(guildId = GUILD_ID) {
  return raids.has(guildId);
}

// ── 관리자(/xp → XP 관리)용 ─────────────────────────────────────
function getRaidStatus(guildId) {
  const r = raids.get(guildId);
  return {
    active: !!r,
    phase: r?.phase ?? null,
    monsterName: r?.monster.name ?? null,
    autoSpawn: !!state.autoSpawn,
    nextSpawnAt: state.nextSpawnAt,
  };
}

// 본서버 자동 출현 가동/중지. 켜면 오늘부터 SPAWN_INTERVAL_DAYS일 뒤 시간대에 첫 출현을 잡고, 끄면 일정을 지운다.
function setAutoSpawn(on) {
  state.autoSpawn = !!on;
  if (on) scheduleNextSpawn();
  else { state.nextSpawnAt = null; saveState(state); }
  return getRaidStatus(GUILD_ID);
}

// 본서버에서는 놀이터에, 그 외(테스트 서버)에서는 버튼을 누른 채널에 띄운다.
async function forceSpawnRaid(interaction) {
  const channel = interaction.guildId === GUILD_ID
    ? await interaction.client.channels.fetch(PLAYGROUND_CHANNEL_ID).catch(() => null)
    : interaction.channel;
  if (!channel) return '놀이터 채널을 찾을 수 없어요.';
  return spawnRaid(interaction.client, channel, { forced: true });
}

async function forceEndRaid(guildId) {
  const r = raids.get(guildId);
  if (!r) return false;
  finishRaid(r, 'admin');
  return true;
}

module.exports = {
  handleRaidButton,
  startRaidScheduler,
  isPlaygroundPaused,
  getRaidStatus,
  setAutoSpawn,
  noteChannelMessage,
  forceSpawnRaid,
  forceEndRaid,
};
