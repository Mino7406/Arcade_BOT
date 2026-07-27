// shared.js — 내전/모집/팀 핸들러가 공통으로 쓰는 상수·유틸·임베드 빌더
// 여러 파일에 흩어져 있던 동일 로직을 한 곳에 모아, 한쪽만 고치고
// 다른 쪽은 안 고쳐서 동작이 갈라지는 것을 방지합니다.

const { EmbedBuilder } = require('discord.js');
const { awardMatchCompletionXp, XP_CHANNEL_ID } = require('./levels');

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

const AUTO_CLOSE_DELAY_MS = 24 * 60 * 60 * 1000;

function clearAutoEndTimer(match) {
  if (match._autoEndTimer) {
    clearTimeout(match._autoEndTimer);
    match._autoEndTimer = null;
  }
}

// 마감(closed)된 시점부터 delayMs(기본 24시간) 후 자동으로 "종료" 처리를 예약한다.
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

// 마감(🔒 마감됨) 상태로 전환하면서 24시간 자동 종료 타이머를 건다.
function markClosed(matchesMap, msgId, match, label) {
  match.closed = true;
  match.closedAt = Date.now();
  armAutoEnd(matchesMap, msgId, match, label);
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
// /관리 의 수동 종료와 24시간 자동 종료가 동일한 결과를 내도록 공유한다.
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
  const channel = client.channels.cache.get(XP_CHANNEL_ID) || await client.channels.fetch(XP_CHANNEL_ID).catch(() => null);
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

module.exports = {
  ADMIN_IDS,
  AUTO_CLOSE_DELAY_MS,
  getResetDateStr,
  getNaejeonMatches,
  shuffleIntoTeams,
  buildTeamResultEmbed,
  titleHeader,
  armAutoEnd,
  disarmAutoEnd,
  markClosed,
  markReopened,
  buildEndedEmbed,
  endMatch,
  announceMatchCompletionXp,
};
