// shared.js — 내전/모집/팀 핸들러가 공통으로 쓰는 상수·유틸·임베드 빌더
// 여러 파일에 흩어져 있던 동일 로직을 한 곳에 모아, 한쪽만 고치고
// 다른 쪽은 안 고쳐서 동작이 갈라지는 것을 방지합니다.

const { EmbedBuilder } = require('discord.js');

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
  return game === 'custom' ? `# ${title}` : `# ${gameInfo.emoji}  ${title}`;
}

const AUTO_CLOSE_DELAY_MS = 24 * 60 * 60 * 1000;

// 게시 24시간 후 자동으로 마감 처리한다. 그 사이 수동으로 마감/취소되면 조용히 넘어간다.
function scheduleAutoClose(matchesMap, msgId, onClose, delayMs = AUTO_CLOSE_DELAY_MS) {
  return setTimeout(async () => {
    const match = matchesMap.get(msgId);
    if (!match || match.closed) return;
    match.closed = true;
    try {
      await onClose(match);
    } catch (err) {
      console.error('자동 종료 처리 중 오류:', err);
    }
  }, delayMs);
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
  getResetDateStr,
  getNaejeonMatches,
  shuffleIntoTeams,
  buildTeamResultEmbed,
  titleHeader,
  scheduleAutoClose,
};
