// 레이드.js — 긴급 퀘스트(레이드): 약 3일마다 놀이터에 몬스터가 출현해 XP 시스템을 멈춰 세우고,
// 4인 선착순 파티가 턴제로 토벌하면 다시 풀린다. 전투 규칙·몬스터 데이터는 레이드전투.js에 있고,
// 이 파일은 출현 스케줄·임베드 화면·버튼·타이머·XP 정지/보상을 맡는다.
//
// 흐름: 출현(XP 정지) → 모집 10분(역할 선택, 4명 차면 즉시 시작) → 턴제 전투(제한 10분)
//       → 토벌 성공(보상 XP) / 전멸·시간 초과·무참가(몬스터 도주) → XP 정지 해제.
//
// 반응 속도: 버튼 응답(interaction.update)으로 바로 화면을 고친다. 마지막 파티원이 행동을 고르면
// 그 응답 안에서 턴을 계산해 결과까지 한 번에 그리므로, 별도 메시지 수정 요청이 없다. 타이머로
// 넘어가는 턴(늦게 고른 경우)만 message.edit을 쓴다. 남은 시간은 디스코드 시간 표시(<t:..:R>)가
// 알아서 줄어들게 해 매초 수정하지 않는다. 전투 상태는 메모리에만 두고 시작/끝에만 저장한다.

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { applyXp, isExcludedGuild, announceLevelUp, setRaidXpFrozen } = require('./레벨링');
const { KST_OFFSET_MS } = require('./시간');
const { GUILD_ID, PLAYGROUND_CHANNEL_ID } = require('../config');
const { logSystem, logError, userLabel } = require('./로그');
const { writeJsonIfChanged } = require('./저장');
const { displayNameFromInteraction } = require('./이름');
const {
  PLAYER_MAX_HP, ROLES, ROLE_ORDER, ACTIONS, MONSTERS,
  createBattle, getMember, checkChoice, choose, allChosen, resolveTurn,
} = require('./레이드전투');

// ── 설정 ────────────────────────────────────────────────────────
const SPAWN_INTERVAL_DAYS = 3;     // 출현 주기(일). 출현한 날로부터 이만큼 뒤의 날, 아래 시간대 중 무작위 시각
const SPAWN_WINDOW_START_HOUR = 12; // KST. 사람이 없는 새벽에 떠서 아무도 못 잡는 일이 없게 시간대를 둔다
const SPAWN_WINDOW_END_HOUR = 23;
const RECRUIT_MS = 10 * 60 * 1000;  // 모집 시간
const TURN_MS = 30 * 1000;          // 턴당 행동 선택 시간(못 고르면 자동 공격)
const BATTLE_LIMIT_MS = 10 * 60 * 1000; // 전투 제한 시간 — 넘기면 몬스터 도주
const PARTY_MAX = 4;
const CLEAR_XP = 300;               // 토벌 성공 시 파티원 1인당
const MVP_BONUS_XP = 100;           // 가장 많은 피해를 준 파티원 추가 보상
const SCHEDULER_TICK_MS = 60 * 1000;

const STATE_PATH = path.join(__dirname, '..', 'DB', 'raid.json');

// 디스크 상태: { nextSpawnAt, active: { guildId, channelId, messageId } | null }
// active는 "재시작 직전에 진행 중이던 레이드" 표시용이다. 전투 자체는 저장하지 않으므로, 켜질 때
// 남아 있으면 그 메시지를 '봇 점검으로 도망쳤다'로 정리한다(XP 정지는 메모리 플래그라 자동으로 풀린다).
function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    console.error('raid.json 읽기 실패(새로 시작):', err);
  }
  return { nextSpawnAt: null, active: null };
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

// 지금 진행 중인 레이드(메모리). 한 번에 하나만 돈다.
let raid = null;

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
function bar(value, max, length) {
  const filled = Math.max(0, Math.min(length, Math.round((value / max) * length)));
  return '▰'.repeat(filled) + '▱'.repeat(length - filled);
}
function freezeNotice(r) {
  return r.freezesXp ? '\n> 🔧 **XP 시스템 고장!** 놀이터 미니게임 · 통화방 · 채팅 XP가 멈췄습니다.' : '';
}

