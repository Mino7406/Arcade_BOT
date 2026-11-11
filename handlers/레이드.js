// 레이드.js — 레이드: 하루~사흘마다(무작위) 놀이터에 몬스터가 출현해 XP 시스템을 멈춰 세우고,
// 4인 선착순 파티가 턴제로 토벌하면 다시 풀린다. 전투 규칙·몬스터 데이터는 레이드전투.js, 패널 그림은
// 레이드그림.js에 있고, 이 파일은 출현 스케줄·화면 조립·버튼·타이머·XP 정지/보상을 맡는다.
//
// 흐름: 출현(XP 정지) → 모집 대기 1시간(역할 선택, 4명 차면 즉시 시작, 아무도 없으면 도주) → 턴제 전투(제한 20분)
//       → 토벌 성공(보상 XP) / 전멸·시간 초과·무참가(몬스터 도주) → XP 정지 해제.
//
// 화면: 게임 화면처럼 — 그림 한 장이 곧 게임 화면이고(몬스터·카드 상태 리본·지난 턴 말풍선·피해 숫자),
// 그 아래에는 컨테이너(임베드 창) 안에 실시간 타이머 한 줄(<t:..:R> — 디스코드 앱이 알아서 줄여 보여줘 봇이 고칠
// 필요가 없다)과 버튼만 둔다. 누가 행동을 고를 때마다 카드 리본이 바뀌도록 그림을 다시 그린다
// (화면 대기열이 300ms 모아 한 번에). 그림을 못 그리는 환경이면 같은 정보를 글자로 대신 보여준다.
//
// 반응 속도: 버튼 응답(interaction.update)으로 바로 화면을 고친다. 마지막 파티원이 행동을 고르면
// 그 응답 안에서 턴을 계산해 결과까지 한 번에 그린다. 타이머로 넘어가는 턴만 message.edit을 쓴다.
// 진행 상태(모집 파티·마감 시각·전투)는 화면을 고칠 때마다 DB/raid.json에 같이 저장해(바뀐 게 없으면 안 씀),
// 업데이트로 봇을 재시작해도 같은 메시지에서 이어서 진행한다.

const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, AttachmentBuilder,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, MediaGalleryBuilder, MediaGalleryItemBuilder,
  ComponentType,
} = require('discord.js');
const { applyXp, deductXpFromAll, isExcludedGuild, announceLevelUp, setRaidXpFrozen } = require('./레벨링');
const { KST_OFFSET_MS } = require('./시간');
const { GUILD_ID, PLAYGROUND_CHANNEL_ID, ADMIN_IDS } = require('../config');
const { logSystem, logError, userLabel } = require('./로그');
const { writeJsonIfChanged } = require('./저장');
const { displayNameFromInteraction } = require('./이름');
const {
  PLAYER_MAX_HP, POTIONS_PER_BATTLE, POTION_HEAL, GUARD_DAMAGE_RATE, ROLES, ROLE_ORDER, ACTIONS, MONSTERS,
  createBattle, checkChoice, choose, allChosen, resolveTurn,
  isStunned, slowTurnsLeft, isShielded, isPowered, poisonTurnsLeft, poisonStacks, poisonDamage, isConfused, chillStacks, isFeared, isPhased, telegraphText, isWarnIntent, minusPct, contribution,
} = require('./레이드전투');
const { renderRecruit, renderBattle, renderEnd, warmUp } = require('./레이드그림');

// ── 설정 ────────────────────────────────────────────────────────
const SPAWN_INTERVAL_DAYS = [1, 3]; // 출현 간격(일) 최소~최대. 매번 이 안에서 무작위로 뽑은 날 뒤, 아래 시간대 중 무작위 시각
const SPAWN_WINDOW_START_HOUR = 12; // KST. 사람이 없는 새벽에 떠서 아무도 못 잡는 일이 없게 시간대를 둔다
const SPAWN_WINDOW_END_HOUR = 23;
const MAX_MANUAL_SPAWN_AHEAD_DAYS = 30; // 관리자가 출현 시각을 직접 정할 때 최대 며칠 뒤까지(오타로 몇 년 뒤가 되는 것만 막음)
const RECRUIT_MS = 60 * 60 * 1000;  // 출현 후 모집 대기 시간 — 그동안 아무도 참가하지 않으면 몬스터 자동 도주
const TURN_MS = 60 * 1000;          // 턴당 행동 선택 시간(못 고르면 자동 공격)
const RESULT_MS = 4500;             // 턴 결과 화면을 보여주는 시간 — 그동안 버튼이 꺼지고, 끝나면 다음 턴 선택 화면으로(3.5초는 짧다는 사용자 요청으로 4.5초)
const BATTLE_LIMIT_MS = 20 * 60 * 1000; // 전투 제한 시간 — 넘기면 몬스터 도주
const PARTY_MAX = 4;
const CLEAR_XP = 300;               // 토벌 성공 시 파티원 1인당
const MVP_BONUS_XP = 100;           // 기여도 1위(피해 + 회복·부활 + 막아 준 피해, 레이드전투.js의 contribution) 추가 보상
// 토벌 실패(전멸·시간 초과·무참가로 도주) 시 서버의 모든 유저가 잃는 XP — 레이드마다 이 범위에서 무작위 하나(모두 같은 값)
const FAIL_PENALTY_XP_MIN = 50;
const FAIL_PENALTY_XP_MAX = 150;
const PENALTY_OUTCOMES = new Set(['wipe', 'timeout', 'noshow']);
const rollPenaltyXp = () => FAIL_PENALTY_XP_MIN + Math.floor(Math.random() * (FAIL_PENALTY_XP_MAX - FAIL_PENALTY_XP_MIN + 1));
const penaltyText = xp => `☠️ 모든 유저의 **${xp}XP**를 잃어버렸습니다...`;
const SCHEDULER_TICK_MS = 60 * 1000;
// 남은 시간 표시(00:52:30)를 글자만 고쳐 갱신하는 주기. 디스코드는 채널당 메시지 수정이 대략 5초에 5번까지라
// 1초마다는 불가능하고 버튼 반응까지 밀린다 — 모집(최대 1시간)은 10초, 전투 턴(60초)은 5초마다.
const COUNTDOWN_TICK_MS = { recruit: 10 * 1000, battle: 5 * 1000 };
const IMAGE_NAME = 'raid.png';
const HELP_DELETABLE_MS = 15 * 60 * 1000; // 디스코드가 비공개 응답을 지우게 해 주는 시간(응답 토큰 유효 15분)

const STATE_PATH = path.join(__dirname, '..', 'DB', 'raid.json');

