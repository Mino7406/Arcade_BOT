// shared.js — 내전/모집/팀 핸들러가 공통으로 쓰는 상수·유틸·임베드 빌더
// 여러 파일에 흩어져 있던 동일 로직을 한 곳에 모아, 한쪽만 고치고
// 다른 쪽은 안 고쳐서 동작이 갈라지는 것을 방지합니다.

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { awardMatchCompletionXp, LEVEL_UP_ANNOUNCE_CHANNEL_ID } = require('./levels');

// 내전(naejeon)/모집(mojip) 두 시스템이 공유하는 게임 → 역할 이름 매핑.
// (역할 멘션 대상 채널이 있으면 해당 역할을 핑한다.)
const ROLE_NAMES = {
  lol: '롤', valorant: '발로란트', overwatch: '오버워치', pubg: '배그',
};

const ADMIN_IDS = ['457437911869161472', '1043750483522752512', '685917435601092643'];

function getResetDateStr(client, label = '내전') {
  const startedAt = client.startedAt;
  if (!startedAt) return `봇 재시작 후 생성된 ${label}만 표시됩니다`;
  const kst = new Date(startedAt.getTime() + 9 * 60 * 60 * 1000);
  const MM = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const DD = String(kst.getUTCDate()).padStart(2, '0');
  const HH = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `※ ${MM}.${DD} ${HH}:${mm}에 초기화 됨`;
}

function getNaejeonMatches(client) {
  if (!client.naejeonMatches) client.naejeonMatches = new Map();
  return client.naejeonMatches;
}

function shuffleIntoTeams(participants) {
  const shuffled = [...participants];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const half = Math.ceil(shuffled.length / 2);
  return { team1: shuffled.slice(0, half), team2: shuffled.slice(half) };
}

// 직접 입력(custom)일 때는 제목에 게임 아이콘을 붙이지 않는다.
function titleHeader(game, gameInfo, title) {
  return game === 'custom' ? `## ${title}` : `## ${gameInfo.emoji}  ${title}`;
}

const AUTO_CLOSE_DELAY_MS = 8 * 60 * 60 * 1000;

function clearAutoEndTimer(match) {
  if (match._autoEndTimer) {
    clearTimeout(match._autoEndTimer);
    match._autoEndTimer = null;
  }
}

// 마감(closed)된 시점부터 delayMs(기본 8시간) 후 자동으로 "종료" 처리를 예약한다.
// autoClose 옵션이 꺼져있으면 아무것도 하지 않는다. 봇 재시작 후 복원할 때는
// 이미 지난 시간만큼 뺀 delayMs를 넘겨 원래 마감 시각 기준을 유지한다.
function armAutoEnd(matchesMap, msgId, match, label, delayMs = AUTO_CLOSE_DELAY_MS) {
  clearAutoEndTimer(match);
  if (!match.data?.autoClose) return;
  match._autoEndTimer = setTimeout(async () => {
    match._autoEndTimer = null;
    const current = matchesMap.get(msgId);
    if (!current || !current.closed) return;
    try {
      await announceMatchCompletionXp(current);
      await endMatch(matchesMap, msgId, current, label);
    } catch (err) {
      console.error('자동 종료 처리 중 오류:', err);
    }
  }, delayMs);
}

// 마감이 해제될 때 예약된 자동 종료 타이머를 취소한다.
function disarmAutoEnd(match) {
  clearAutoEndTimer(match);
  match.closedAt = null;
}

// 마감 시 주최자에게 DM으로 알린다. 인원 초과/미달과 무관하게 markClosed를
// 거치는 모든 경로(정원 자동 마감, 주최자 수동 마감, 강제 추가로 인한 마감)에 공통 적용.
// DM 차단 등으로 실패해도 마감 처리 자체에는 영향을 주지 않는다.
async function notifyOrganizerOnClose(match, label) {
  const organizer = match?.data?.organizer;
  const client = match?.message?.client;
  if (!organizer?.id || !client) return;
  try {
    const user = await client.users.fetch(organizer.id);
    const { title, gameInfo } = match.data;
    const embed = new EmbedBuilder()
      .setColor(gameInfo?.color ?? 0x5865F2)
      .setTitle('🔒 마감 알림')
      .setDescription(`**${title}** ${label}이 방금 마감됐어요!`)
      .addFields({ name: '🔗 바로가기', value: `[${label} 게시글 확인하기](${match.message.url})` })
      .setTimestamp();
    await user.send({ embeds: [embed] });
  } catch (err) {
    console.error(`${label} 마감 DM 전송 실패:`, err);
  }
}

// 마감(🔒 마감됨) 상태로 전환하면서 8시간 자동 종료 타이머를 건다.
// notify=false를 넘기면 주최자 DM을 보내지 않는다 — 주최자 본인이 직접
// "마감하기" 버튼을 눌러 마감한 경우(이미 알고 있으므로 불필요)에 사용.
function markClosed(matchesMap, msgId, match, label, notify = true) {
  match.closed = true;
  match.closedAt = Date.now();
  armAutoEnd(matchesMap, msgId, match, label);
  if (notify) notifyOrganizerOnClose(match, label).catch(() => {});
}