function buildRecruitPayload(r) {
  const m = r.monster;
  const lines = ROLE_ORDER.map(roleKey => {
    const role = ROLES[roleKey];
    const p = r.party.find(x => x.role === roleKey);
    return `${role.emoji} **${role.name}** — ${p ? `**${p.name}**` : '*빈자리*'}\n-# ✨ ${role.skill.name}: ${role.skill.desc}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0xED4245)
    .setDescription(
      `# 🚨 긴급 퀘스트 발생!\n` +
      `## ${m.emoji} ${m.name} 출현!\n` +
      `${m.lore}${freezeNotice(r)}\n\n` +
      `**토벌 파티 모집 (${r.party.length}/${PARTY_MAX})** · 마감 ${ts(r.recruitEndsAt)}\n` +
      `-# 역할 버튼을 눌러 참가하세요. 4명이 모이면 바로 출발합니다.\n\n` +
      lines.join('\n') +
      `\n\n-# 토벌 성공 시 파티원 전원 +${CLEAR_XP} XP · 최다 피해 MVP +${MVP_BONUS_XP} XP`,
    );
  const roleRow = new ActionRowBuilder().addComponents(
    ...ROLE_ORDER.map(roleKey => {
      const role = ROLES[roleKey];
      const taken = r.party.find(x => x.role === roleKey);
      return new ButtonBuilder()
        .setCustomId(`raid:role:${roleKey}`)
        .setEmoji(role.emoji)
        .setLabel(taken ? `${role.name} · ${taken.name}`.slice(0, 80) : role.name)
        .setStyle(taken ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(!!taken);
    }),
  );
  const miscRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('raid:leave').setLabel('참가 취소').setStyle(ButtonStyle.Secondary).setDisabled(r.party.length === 0),
    new ButtonBuilder().setCustomId('raid:help').setEmoji('❔').setLabel('플레이 방법').setStyle(ButtonStyle.Secondary),
  );
  return { content: '', embeds: [embed], components: [roleRow, miscRow] };
}

function memberLine(b, mem) {
  const role = ROLES[mem.role];
  let status;
  if (mem.hp <= 0) status = '💀 쓰러짐';
  else if (mem.choice) status = '✅ 선택 완료';
  else status = '⏳ 선택 중';
  const skill = mem.cooldown > 0 ? `✨${mem.cooldown}턴` : '✨준비';
  return `${role.emoji} **${mem.name}** \`${bar(mem.hp, PLAYER_MAX_HP, 8)}\` ${mem.hp}/${PLAYER_MAX_HP} · ${status}\n-# ${skill} · 🍖×${mem.potions}`;
}

function buildBattlePayload(r) {
  const b = r.battle;
  const m = b.monster;
  const intent = m.moves[b.intent];
  const name = b.rage ? `🔥 ${m.rageName}` : `${m.emoji} ${m.name}`;
  const intentHint = b.intent === 'smash' ? ' — **방어 추천!**' : (b.intent === 'attack' ? ' — 한 명을 노린다' : '');
  const embed = new EmbedBuilder()
    .setColor(b.rage ? 0xED4245 : 0xFEE75C)
    .setDescription(
      `## ${name}\n` +
      `\`${bar(b.hp, b.maxHp, 16)}\` **${b.hp.toLocaleString()}** / ${b.maxHp.toLocaleString()}\n` +
      `⚠️ 다음 행동: **${intent.telegraph}**${intentHint}\n\n` +
      `**턴 ${b.turn}** · 행동 마감 ${ts(r.turnEndsAt)} · 전투 종료 ${ts(r.battleEndsAt)}${freezeNotice(r)}\n\n` +
      b.members.map(mem => memberLine(b, mem)).join('\n') +
      (b.log.length ? `\n\n**📜 지난 턴**\n${b.log.join('\n')}` : ''),
    );
  const row = new ActionRowBuilder().addComponents(
    ...Object.entries(ACTIONS).map(([key, a]) =>
      new ButtonBuilder()
        .setCustomId(`raid:act:${key}`)
        .setEmoji(a.emoji)
        .setLabel(a.name)
        .setStyle(key === 'attack' ? ButtonStyle.Danger : key === 'skill' ? ButtonStyle.Primary : key === 'potion' ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
    new ButtonBuilder().setCustomId('raid:help').setEmoji('❔').setStyle(ButtonStyle.Secondary),
  );
  return { content: '', embeds: [embed], components: [row] };
}

const OUTCOME_TEXT = {
  clear:   { title: '🎉 QUEST CLEAR', color: 0x57F287 },
  wipe:    { title: '☠️ 파티 전멸… 몬스터가 도망쳤다', color: 0x2B2D31 },
  timeout: { title: '💨 시간 초과… 몬스터가 도망쳤다', color: 0x2B2D31 },
  noshow:  { title: '💨 아무도 오지 않아 몬스터가 사라졌다', color: 0x2B2D31 },
  restart: { title: '💨 봇 점검으로 몬스터가 사라졌다', color: 0x2B2D31 },
  admin:   { title: '🛑 관리자가 긴급 퀘스트를 종료했다', color: 0x2B2D31 },
};

function buildEndPayload(r, outcome, rewards = []) {
  const o = OUTCOME_TEXT[outcome];
  const b = r.battle;
  const m = r.monster;
  let body = `# ${o.title}\n## ${m.emoji} ${m.name}\n`;
  if (b) {
    body += `남은 HP **${b.hp.toLocaleString()}** / ${b.maxHp.toLocaleString()} · ${b.turn}턴\n\n`;
    body += b.members.map(mem => {
      const reward = rewards.find(x => x.userId === mem.userId);
      const xp = reward ? ` · **+${reward.xp} XP**${reward.mvp ? ' 👑MVP' : ''}` : '';
      const idle = outcome === 'clear' && !reward ? ' · *(직접 행동하지 않아 보상 없음)*' : '';
      return `${ROLES[mem.role].emoji} **${mem.name}** — 피해 ${mem.damage.toLocaleString()} · 회복 ${mem.healing}${xp}${idle}`;
    }).join('\n');
    if (b.log.length) body += `\n\n**📜 마지막 턴**\n${b.log.join('\n')}`;
  }
  if (r.freezesXp) body += `\n\n> 🔧 **XP 시스템이 복구되었습니다!**`;
  return { content: '', embeds: [new EmbedBuilder().setColor(o.color).setDescription(body).setTimestamp()], components: [] };
}

function buildHelpText() {
  return [
    '## ❔ 긴급 퀘스트 플레이 방법',
    '- 매 턴 **30초 안에** 행동을 하나 고르세요. 못 고르면 자동으로 공격합니다.',
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

// ── 진행 ────────────────────────────────────────────────────────
function clearTimer(r) {
  if (r.timer) clearTimeout(r.timer);
  r.timer = null;
}

async function editRaidMessage(r, payload) {
  try {
    await r.message.edit(payload);
    return true;
  } catch (err) {
    console.error('레이드 메시지 수정 실패:', err);
    return false;
  }
}

// 레이드를 띄운다. channel: 출현할 채널. 실패하면 사유 문구, 성공하면 null.
async function spawnRaid(client, channel, { forced = false } = {}) {
  if (raid) return '이미 진행 중인 긴급 퀘스트가 있어요.';
  const monster = MONSTERS[Math.floor(Math.random() * MONSTERS.length)];
  const now = Date.now();
  const r = {
    client,
    monster,
    guildId: channel.guildId,
    channelId: channel.id,
    message: null,
    phase: 'recruit',
    party: [], // { userId, name, role }
    recruitEndsAt: now + RECRUIT_MS,
    battle: null,
    battleEndsAt: 0,
    turnEndsAt: 0,
    timer: null,
    // 레벨 시스템이 없는 서버(테스트 서버)에서 띄운 레이드는 본서버 XP를 멈추지 않는다.
    freezesXp: !isExcludedGuild(channel.guildId),
  };
  raid = r;
  try {
    r.message = await channel.send(buildRecruitPayload(r));
  } catch (err) {
    raid = null;
    console.error('레이드 출현 메시지 전송 실패:', err);
    logError('레이드', '긴급 퀘스트 출현 메시지 전송 실패', err);
    return '출현 메시지를 보내지 못했어요(채널 권한 확인).';
  }
  if (r.freezesXp) setRaidXpFrozen(true);
  state.active = { guildId: r.guildId, channelId: r.channelId, messageId: r.message.id };
  saveState(state);
  r.timer = setTimeout(() => onRecruitEnd(r).catch(err => console.error('레이드 모집 마감 처리 실패:', err)), RECRUIT_MS);
  logSystem({ 유형: '레이드', 채널: `#${channel.name ?? channel.id}`, 내용: `긴급 퀘스트 출현 — ${monster.name}${forced ? ' (관리자 소환)' : ''}${r.freezesXp ? ', XP 정지' : ''}` });
  return null;
}

// 모집 시간이 끝났을 때(타이머). 4명이 차서 이미 시작했으면 아무것도 하지 않는다.
async function onRecruitEnd(r) {
  if (raid !== r || r.phase !== 'recruit') return;
  if (r.party.length === 0) {
    await editRaidMessage(r, finishRaid(r, 'noshow'));
    return;
  }
  await editRaidMessage(r, startBattle(r));
}

function startBattle(r) {
  clearTimer(r);
  r.phase = 'battle';
  const now = Date.now();
  r.party.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)); // 화면에 역할 순서대로
  r.battle = createBattle(r.monster, r.party);
  r.battleEndsAt = now + BATTLE_LIMIT_MS;
  armTurnTimer(r);
  logSystem({ 유형: '레이드', 내용: `전투 시작 — ${r.party.map(p => `${p.name}(${ROLES[p.role].name})`).join(', ')} / HP ${r.battle.maxHp}` });
  return buildBattlePayload(r);
}

function armTurnTimer(r) {
  clearTimer(r);
  r.turnEndsAt = Math.min(Date.now() + TURN_MS, r.battleEndsAt);
  const turn = r.battle.turn;
  r.timer = setTimeout(async () => {
    if (raid !== r || r.phase !== 'battle' || r.battle.turn !== turn) return;
    const payload = advanceTurn(r);
    const ok = await editRaidMessage(r, payload);
    // 메시지가 지워졌으면 계속 돌릴 화면이 없으므로 도주 처리한다.
    if (!ok && raid === r) finishRaid(r, 'timeout');
  }, Math.max(0, r.turnEndsAt - Date.now()));
}

// 턴을 하나 진행하고 다음에 보여줄 화면을 돌려준다(전투가 끝났으면 결과 화면).
function advanceTurn(r) {
  clearTimer(r);
  const outcome = resolveTurn(r.battle);
  if (outcome) return finishRaid(r, outcome);
  if (Date.now() >= r.battleEndsAt) return finishRaid(r, 'timeout');
  armTurnTimer(r);
  return buildBattlePayload(r);
}

// 레이드를 끝내고 결과 화면을 돌려준다. XP 정지 해제 · 보상 지급 · 상태 저장 · 복구 안내까지 처리.
function finishRaid(r, outcome) {
  clearTimer(r);
  r.phase = 'ended';
  if (raid === r) raid = null;
  if (r.freezesXp) setRaidXpFrozen(false);
  state.active = null;
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
      const result = applyXp(r.guildId, mem.userId, xp, `긴급 퀘스트 토벌 '${r.monster.name}'${mem === mvp ? ' (MVP)' : ''}`);
      if (result.leveledUp) announceLevelUp(r.client, r.guildId, mem.userId, result.newLevel);
    }
  }

  logSystem({
    유형: '레이드',
    내용: `긴급 퀘스트 종료 — ${r.monster.name} / ${OUTCOME_TEXT[outcome].title}` +
      (r.battle ? ` / ${r.battle.turn}턴, 남은 HP ${r.battle.hp}/${r.battle.maxHp}` : '') +
      (rewards.length ? ` / 보상: ${rewards.map(x => `${userLabel(x.userId)} +${x.xp}`).join(', ')}` : ''),
  });

  // 복구 안내는 채널에 따로 한 줄 올린다 — 결과 화면은 위쪽 메시지라 묻혀 있을 수 있어서.
  if (r.freezesXp && r.message?.channel) {
    r.message.channel.send({ content: '🔧 **XP 시스템이 다시 작동합니다!**', allowedMentions: { parse: [] } }).catch(() => {});
  }
  return buildEndPayload(r, outcome, rewards);
}

// ── 버튼 ('raid:' 프리픽스) ─────────────────────────────────────
async function handleRaidButton(interaction) {
  const [, kind, arg] = interaction.customId.split(':');

  if (kind === 'help') {
    await interaction.reply({ content: buildHelpText(), flags: MessageFlags.Ephemeral });
    return;
  }

  const r = raid;
  if (!r || r.message?.id !== interaction.message.id) {
    await interaction.reply({ content: '⌛ 이미 끝난 긴급 퀘스트예요.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (kind === 'role' || kind === 'leave') {
    if (r.phase !== 'recruit') {
      await interaction.reply({ content: '⚔️ 이미 전투가 시작됐어요.', flags: MessageFlags.Ephemeral });
      return;
    }
    const userId = interaction.user.id;
    const mine = r.party.find(p => p.userId === userId);
    if (kind === 'leave') {
      if (!mine) {
        await interaction.reply({ content: '참가하지 않았어요.', flags: MessageFlags.Ephemeral });
        return;
      }
      r.party = r.party.filter(p => p.userId !== userId);
      await interaction.update(buildRecruitPayload(r));
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
    // 4명이 차면 모집 시간이 남아 있어도 바로 출발한다(같은 응답 안에서 전투 화면으로 바꾼다).
    await interaction.update(r.party.length >= PARTY_MAX ? startBattle(r) : buildRecruitPayload(r));
    return;
  }

  if (kind === 'act') {
    if (r.phase !== 'battle') {
      await interaction.reply({ content: '⏳ 아직 모집 중이에요.', flags: MessageFlags.Ephemeral });
      return;
    }
    const error = checkChoice(r.battle, interaction.user.id, arg);
    if (error) {
      await interaction.reply({ content: `⚠️ ${error}`, flags: MessageFlags.Ephemeral });
      return;
    }
    choose(r.battle, interaction.user.id, arg);
    // 마지막 사람이 고르면 이 응답 안에서 턴을 처리해 결과까지 바로 그린다.
    await interaction.update(allChosen(r.battle) ? advanceTurn(r) : buildBattlePayload(r));
  }
}

// ── 스케줄러 ────────────────────────────────────────────────────
async function recoverInterruptedRaid(client) {
  const active = state.active;
  if (!active) return;
  state.active = null;
  saveState(state);
  const channel = await client.channels.fetch(active.channelId).catch(() => null);
  const message = channel && await channel.messages.fetch(active.messageId).catch(() => null);
  if (!message) return;
  const ghost = { monster: MONSTERS[0], battle: null, freezesXp: false };
  await message.edit(buildEndPayload(ghost, 'restart')).catch(() => {});
}

async function spawnScheduled(client) {
  if (raid) return;
  const guild = client.guilds.cache.get(GUILD_ID);
  const channel = guild && await client.channels.fetch(PLAYGROUND_CHANNEL_ID).catch(() => null);
  scheduleNextSpawn(); // 성공 여부와 관계없이 다음 일정을 잡는다(실패한 출현을 1분마다 재시도하지 않게)
  if (!channel) {
    logError('레이드', '긴급 퀘스트 자동 출현 실패 — 놀이터 채널을 찾을 수 없음', null);
    return;
  }
  await spawnRaid(client, channel);
}

function startRaidScheduler(client) {
  recoverInterruptedRaid(client).catch(err => console.error('중단된 레이드 정리 실패:', err));
  if (!state.nextSpawnAt) scheduleNextSpawn();
  else if (Date.now() - state.nextSpawnAt > 60 * 60_000) rescheduleOverdue();
  setInterval(() => {
    if (raid || !state.nextSpawnAt || Date.now() < state.nextSpawnAt) return;
    spawnScheduled(client).catch(err => console.error('레이드 자동 출현 실패:', err));
  }, SCHEDULER_TICK_MS);
}

// ── 관리자(/xp → XP 관리)용 ─────────────────────────────────────
function getRaidStatus() {
  return {
    active: !!raid,
    phase: raid?.phase ?? null,
    monsterName: raid?.monster.name ?? null,
    nextSpawnAt: state.nextSpawnAt,
  };
}

// 본서버에서는 놀이터에, 그 외(테스트 서버)에서는 버튼을 누른 채널에 띄운다.
async function forceSpawnRaid(interaction) {
  const channel = interaction.guildId === GUILD_ID
    ? await interaction.client.channels.fetch(PLAYGROUND_CHANNEL_ID).catch(() => null)
    : interaction.channel;
  if (!channel) return '놀이터 채널을 찾을 수 없어요.';
  return spawnRaid(interaction.client, channel, { forced: true });
}

async function forceEndRaid() {
  const r = raid;
  if (!r) return false;
  await editRaidMessage(r, finishRaid(r, 'admin'));
  return true;
}

module.exports = {
  handleRaidButton,
  startRaidScheduler,
  getRaidStatus,
  forceSpawnRaid,
  forceEndRaid,
};