// 디스크 상태: { autoSpawn, nextSpawnAt, nextMonsterId, active: { [guildId]: 진행 중인 레이드 } }
// nextMonsterId: 다음 자동 출현 때 나올 몬스터(일정을 잡을 때 무작위로 미리 정하고, 관리자가 /xp에서 바꿀 수 있음).
// autoSpawn: 본서버 자동 출현 가동 여부(/xp → XP 관리에서 켜고 끔). 값이 없으면 중지로 본다.
// active[guildId] = { channelId, messageId, monsterId, phase, recruitEndsAt, party, battle?, battleStartedAt?, battleEndsAt? }
// (battle은 몬스터 객체를 뺀 전투 상태). 켜질 때 남아 있으면 그 메시지에서 레이드를 이어간다(resumeRaid).
// 예전 버전이 남긴 { channelId, messageId }뿐인 기록은 메시지에 적힌 남은 시간으로 모집만 이어가고,
// 이어갈 수 없으면(전투 중이었거나 메시지가 없으면) '봇 점검으로 사라졌다'로 정리한다.
function loadState() {
  let st = null;
  try {
    if (fs.existsSync(STATE_PATH)) st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    console.error('raid.json 읽기 실패(새로 시작):', err);
  }
  st = { autoSpawn: false, nextSpawnAt: null, nextMonsterId: null, active: {}, ...st };
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
// 다음 자동 출현 몬스터는 일정을 잡을 때 등록된 몬스터 중 무작위로 미리 정한다(/xp에 '다음 몬스터'로 보이고 바꿀 수 있게).
const randomMonsterId = () => (MONSTERS.length ? MONSTERS[Math.floor(Math.random() * MONSTERS.length)].id : null);
const validMonsterId = (id) => (MONSTERS.some(m => m.id === id) ? id : null);
function scheduleNextSpawn(fromMs = Date.now()) {
  const [minDays, maxDays] = SPAWN_INTERVAL_DAYS;
  const days = minDays + Math.floor(Math.random() * (maxDays - minDays + 1));
  state.nextSpawnAt = randomTimeInWindow(kstDayStartUtc(fromMs, days));
  state.nextMonsterId = randomMonsterId();
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
  // XP 시스템이 고장 나 멈췄다는 걸 그림 바로 아래 큰 제목으로 강조해 참가 동기를 준다
  // (레벨 시스템이 없는 테스트 서버에서도 문구는 보여줌)
  sections.push({
    text: '>>> ## 🚫 XP 시스템 고장!\n' + // 인용 블록(>>>)으로 세 줄 모두 묶는다
      `${m.name}${subjectJosa(m.name)} XP 시스템을 망가뜨려 **채팅 · 통화방 · 미니게임 XP 지급이 정지**되었습니다.\n` +
      '-# 몬스터를 토벌하면 XP 시스템이 다시 작동해요',
  });
  // 큰 타이머 → 파티 인원과 할 일
  sections.push({
    text: `## ⏳ ${clock(r.recruitEndsAt, true)}\n` +
      `**파티 ${r.party.length} / ${PARTY_MAX}** · 역할 버튼을 눌러 참가하세요`,
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

function memberStatus(b, mem) {
  if (mem.hp <= 0) return `💀 ${mem.name}`;
  if (isStunned(b, mem)) return `${mem.stunStatus.emoji} ${mem.name}`;
  return `${mem.choice ? '✅' : '⏳'} ${mem.name}`;
}
// 같은 상태이상(이모지+이름)끼리 묶는다. 상태이상 이름은 몬스터 파일이 정한다(💧점액·💫기절 등).
function byStatus(members, statusKey) {
  const groups = new Map();
  for (const mem of members) {
    const label = `${mem[statusKey].emoji} ${mem[statusKey].name}`;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(mem);
  }
  return groups;
}
// 선택 화면 아래 상태 효과 안내(몬스터 보호막 · 공격력 증가 · 기절류 · 점액류 · 독류 · 환각류)
function effectLines(b) {
  const lines = [];
  const monsterName = b.rage ? b.monster.rageName : b.monster.name;
  const chill = b.monster.chill;
  // 얼음 갑옷(보호막 + chillOnHit): 때리면 냉기가 쌓인다는 것도 같은 줄에
  const spikes = isShielded(b) && chill && b.shieldChill ? ` · 때리면 ${chill.status.emoji}${chill.status.name} +${b.shieldChill}` : '';
  if (isShielded(b)) lines.push(`🛡️ 방어력 증가: ${monsterName} - **이번 턴 받는 피해 -${minusPct(b.shieldRate)}%**${spikes}`);
  if (isPowered(b)) lines.push(`⚔️ 공격력 증가: ${monsterName} - **다음 공격 피해 +${Math.round((b.powerRate - 1) * 100)}%**`);
  const stunned = b.members.filter(mem => mem.hp > 0 && isStunned(b, mem));
  for (const [label, mems] of byStatus(stunned, 'stunStatus')) lines.push(`${label}: ${mems.map(mem => mem.name).join(', ')} - **이번 턴 행동 불가**`);
  const slowed = b.members.filter(mem => mem.hp > 0 && slowTurnsLeft(b, mem) > 0);
  for (const [label, mems] of byStatus(slowed, 'slowStatus')) {
    // 같은 이름이라도 세기는 기술마다 다를 수 있다(보통 하나라 숫자도 하나)
    const pcts = [...new Set(mems.map(mem => minusPct(mem.slowRate)))];
    lines.push(`${label}: ${mems.map(mem => `${mem.name}(${slowTurnsLeft(b, mem)}턴)`).join(', ')} - **주는 피해 -${pcts.join('/')}%**`);
  }
  // 독류: 사람마다 중첩·남은 턴·이번 턴 피해가 달라 이름 옆에 붙인다
  const poisoned = b.members.filter(mem => mem.hp > 0 && poisonStacks(b, mem) > 0);
  for (const [label, mems] of byStatus(poisoned, 'poisonStatus')) {
    lines.push(`${label}: ${mems.map(mem => `${mem.name}(${mem.poisonStacks > 1 ? `×${mem.poisonStacks} · ` : ''}${poisonTurnsLeft(b, mem)}턴 · -${poisonDamage(b, mem)})`).join(', ')} - **이번 턴 행동 뒤 HP 감소(회복약·치유사 스킬로 해독)**`);
  }
  const confused = b.members.filter(mem => mem.hp > 0 && isConfused(b, mem));
  for (const [label, mems] of byStatus(confused, 'confuseStatus')) {
    const pcts = [...new Set(mems.map(mem => Math.round(mem.confuseRate * 100)))];
    lines.push(`${label}: ${mems.map(mem => mem.name).join(', ')} - **행동 ${pcts.join('/')}% 확률로 빗나감(방어는 성공)**`);
  }
  const feared = b.members.filter(mem => mem.hp > 0 && isFeared(b, mem));
  for (const [label, mems] of byStatus(feared, 'fearStatus')) lines.push(`${label}: ${mems.map(mem => mem.name).join(', ')} - **이번 턴 스킬 사용 불가**`);
  if (isPhased(b)) lines.push(`👻 투명화: ${monsterName} - **이번 턴 일반 공격은 빗나감(스킬은 맞음)**`);
  // 점화(꼬마 폭탄): 불끄기 진행 — 이번 턴 포함 남은 턴
  if (b.fuse) lines.push(`💣 도화선: 남은 불 **${Math.max(0, b.fuse.need - b.fuse.dealt).toLocaleString()} / ${b.fuse.need.toLocaleString()}** · 남은 ${Math.max(1, b.fuse.until - b.turn + 1)}턴 - **피해로 불을 다 끄면 기절, 못 끄면 대폭발**`);
  // 냉기: 몇 중첩인지가 중요해서 1중첩도 ×1로 붙인다
  const chilled = chill ? b.members.filter(mem => chillStacks(b, mem) > 0) : [];
  if (chilled.length) {
    const fz = chill.freezeStatus;
    // 몬스터 설정에 따라 안내: 방어로 쌓이거나 공격으로 녹는 규칙이 있으면 그걸, 없으면 막는 법·지우는 법
    const rules = [];
    if (chill.guardStacks) rules.push(`방어 +${chill.guardStacks}`);
    if (chill.melt) rules.push(`공격·스킬 -${chill.melt}`);
    if (!rules.length) rules.push('서리 숨결은 방어로 막음', '치유사 스킬·회복약으로 제거');
    lines.push(`${chill.status.emoji} ${chill.status.name}: ${chilled.map(mem => `${mem.name}(×${chillStacks(b, mem)})`).join(', ')} - **${chill.freezeAt}중첩이면 ${fz.emoji}${fz.name}(${rules.join(' · ')})**`);
  }
  return lines;
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
        `⚠️ 다음 행동: **${telegraphText(b)}**${isWarnIntent(b) ? ' — **방어 추천!**' : ''}\n\n` +
        b.members.map(mem => `${ROLES[mem.role].emoji} **${mem.name}** \`${bar(mem.hp, PLAYER_MAX_HP, 8)}\` ${mem.hp}/${PLAYER_MAX_HP}` +
          ` · ✨${mem.cooldown > 0 ? `${mem.cooldown}턴` : '준비'} · 🍖×${mem.potions}`).join('\n'),
    });
  }
  // 제목을 크게 바꿔 턴 전환이 눈에 띄게: 결과 화면 '📜 TURN N 종료' → 선택 화면 '⚔️ TURN N+1 · 행동을 고르세요'
  if (r.showingResult) {
    sections.push({ text: `## 📜 TURN ${b.lastTurn?.turn ?? b.turn - 1} 종료\n-# 잠시 후 TURN ${b.turn}이 시작돼요` });
  } else {
    const pending = b.members.filter(mem => mem.hp > 0 && !mem.choice && !isStunned(b, mem)).map(mem => mem.name);
    const effects = effectLines(b);
    sections.push({
      text: `## ⚔️ TURN ${b.turn} · 행동을 고르세요\n` +
        `⏳ **${clock(r.turnEndsAt)}** 남음\n` +
        (effects.length ? effects.join('\n') + '\n' : '') +
        (pending.length ? `-# 아직 고르지 않음: ${pending.join(', ')}` : '-# 모두 골랐어요 - 곧 턴이 진행돼요'),
    });
  }
  if (!image) {
    // 그림이 없을 때만 지난 턴 기록을 글자로 보여준다(그림에는 말풍선·피해 숫자로 들어가 있다).
    sections.push({ text: b.members.map(mem => memberStatus(b, mem)).join('　') });
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
  clear: '🎉 RAID CLEAR!', wipe: '☠️ RAID FAILED', timeout: '⌛ RAID FAILED',
  noshow: '💨 RAID FAILED', restart: '💨 봇 점검으로 중단', admin: '🛑 레이드 종료',
};
function formatDuration(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec >= 3600) return `${Math.floor(sec / 3600)}시간 ${Math.floor((sec % 3600) / 60)}분`;
  return sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
}
// 한국 시각 '14:02'
function kstHourMinute(epochMs) {
  const kst = new Date(epochMs + KST_OFFSET_MS);
  return `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
}
// 종료 채널 안내 아래 작은 글씨 — 문구만이 아니라 실제로 처리됐다는 걸 숫자로 보여 준다.
// 벌칙이면 실제로 깎인 인원·합계(deductXpFromAll 결과), 끝으로 XP가 멈춰 있던 중단 시간(출현~종료).
function endNoticeDetail(r, deducted) {
  const parts = [];
  if (deducted?.affected) parts.push(`${deducted.affected.toLocaleString()}명 · 합계 : -${deducted.total.toLocaleString()} XP`);
  if (r.frozenAt) parts.push(`중단 시간 : ${formatDuration(r.endedAt - r.frozenAt)} (${kstHourMinute(r.frozenAt)}~${kstHourMinute(r.endedAt)})`);
  return parts.map(p => `\n-# ${p}`).join(''); // 한 줄에 하나씩(합계 밑에 중단 시간 — 사용자 요청)
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
    // 제목 바로 아래 한 줄. 출현 안내('XP 시스템 고장!')처럼 테스트 서버에서도 같은 문구를 보여준다.
    const name = `${r.monster.name}${subjectJosa(r.monster.name)}`;
    lines.push(`${name} 토벌되어 XP 시스템이 복구되었습니다.`);
    const mvp = rewards.find(x => x.mvp);
    const mvpName = mvp && b?.members.find(mem => mem.userId === mvp.userId)?.name;
    if (mvpName) lines.push(`> 👑 **MVP** : ${mvpName} · (+${mvp.xp} XP)`);
    const others = rewards.filter(x => !x.mvp).map(x => b.members.find(mem => mem.userId === x.userId)?.name).filter(Boolean);
    if (others.length) lines.push(`> 🎁 **보상** : ${others.join(', ')} · (+${CLEAR_XP} XP)`);
    if (!rewards.length) lines.push('> 직접 행동한 파티원이 없어 보상이 없어요');
  } else if (outcome === 'wipe' || outcome === 'timeout' || outcome === 'noshow') {
    lines.push(`> 💨 ${outcome === 'wipe' ? '파티가 전멸하여 ' : ''}${r.monster.name}${subjectJosa(r.monster.name)} 도망쳤다...`);
  } else if (outcome === 'admin') {
    lines.push('> 관리자가 레이드를 종료했어요');
  }
  const meta = [];
  if (b) meta.push(`⏱️ ${b.turn}턴${r.battleStartedAt ? ` · ${formatDuration((r.endedAt || Date.now()) - r.battleStartedAt)}` : ''}`);
  // 클리어는 위 문장에 이미 들어 있다. 전멸·시간 초과·무참가는 XP를 잃었다는 안내가 채널에 따로 올라오므로 여기엔 넣지 않는다.
  if (r.freezesXp && outcome !== 'clear' && !PENALTY_OUTCOMES.has(outcome)) meta.push('🔧 XP 시스템 복구됨');
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
          return `${ROLES[mem.role].emoji} **${mem.name}** — 피해 ${mem.damage.toLocaleString()} · 회복 ${mem.healing} · 방어 ${mem.blocked ?? 0}${xp}${idle}`;
        }).join('\n');
    }
    if (r.freezesXp && !PENALTY_OUTCOMES.has(outcome)) body += '\n\n> 🔧 **XP 시스템이 복구되었습니다!**';
    sections.push({ text: body });
  } else {
    sections.push({ text: endSummary(r, outcome, rewards) });
  }
  return assemble(outcome === 'clear' ? ACCENT.clear : ACCENT.end, image, sections);
}