// 마감 해제(🔓) 상태로 전환하면서 예약돼 있던 자동 종료 타이머를 취소한다.
function markReopened(match) {
  match.closed = false;
  disarmAutoEnd(match);
}

// /관리 의 "⌛ 종료"와 동일한 회색 "종료됨" 임베드를 만든다.
function buildEndedEmbed(match, label) {
  const { game, gameInfo, title, datetime, organizer, description } = match.data;
  const max = parseInt(match.data.players) || 0;
  const participantText = match.participants.length > 0
    ? `\`\`\`\n${match.participants.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n')}\n\`\`\``
    : '*참가자가 없습니다.*';

  const embed = new EmbedBuilder()
    .setColor(0x808080)
    .setDescription([
      titleHeader(game, gameInfo, title),
      `🎮 **게임**　　${gameInfo.name}`,
      `📅 **일시**　　${datetime}`,
      `👑 **주최자**　**\`${organizer.displayName}\`**`,
      `📊 **상태**　　⚫ 종료됨`,
    ].join('\n'));

  if (description) embed.addFields({ name: '📝 메모', value: description });

  return embed
    .addFields({ name: `👥 참가자  ${match.participants.length} / ${max}명`, value: participantText })
    .setFooter({ text: `⌛ ${label}이 종료되었습니다.` })
    .setTimestamp();
}

// 매치를 "종료됨" 상태로 만든다: 임베드/버튼을 종료 화면으로 교체하고 관리 목록에서 제거한다.
// /관리 의 수동 종료와 8시간 자동 종료가 동일한 결과를 내도록 공유한다.
async function endMatch(matchesMap, msgId, match, label) {
  clearAutoEndTimer(match);
  match.closed = true;
  match.closedAt = null;
  await match.message.edit({
    content: '',
    embeds: [buildEndedEmbed(match, label)],
    components: [],
    attachments: [],
    allowedMentions: { parse: [] },
  });
  matchesMap.delete(msgId);
}

// 내전/모집이 마감될 때마다 호출. 보너스 XP 지급 후 레벨업한 사람이 있으면 XP 채널에 알린다.
async function announceMatchCompletionXp(match) {
  const leveledUp = awardMatchCompletionXp(match);
  if (leveledUp.length === 0) return;
  const client = match?.message?.client;
  if (!client) return;
  const channel = client.channels.cache.get(LEVEL_UP_ANNOUNCE_CHANNEL_ID) || await client.channels.fetch(LEVEL_UP_ANNOUNCE_CHANNEL_ID).catch(() => null);
  if (!channel) return;
  for (const { userId, newLevel } of leveledUp) {
    await channel.send({
      content: `<@${userId}>님이 ${newLevel}레벨을 달성했어요. 🎉`,
      allowedMentions: { users: [userId] },
    }).catch(() => {});
  }
}

function buildTeamResultEmbed(data, teams) {
  const { game, gameInfo, title, datetime, organizer } = data;
  const lines = [
    `🎮 **게임**　　${gameInfo.name}`,
    `📅 **일시**　　${datetime}`,
    `👑 **주최자**　**\`${organizer.displayName}\`**`,
    `📊 **상태**　　🔒 마감됨`,
  ];
  const embed = new EmbedBuilder()
    .setColor(gameInfo.color)
    .setDescription(`${titleHeader(game, gameInfo, title)} - 팀 배정\n${lines.join('\n')}`);
  return embed
    .addFields(
      {
        name: `🔵 팀 1 - ${teams.team1.length}명`,
        value: teams.team1.length > 0 ? `\`\`\`\n${teams.team1.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n')}\n\`\`\`` : '없음',
        inline: true,
      },
      {
        name: `🔴 팀 2 - ${teams.team2.length}명`,
        value: teams.team2.length > 0 ? `\`\`\`\n${teams.team2.map((u, i) => `${i + 1}. ${u.displayName}`).join('\n')}\n\`\`\`` : '없음',
        inline: true,
      },
    )
    .setFooter({ text: '✅ 팀이 배정되었습니다.' })
    .setTimestamp();
}

// ─── 내전(naejeon) / 모집(mojip) 공통 빌더 ──────────────────────
// 두 시스템의 UI가 customId 접두사(type: 'naejeon' | 'mojip')와
// 라벨 문구(label: '내전' | '모집')만 다르고 로직은 완전히 동일한
// 부분만 여기로 모았다. 팀 배정/역할 멘션 유지처럼 실제 동작이
// 다른 부분(buildPublicEmbed 등)은 각 핸들러 파일에 그대로 둔다.

function buildPreviewEmbed({ game, gameInfo, title, datetime, players, description, organizer }) {
  const max = parseInt(players) || 0;

  const lines = [
    `🎮 **게임**　　${gameInfo.name}`,
    `📅 **일시**　　${datetime}`,
    `👑 **주최자**　**\`${organizer.displayName}\`**`,
    `📊 **상태**　　⏳ 게시 전`,
  ];

  const embed = new EmbedBuilder()
    .setColor(gameInfo.color)
    .setDescription(`${titleHeader(game, gameInfo, title)}\n${lines.join('\n')}`);

  if (description) embed.addFields({ name: '📝 메모', value: description });

  return embed
    .addFields({ name: `👥 참가자  0 / ${max}명`, value: '*아직 참가자가 없습니다.*' })
    .setFooter({ text: '🔎 게시하기 전에 내용을 다시 확인해 주세요.' })
    .setTimestamp();
}