// ❔ 플레이 방법(본인에게만). 모든 몬스터에 공통인 규칙만 담는다 — 점액·단단해지기·재생처럼 몬스터마다
// 다른 기술은 넣지 않는다(몬스터가 바뀌면 틀린 설명이 되므로). 수치는 전투 규칙·몬스터 데이터에서 읽는다.
function buildHelpView(monster) {
  const rageAt = monster?.rage?.hpRatio === 0.5 ? '절반' : `${Math.round((monster?.rage?.hpRatio ?? 0.5) * 100)}%`;
  const smash = monster?.moves?.smash;
  const poison = Object.values(monster?.moves ?? {}).find(mv => mv.effect === 'poison'); // 독 기술이 있는 몬스터만 회복약 해독 안내
  // 필살기를 방어하지 않으면 생기는 일(필살기 데이터에서 읽음): 기절류는 행동 불가, 그 밖에 방어로 막는 상태이상은 이름으로
  const smashPenalty = smash?.effect === 'stun' ? ' 방어하지 않으면 다음 턴 **행동 불가**'
    : smash?.guardBlocks && smash.status ? ` 방어하지 않으면 **${smash.status.emoji}${smash.status.name}**` : '';
  const sections = [
    { text: '## ❔ 레이드 플레이 방법\n-# 몬스터를 쓰러뜨리면 멈춘 XP 시스템이 다시 작동해요' },
    { separator: true },
    { text: [
      '### ⏳ 턴 진행',
      `- 매 턴 **${TURN_MS / 1000}초** 안에 행동을 하나 골라요 - 못 고르면 **자동 공격**`,
      '- 턴이 넘어가기 전까지는 다시 눌러 **바꿀 수 있어요**',
      '- 파티원 전원이 고르면 **바로 진행**돼요',
    ].join('\n') },
    { separator: true },
    { text: [
      '### 🎮 행동',
      `${ACTIONS.attack.emoji} **${ACTIONS.attack.name}** - 역할별 기본 공격`,
      `${ACTIONS.skill.emoji} **${ACTIONS.skill.name}** - 역할마다 다름, 쓰면 몇 턴 쿨타임`,
      `${ACTIONS.guard.emoji} **${ACTIONS.guard.name}** - 이번 턴 받는 피해 **-${minusPct(GUARD_DAMAGE_RATE)}%**`,
      `${ACTIONS.potion.emoji} **${ACTIONS.potion.name}** - HP **+${POTION_HEAL}**${poison ? ` · ${poison.status.emoji}${poison.status.name} 해독` : ''} · 전투당 ${POTIONS_PER_BATTLE}개`,
    ].join('\n') },
    { separator: true },
    { text: [
      '### 👾 몬스터',
      '- 다음 행동을 **미리 예고**해요',
      `- 💥 큰 공격 예고에는 **방어**!${smashPenalty}`,
      `- HP가 ${rageAt} 아래로 떨어지면 **분노**해 더 아프게 때려요`,
    ].join('\n') },
    { separator: true },
    { text: [
      '### 🧑‍🤝‍🧑 역할',
      ...ROLE_ORDER.map(k => `${ROLES[k].emoji} **${ROLES[k].name}** - ✨${ROLES[k].skill.name}: ${ROLES[k].skill.desc} · 쿨타임 ${ROLES[k].skill.cooldown}턴`),
    ].join('\n') },
    { text: `-# ⌛ 제한 시간 ${BATTLE_LIMIT_MS / 60000}분 · 시간 안에 쓰러뜨리지 못하거나 전멸하면 몬스터가 도망쳐요(보상 없음)` },
  ];
  // 그림 없는 컨테이너 — 비공개 응답이라 Ephemeral과 Components V2 플래그를 함께 단다.
  return { ...assemble(ACCENT.battle, undefined, sections), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
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
      // 전투 시작 멘션은 화면보다 먼저 보내고, 레이드 메시지를 그 멘션 바로 아래로 다시 올린다.
      if (r.startMention) {
        const ids = r.startMention;
        r.startMention = null;
        if (await sendStartMention(r, ids)) r.forceRepost = true;
      }
      // 놀이터 채팅에 묻혔으면(채널의 마지막 메시지가 레이드 메시지가 아니면) 맨 아래로 다시 올린다.
      // 새 메시지에는 그림을 다시 첨부해야 하므로 그림도 새로 그린다. 끝난 레이드(결과 화면)는 그대로 둔다.
      const buried = r.phase !== 'ended' && (r.forceRepost || isBuried(r));
      r.forceRepost = false;
      const payload = await currentView(r, redraw || (buried && r.hasImage));
      const result = buried ? await repostRaidMessage(r, payload) : await editRaidMessage(r, payload);
      saveActive(r); // 파티 변동·턴 진행 등 바뀐 상태를 저장(바뀐 게 없으면 쓰지 않음)
      // 채널이 없어졌거나 권한이 없으면 화면을 계속 보여줄 수 없으므로 레이드를 끝낸다(XP 정지가 남지 않게).
      if (result === 'fatal' && r.phase !== 'ended') finishRaid(r, r.phase === 'battle' ? 'timeout' : 'noshow');
      // 일시적인 오류면 다음 갱신(타이머 글자 갱신 등) 때 다시 보낸다. 새 그림을 못 올렸으면 그때 다시 그린다.
      if (result === 'retry' && redraw) r.imageDirty = true;
      // 결과 화면을 처음 올린 뒤 채널 안내(복구 완료·XP 손실)를 보낸다. 실패해도 안내는 빠뜨리지 않는다.
      if (r.phase === 'ended' && r.endNotice) sendEndNotice(r);
    }
  } finally {
    r.flushing = false;
  }
}

// 레이드 종료 채널 안내를 결과 화면 바로 아래에 붙이지 않고 END_NOTICE_DELAY_MS 뒤에 보낸다.
// 디스코드는 같은 봇이 연달아 보낸 일반 메시지를 이름·프로필 없이 한 덩어리로 붙여 보여 줘서,
// 레이드 결과 메시지에 '답장'으로 보낸다 — 답장은 봇 이름·프로필이 다시 붙어 따로 보인다(알림은 울리지 않게).
const END_NOTICE_DELAY_MS = 1000;
function sendEndNotice(r) {
  const content = r.endNotice;
  const channel = r.message?.channel;
  const replyTo = r.message?.id;
  r.endNotice = null;
  if (!content || !channel) return;
  setTimeout(() => {
    channel.send({
      content,
      ...(replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}),
      allowedMentions: { parse: [], repliedUser: false },
    }).catch(() => {});
  }, END_NOTICE_DELAY_MS);
}

function currentView(r, redraw) {
  if (r.phase === 'recruit') return recruitView(r, { redraw });
  if (r.phase === 'battle') return battleView(r, { redraw });
  return endView(r, r.outcome, r.rewards);
}

// 레이드 메시지를 보내거나 고친 결과: 'ok' 성공 · 'retry' 일시적인 실패(다음 갱신 때 다시) · 'fatal' 계속할 수 없음.
// 디스코드 오류 코드: 10008 메시지 없음(누가 지움) · 10003 채널 없음 · 50001 접근 불가 · 50013 권한 없음.
const UNKNOWN_MESSAGE = 10008;
const FATAL_CODES = new Set([10003, 50001, 50013]);
const failKind = (err) => (FATAL_CODES.has(err?.code) ? 'fatal' : 'retry');