function buildModal(type, label, GAMES, game, data = {}) {
  const gameInfo = GAMES[game];
  const isCustom = game === 'custom';

  const modal = new ModalBuilder()
    .setCustomId(`${type}:modal:${game}`)
    .setTitle(`${gameInfo.emoji} ${gameInfo.name} ${label} 생성`);

  const titleInput = new TextInputBuilder()
    .setCustomId('title')
    .setLabel('제목 (비워두면 기본값 사용)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(isCustom ? `${label} 제목을 입력하세요 (선택사항)` : `${gameInfo.name} ${label}`)
    .setRequired(false)
    .setMaxLength(50);

  const datetimeInput = new TextInputBuilder()
    .setCustomId('datetime')
    .setLabel('일시')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('예: 6월 5일 오후 8시')
    .setRequired(true)
    .setMaxLength(50);

  const playersInput = new TextInputBuilder()
    .setCustomId('players')
    .setLabel(type === 'naejeon' ? '모집 인원 (명)' : '모집 인원 (숫자만 입력)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('예: 10')
    .setRequired(true)
    .setMaxLength(10);

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel('메모 / 설명 (선택사항)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('추가 안내사항이 있으면 입력하세요.')
    .setRequired(false)
    .setMaxLength(300);

  if (data.title)       titleInput.setValue(data.title);
  if (data.datetime)    datetimeInput.setValue(data.datetime);
  if (data.players)     playersInput.setValue(data.players);
  else if (gameInfo.defaultPlayers) playersInput.setValue(String(gameInfo.defaultPlayers));
  if (data.description) descInput.setValue(data.description);

  if (isCustom) {
    const gameNameInput = new TextInputBuilder()
      .setCustomId('game_name')
      .setLabel('게임 이름')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('예: 마인크래프트, 철권 8 ...')
      .setRequired(true)
      .setMaxLength(50);
    if (data.gameInfo && data.gameInfo.name !== '직접 입력') {
      gameNameInput.setValue(data.gameInfo.name);
    }
    modal.addComponents(
      new ActionRowBuilder().addComponents(gameNameInput),
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(datetimeInput),
      new ActionRowBuilder().addComponents(playersInput),
      new ActionRowBuilder().addComponents(descInput),
    );
  } else {
    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(datetimeInput),
      new ActionRowBuilder().addComponents(playersInput),
      new ActionRowBuilder().addComponents(descInput),
    );
  }

  return modal;
}

function buildLeaveButton(type, msgId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${type}:leave:${msgId}`)
      .setLabel('❌ 참가 취소')
      .setStyle(ButtonStyle.Danger),
  );
}

function buildPreviewComponents(type, data = null) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${type}:publish`).setLabel('📢 채널에 공개 게시').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${type}:edit`).setLabel('✏️ 수정').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${type}:cancel`).setLabel('❌ 취소').setStyle(ButtonStyle.Danger),
  );
  const autoCloseToggle = new ButtonBuilder()
    .setCustomId(`${type}:toggle_autoclose`)
    .setEmoji('⏰')
    .setLabel(data && data.autoClose ? '자동 종료: ON' : '자동 종료: OFF')
    .setStyle(data && data.autoClose ? ButtonStyle.Success : ButtonStyle.Secondary);

  if (data && data.game === 'custom') {
    const steamToggle = new ButtonBuilder()
      .setCustomId(`${type}:toggle_steam`)
      .setEmoji({ id: '1510954746012242021', name: 'Steam' })
      .setLabel(data.mentionSteam ? '멘션 ON' : '멘션 OFF')
      .setStyle(data.mentionSteam ? ButtonStyle.Success : ButtonStyle.Secondary);
    return [row1, new ActionRowBuilder().addComponents(autoCloseToggle, steamToggle)];
  }
  return [row1, new ActionRowBuilder().addComponents(autoCloseToggle)];
}

function buildCancelComponents(type) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${type}:cancel_confirm`).setLabel('✅ 확인').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${type}:cancel_back`).setLabel('↩️ 돌아가기').setStyle(ButtonStyle.Secondary),
  );
}

module.exports = {
  ADMIN_IDS,
  AUTO_CLOSE_DELAY_MS,
  ROLE_NAMES,
  getResetDateStr,
  getNaejeonMatches,
  shuffleIntoTeams,
  buildTeamResultEmbed,
  buildPreviewEmbed,
  buildModal,
  buildLeaveButton,
  buildPreviewComponents,
  buildCancelComponents,
  titleHeader,
  armAutoEnd,
  disarmAutoEnd,
  markClosed,
  markReopened,
  buildEndedEmbed,
  endMatch,
  announceMatchCompletionXp,
};