async function editRaidMessage(r, payload) {
  try {
    const message = await r.message.edit(payload);
    if (payload.files || payload.attachments) rememberImageUrl(r, message);
    return 'ok';
  } catch (err) {
    console.error('레이드 메시지 수정 실패:', err);
    // 누가 레이드 메시지를 지웠으면 새로 올려서 이어 간다(지금 화면 그대로).
    if (err?.code === UNKNOWN_MESSAGE) return sendRaidMessage(r, payload, { deleteOld: false });
    return failKind(err);
  }
}

// 레이드 메시지를 채널 맨 아래에 새로 올리고, 예전 메시지의 버튼은 "옮겨졌어요" 안내로 돌린다.
async function sendRaidMessage(r, payload, { deleteOld }) {
  const old = r.message;
  let message;
  try {
    message = await old.channel.send(payload);
  } catch (err) {
    console.error('레이드 메시지 새로 올리기 실패:', err);
    return failKind(err);
  }
  r.message = message;
  rememberImageUrl(r, message);
  saveActive(r);
  if (old.id === message.id) return 'ok';
  r.movedFrom.add(old.id);
  if (deleteOld) old.delete().catch(err => console.error('예전 레이드 메시지 삭제 실패:', err));
  return 'ok';
}

// 전투 시작을 파티원에게 알린다(멘션은 이 메시지에서만 — 레이드 화면은 멘션을 막아 둔다). 보냈으면 true.
// 채팅에 계속 남지 않게 1턴이 끝나면(advanceTurn) 지운다. 그 전에 1턴이 이미 끝났으면 바로 지운다.
async function sendStartMention(r, ids) {
  if (!ids.length || !r.message?.channel) return false;
  try {
    r.startMentionMessage = await r.message.channel.send({
      content: `⚔️ **레이드 전투 시작!** ${ids.map(id => `<@${id}>`).join(' ')} - 아래 레이드 메시지에서 ${TURN_MS / 1000}초 안에 행동을 골라 주세요`,
      allowedMentions: { users: ids },
    });
    if (r.phase !== 'battle' || r.battle.turn > 1) deleteStartMention(r);
    return true;
  } catch (err) {
    console.error('레이드 시작 멘션 전송 실패:', err);
    return false;
  }
}

function deleteStartMention(r) {
  const msg = r.startMentionMessage;
  if (!msg) return;
  r.startMentionMessage = null;
  Promise.resolve().then(() => msg.delete()).catch(err => console.error('레이드 시작 멘션 삭제 실패:', err));
}

function isBuried(r) {
  const lastId = r.message?.channel?.lastMessageId;
  return !!lastId && lastId !== r.message.id;
}

// 묻힌 메시지를 맨 아래로 다시 올린다. 새로 올리지 못하면(권한 등) 제자리 수정으로 대신한다.
async function repostRaidMessage(r, payload) {
  const result = await sendRaidMessage(r, payload, { deleteOld: true });
  return result === 'ok' ? 'ok' : editRaidMessage(r, payload);
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
// 재시작 후 이어가는 데 필요한 것만 저장한다. 내용이 직전과 같으면 디스크에 쓰지 않으므로(writeJsonIfChanged)
// 화면을 고칠 때마다 불러도 된다 — 타이머 글자만 바뀌는 갱신에서는 실제로 쓰지 않는다.
function saveActive(r) {
  if (!isCurrent(r) || r.phase === 'ended' || !r.message) return;
  const saved = {
    channelId: r.channelId,
    messageId: r.message.id,
    monsterId: r.monster.id,
    phase: r.phase,
    recruitEndsAt: r.recruitEndsAt,
    party: r.party,
  };
  if (r.frozenAt) saved.frozenAt = r.frozenAt; // 재시작해도 '중단 시간' 안내가 출현 시각부터 세도록
  if (r.battle) {
    const { monster, ...battle } = r.battle; // 몬스터는 그림 데이터까지 커서 id만 남긴다
    Object.assign(saved, { battle, battleStartedAt: r.battleStartedAt, battleEndsAt: r.battleEndsAt });
  }
  state.active[r.guildId] = saved;
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

// 레이드를 띄운다. channel: 출현할 채널. monsterId: 관리자가 고른 몬스터(없으면 등록된 몬스터 중 무작위 —
// 자동 출현은 늘 무작위). 실패하면 사유 문구, 성공하면 null.
async function spawnRaid(client, channel, { forced = false, monsterId = null } = {}) {
  if (raids.has(channel.guildId)) return '이 서버에 이미 진행 중인 레이드가 있어요.';
  if (!MONSTERS.length) return '등록된 몬스터가 없어요. Monster 폴더의 JSON 파일과 콘솔 오류를 확인하세요.';
  const monster = monsterId ? MONSTERS.find(m => m.id === monsterId) : MONSTERS[Math.floor(Math.random() * MONSTERS.length)];
  if (!monster) return '그 몬스터를 찾을 수 없어요. 다시 골라 주세요.';
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
    helpReplies: [], // 열려 있는 ❔ 플레이 방법 응답 { interaction, at } — 전투 시작·레이드 종료 때 닫는다
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
  if (r.freezesXp) { setRaidXpFrozen(true); r.frozenAt = Date.now(); }
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

// 열어 둔 ❔ 플레이 방법(본인에게만 보이는 메시지)을 닫는다. 디스코드는 응답 후 15분까지만 지울 수 있게 해서
// 그보다 오래된 건 지우지 못한다(실패는 조용히 넘긴다).
function closeHelpReplies(r) {
  const list = r.helpReplies ?? [];
  r.helpReplies = [];
  for (const { interaction } of list) interaction.deleteReply().catch(() => {});
}

// by: 시작을 누른 사람(바로 시작·4번째 참가). 그 사람은 이미 화면을 보고 있으니 멘션에서 뺀다.
// 모집 시간이 끝나 저절로 시작하면 by가 없어 파티원 전원을 부른다.
function startBattle(r, { by = null } = {}) {
  clearTimer(r);
  closeHelpReplies(r); // 모집 중에 열어 둔 가이드는 전투가 시작되면 닫는다
  r.phase = 'battle';
  r.party.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)); // 화면에 역할 순서대로
  const mention = r.party.map(p => p.userId).filter(id => id !== by);
  r.startMention = mention.length ? mention : null;
  // 본서버는 혼자여도 2인 HP(HP_MIN_PARTY), 테스트 서버는 혼자 끝까지 시험할 수 있게 1인 HP부터
  r.battle = createBattle(r.monster, r.party, Math.random, { minParty: isExcludedGuild(r.guildId) ? 1 : undefined });
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
  deleteStartMention(r); // 시작 멘션은 1턴이 끝나면 지운다
  const outcome = resolveTurn(r.battle);
  if (outcome) { finishRaid(r, outcome); return; }
  if (Date.now() >= r.battleEndsAt) { finishRaid(r, 'timeout'); return; }
  r.showingResult = true;
  requestRender(r, { image: true, immediate: true });
  const turn = r.battle.turn;
  r.timer = setTimeout(() => {
    if (!isCurrent(r) || r.phase !== 'battle' || r.battle.turn !== turn) return;
    r.showingResult = false;
    // 살아 있는 파티원이 전부 기절이면 고를 사람이 없으니 기다리지 않고 바로 이 턴을 진행한다.
    if (allChosen(r.battle)) { advanceTurn(r); return; }
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
  closeHelpReplies(r); // 전투 중에 연 가이드도 레이드가 끝나면 닫는다
  deleteStartMention(r);
  // XP를 멈추는 레이드가 다른 서버에 아직 남아 있으면 정지를 유지한다.
  if (r.freezesXp) setRaidXpFrozen([...raids.values()].some(x => x.freezesXp));
  delete state.active[r.guildId];
  saveState(state);

  const rewards = [];
  if (outcome === 'clear' && r.battle) {
    // 한 번도 직접 행동하지 않은(전부 자동 공격) 파티원은 자리만 차지한 것으로 보고 보상하지 않는다.
    const eligible = r.battle.members.filter(mem => mem.manualActions > 0);
    const mvp = eligible.reduce((best, mem) => (!best || contribution(r.battle, mem) > contribution(r.battle, best) ? mem : best), null);
    for (const mem of eligible) {
      const xp = CLEAR_XP + (mem === mvp ? MVP_BONUS_XP : 0);
      rewards.push({ userId: mem.userId, xp, mvp: mem === mvp });
      if (isExcludedGuild(r.guildId)) continue;
      const result = applyXp(r.guildId, mem.userId, xp, `레이드 토벌 '${r.monster.name}'${mem === mvp ? ' (MVP)' : ''}`);
      if (result.leveledUp) announceLevelUp(r.client, r.guildId, mem.userId, result.newLevel);
    }
  }
  // 전멸·시간 초과·무참가로 몬스터가 도망치면 그 서버의 모든 유저가 XP를 잃는다(레벨 시스템이 없는 테스트 서버는 문구만).
  const penalty = PENALTY_OUTCOMES.has(outcome);
  const penaltyXp = penalty ? rollPenaltyXp() : 0; // 테스트 서버(문구만)도 같은 방식으로 뽑은 값을 보여 준다
  let deducted = null;
  if (penalty && !isExcludedGuild(r.guildId)) {
    deducted = deductXpFromAll(r.guildId, penaltyXp, `레이드 토벌 실패 '${r.monster.name}' (${OUTCOME_TEXT[outcome]})`);
  }
  const penalized = deducted?.affected ?? 0;

  logSystem({
    유형: '레이드',
    내용: `레이드 종료 — ${r.monster.name} / ${OUTCOME_TEXT[outcome]}` +
      (r.battle ? ` / ${r.battle.turn}턴, 남은 HP ${r.battle.hp}/${r.battle.maxHp}` : '') +
      (rewards.length ? ` / 보상: ${rewards.map(x => `${userLabel(x.userId)} +${x.xp}`).join(', ')}` : '') +
      (penalized ? ` / 벌칙: 모든 유저 -${penaltyXp} XP (${penalized}명)` : ''),
  });

  // 복구 안내는 채널에 따로 한 줄 올린다 — 결과 화면은 위쪽 메시지라 묻혀 있을 수 있어서.
  // 토벌 실패(벌칙)면 복구 안내 대신 XP를 잃었다는 안내를 올린다.
  // 바로 보내면 결과 화면(그림 그리기·전송)보다 먼저 떠서, 결과 화면을 올린 뒤 조금 있다가 보낸다(flush).
  if (r.freezesXp && r.message?.channel) {
    r.endNotice = (penalty ? penaltyText(penaltyXp) : '🔧 **XP 시스템 복구 완료.**') + endNoticeDetail(r, deducted);
  }
  r.rewards = rewards;
  requestRender(r, { image: true, immediate: true });
}

// ── 버튼 ('raid:' 프리픽스) ─────────────────────────────────────
async function handleRaidButton(interaction) {
  const [, kind, arg] = interaction.customId.split(':');

  if (kind === 'help') {
    const rr = raids.get(interaction.guildId);
    await interaction.reply(buildHelpView(rr?.monster ?? MONSTERS[0]));
    // 레이드가 진행 중이면 기억해 뒀다가 전투 시작·레이드 종료 때 닫는다. 15분 지난 건(못 지움) 목록에서 뺀다.
    if (rr && rr.phase !== 'ended') {
      const now = Date.now();
      rr.helpReplies = rr.helpReplies.filter(h => now - h.at < HELP_DELETABLE_MS);
      rr.helpReplies.push({ interaction, at: now });
    }
    return;
  }

  // 혼자 시작 확인 메시지의 버튼 — 레이드 메시지가 아니라 그 사람에게만 보이는 메시지에 달려 있다.
  if (kind === 'solo') {
    const rr = raids.get(interaction.guildId);
    if (arg !== 'yes') {
      await interaction.deferUpdate();
      await interaction.deleteReply().catch(() => {});
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
    startBattle(rr, { by: uid });
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
      startBattle(r, { by: userId });
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
    if (r.party.length >= PARTY_MAX) startBattle(r, { by: userId });
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
// ── 재시작 후 이어가기 ──────────────────────────────────────────
// 메시지의 컴포넌트(컨테이너 안쪽까지 펼쳐서) 목록
function flatComponents(message) {
  const top = (message?.components ?? []).map(c => c.toJSON?.() ?? c).filter(Boolean);
  const all = top.flatMap(c => (c.type === ComponentType.Container ? c.components ?? [] : [c]));
  return all.flatMap(c => (c.type === ComponentType.ActionRow ? [c, ...(c.components ?? [])] : [c]));
}
function raidButtonKinds(message) {
  return new Set(flatComponents(message).map(c => c.custom_id).filter(id => id?.startsWith('raid:')).map(id => id.split(':')[1]));
}

// 예전 버전이 남긴 기록({ channelId, messageId }뿐)이나 기록 없이 찾은 메시지에서 모집 상태를 읽는다.
// 모집 화면(역할 버튼)일 때만 이어간다. 마감 시각은 화면의 '⏳ 00:41:48'과 그 글자를 고친 시각으로 계산하고,
// 못 읽으면 메시지를 올린 시각 + 모집 시간으로 본다. 참가자는 화면에 이름만 있고 유저 id가 없어 비운다.
function readLegacyRecruit(message) {
  if (!raidButtonKinds(message).has('role')) return null;
  const text = flatComponents(message).filter(c => c.type === ComponentType.TextDisplay).map(c => c.content).join('\n');
  const m = text.match(/⏳\s*(\d{1,2}):(\d{2}):(\d{2})/);
  const recruitEndsAt = m
    ? (message.editedTimestamp ?? message.createdTimestamp) + ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000
    : message.createdTimestamp + RECRUIT_MS;
  const monster = MONSTERS.find(x => text.includes(x.name)) ?? MONSTERS[0];
  return { phase: 'recruit', monsterId: monster.id, recruitEndsAt, party: [] };
}

// 저장된 상태로 레이드를 되살린다. 이어갔으면 true, 이어갈 수 없으면 false(호출부가 정리).
async function resumeRaid(client, message, saved) {
  const guildId = message.guildId;
  if (raids.has(guildId) || !MONSTERS.length) return false;
  const info = saved?.phase ? saved : readLegacyRecruit(message);
  if (!info || (info.phase !== 'recruit' && info.phase !== 'battle')) return false;
  if (info.phase === 'battle' && !info.battle) return false;
  const monster = MONSTERS.find(x => x.id === info.monsterId) ?? MONSTERS[0];
  const now = Date.now();
  const r = {
    client,
    monster,
    guildId,
    channelId: message.channelId,
    message,
    imageUrl: null,
    phase: info.phase,
    party: Array.isArray(info.party) ? info.party : [],
    recruitEndsAt: info.recruitEndsAt || now,
    battle: null,
    battleEndsAt: 0,
    turnEndsAt: 0,
    timer: null,
    freezesXp: !isExcludedGuild(guildId),
    movedFrom: new Set(),
    helpReplies: [],
  };
  rememberImageUrl(r, message);
  r.hasImage = !!r.imageUrl;
  if (info.phase === 'battle') {
    r.battle = { ...info.battle, monster };
    r.battleStartedAt = info.battleStartedAt || now;
    // 봇이 꺼져 있던 동안 전투 시간이 다 지나갔어도 한 턴은 고를 수 있게 한다.
    r.battleEndsAt = Math.max(info.battleEndsAt || 0, now + TURN_MS);
  }
  raids.set(guildId, r);
  if (r.freezesXp) {
    setRaidXpFrozen(true);
    // 출현 시각. 예전 기록엔 없어서 레이드 메시지를 올린 시각으로 본다(아래로 다시 올린 메시지면 조금 늦게 잡힘).
    r.frozenAt = info.frozenAt || message.createdTimestamp || now;
  }
  saveActive(r);
  logSystem({
    유형: '레이드',
    내용: `재시작 후 레이드 이어가기 — ${monster.name} / ${r.phase === 'recruit' ? `모집 중(파티 ${r.party.length}명, 마감 ${clock(r.recruitEndsAt, true)} 남음)` : `전투 ${r.battle.turn}턴`}` +
      (saved?.phase ? '' : ' (예전 기록에서 복구)'),
  });

  if (r.phase === 'recruit') {
    const left = r.recruitEndsAt - Date.now();
    if (left <= 0) { await onRecruitEnd(r); return true; } // 꺼져 있던 사이 모집이 끝났으면 바로 마감 처리
    if (r.party.length >= PARTY_MAX) { startBattle(r); return true; }
    r.timer = setTimeout(() => onRecruitEnd(r).catch(err => console.error('레이드 모집 마감 처리 실패:', err)), left);
  } else {
    // 결과 화면 도중이었으면 다음 턴 선택 화면부터. 이미 고른 행동은 그대로 두고, 고를 시간은 새로 준다.
    r.showingResult = false;
    if (allChosen(r.battle)) { advanceTurn(r); startCountdown(r); return true; }
    armTurnTimer(r);
  }
  requestRender(r, { image: true, immediate: true });
  startCountdown(r);
  return true;
}

// 이어갈 수 없는 레이드 메시지를 '봇 점검으로 사라졌다'로 정리한다.
async function markInterrupted(message) {
  if (!MONSTERS.length) {
    await message.edit({ content: `# ${OUTCOME_TEXT.restart}`, embeds: [], components: [] }).catch(() => {});
    return;
  }
  const ghost = { monster: MONSTERS[0], battle: null, party: [], freezesXp: false, imageUrl: null };
  // 예전 버전(임베드)으로 띄운 메시지는 V2로 바꿀 수 없을 수 있어, 실패하면 글자만으로 정리한다.
  await message.edit(await endView(ghost, 'restart')).catch(() =>
    message.edit({ content: `# ${OUTCOME_TEXT.restart}`, embeds: [], components: [] }).catch(() => {}),
  );
}

async function recoverInterruptedRaids(client) {
  const handled = new Set(); // 처리한 메시지 id
  for (const [guildId, saved] of Object.entries(state.active)) {
    const channel = await client.channels.fetch(saved.channelId).catch(() => null);
    const message = channel && await channel.messages.fetch(saved.messageId).catch(() => null);
    if (message) handled.add(message.id);
    const resumed = message && await resumeRaid(client, message, saved).catch(err => {
      console.error('레이드 이어가기 실패:', err);
      logError('레이드', '재시작 후 레이드 이어가기 실패 — 점검 중단으로 정리', err);
      cleanupFailedResume(guildId);
      return false;
    });
    if (resumed) continue;
    if (state.active[guildId]?.messageId === saved.messageId) { delete state.active[guildId]; saveState(state); }
    if (message) await markInterrupted(message).catch(err => console.error('중단된 레이드 정리 실패:', err));
  }
  // 기록이 없어도(저장 파일이 지워졌거나 덮어써진 경우) 놀이터에 버튼이 살아 있는 레이드 메시지가 남아 있으면 이어간다.
  // 레이드 메시지는 묻힘 방지로 늘 채널 맨 아래 근처에 있다.
  if (raids.has(GUILD_ID)) return;
  const channel = await client.channels.fetch(PLAYGROUND_CHANNEL_ID).catch(() => null);
  const recent = channel?.messages && await channel.messages.fetch({ limit: 30 }).catch(() => null);
  if (!recent) return;
  const me = client.user?.id;
  const orphans = [...recent.values()]
    .filter(msg => !handled.has(msg.id) && (!me || msg.author?.id === me) && raidButtonKinds(msg).size > 0)
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  for (const msg of orphans) {
    const resumed = !raids.has(GUILD_ID) && await resumeRaid(client, msg, null).catch(err => {
      console.error('레이드 이어가기 실패:', err);
      cleanupFailedResume(GUILD_ID);
      return false;
    });
    if (!resumed) await markInterrupted(msg).catch(() => {});
  }
}
function cleanupFailedResume(guildId) {
  const r = raids.get(guildId);
  if (!r) return;
  clearTimer(r);
  if (r.countdownTimer) clearTimeout(r.countdownTimer);
  raids.delete(guildId);
  if (r.freezesXp && ![...raids.values()].some(x => x.freezesXp)) setRaidXpFrozen(false);
  delete state.active[guildId];
  saveState(state);
}

async function spawnScheduled(client) {
  if (raids.has(GUILD_ID)) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  const channel = guild && await client.channels.fetch(PLAYGROUND_CHANNEL_ID).catch(() => null);
  const monsterId = validMonsterId(state.nextMonsterId); // 미리 정해 둔 몬스터(없거나 지워진 몬스터면 무작위)
  scheduleNextSpawn(); // 성공 여부와 관계없이 다음 일정을 잡는다(실패한 출현을 1분마다 재시도하지 않게)
  if (!channel) {
    logError('레이드', '레이드 자동 출현 실패 — 놀이터 채널을 찾을 수 없음', null);
    return;
  }
  await spawnRaid(client, channel, { monsterId });
}

function startRaidScheduler(client) {
  warmUp(MONSTERS); // 그림 엔진·글자 모양을 잘게 나눠 미리 준비(첫 레이드가 봇을 멈추지 않게)
  // 이어갈 레이드가 있으면 메시지를 불러오는 동안에도 XP가 새지 않게 미리 멈춰 두고, 다 끝난 뒤 실제 상태로 맞춘다.
  if (Object.keys(state.active).some(g => !isExcludedGuild(g))) setRaidXpFrozen(true);
  recoverInterruptedRaids(client)
    .catch(err => console.error('중단된 레이드 정리 실패:', err))
    .finally(() => { if (![...raids.values()].some(r => r.freezesXp)) setRaidXpFrozen(false); });
  if (!state.autoSpawn) {
    if (state.nextSpawnAt || state.nextMonsterId) { state.nextSpawnAt = null; state.nextMonsterId = null; saveState(state); } // 중지 중엔 일정을 두지 않는다
  } else if (!state.nextSpawnAt) scheduleNextSpawn();
  else {
    if (Date.now() - state.nextSpawnAt > 60 * 60_000) rescheduleOverdue();
    // 예전 기록(다음 몬스터 없음)이거나 그 몬스터 파일이 빠졌으면 무작위로 다시 정한다
    if (!validMonsterId(state.nextMonsterId)) { state.nextMonsterId = randomMonsterId(); saveState(state); }
  }
  setInterval(() => {
    if (!state.autoSpawn || !state.nextSpawnAt || Date.now() < state.nextSpawnAt) return;
    // 출현 시각에 이미 레이드가 떠 있으면(관리자 소환 등) 이번 출현은 건너뛰고 다음 일정을 잡는다
    // — 그대로 두면 그 레이드가 끝나자마자 1분 안에 또 떠 버린다.
    if (raids.has(GUILD_ID)) { scheduleNextSpawn(); return; }
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
    nextMonster: state.autoSpawn ? (MONSTERS.find(m => m.id === state.nextMonsterId) ?? null) : null, // 다음 자동 출현 몬스터
  };
}

// 본서버 자동 출현 가동/중지. 켜면 오늘부터 1~2일(무작위) 뒤 시간대에 첫 출현을 잡고, 끄면 일정을 지운다.
function setAutoSpawn(on) {
  state.autoSpawn = !!on;
  if (on) scheduleNextSpawn();
  else { state.nextSpawnAt = null; state.nextMonsterId = null; saveState(state); }
  return getRaidStatus(GUILD_ID);
}

// 다음 자동 출현 시각을 관리자가 직접 정한다(무작위로 잡힌 값을 덮어씀). 자동 출현이 가동 중일 때만.
// 출현 뒤 그다음 일정은 평소처럼 1~2일 무작위로 다시 잡힌다. 실패하면 이유 문자열, 성공하면 null.
function setNextSpawnAt(epochMs, now = Date.now()) {
  if (!state.autoSpawn) return '자동 출현이 중지돼 있어요. 먼저 가동해 주세요.';
  if (!Number.isFinite(epochMs) || epochMs <= now) return '지금보다 뒤의 시각을 적어 주세요.';
  if (epochMs - now > MAX_MANUAL_SPAWN_AHEAD_DAYS * 86400_000) return `${MAX_MANUAL_SPAWN_AHEAD_DAYS}일 안쪽으로만 정할 수 있어요.`;
  state.nextSpawnAt = epochMs;
  saveState(state);
  return null;
}

// 다음 자동 출현 몬스터를 관리자가 바꾼다(monsterId 또는 'random' — 무작위로 다시 뽑기). 자동 출현이 가동 중일 때만.
// 실패하면 이유 문자열, 성공하면 null. 출현 뒤 그다음 몬스터는 평소처럼 무작위로 다시 정해진다.
function setNextMonster(monsterId) {
  if (!state.autoSpawn) return '자동 출현이 중지돼 있어요. 먼저 가동해 주세요.';
  const id = monsterId === 'random' ? randomMonsterId() : validMonsterId(monsterId);
  if (!id) return '그 몬스터를 찾을 수 없어요. 다시 골라 주세요.';
  state.nextMonsterId = id;
  saveState(state);
  return null;
}

// 본서버에서는 놀이터에, 그 외(테스트 서버)에서는 버튼을 누른 채널에 띄운다. monsterId가 없으면 무작위.
async function forceSpawnRaid(interaction, monsterId = null) {
  const channel = interaction.guildId === GUILD_ID
    ? await interaction.client.channels.fetch(PLAYGROUND_CHANNEL_ID).catch(() => null)
    : interaction.channel;
  if (!channel) return '놀이터 채널을 찾을 수 없어요.';
  return spawnRaid(interaction.client, channel, { forced: true, monsterId });
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
  setNextSpawnAt,
  setNextMonster,
  noteChannelMessage,
  forceSpawnRaid,
  forceEndRaid,
  effectLines, // 테스트용(전투 화면 상태 줄)
};
