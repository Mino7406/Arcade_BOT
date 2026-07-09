// shared.js — 내전/모집/팀 핸들러가 공통으로 쓰는 상수·유틸·임베드 빌더
// 여러 파일에 흩어져 있던 동일 로직을 한 곳에 모아, 한쪽만 고치고
// 다른 쪽은 안 고쳐서 동작이 갈라지는 것을 방지합니다.

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');

const ADMIN_IDS = ['457437911869161472', '1043750483522752512', '685917435601092643'];

// 임베드 오른쪽 상단에 표시할 썸네일. 게임별 아이콘이 assets 폴더에 있으면
// 그 게임 전용 이미지를, 없으면 공용 thumbnail.png를 사용합니다.
// 파일이 아예 없으면 조용히 생략됩니다.
const THUMBNAIL_DIR = path.join(__dirname, '..', 'assets');
const DEFAULT_THUMBNAIL_NAME = 'thumbnail.png';
const GAME_THUMBNAIL_NAMES = {
  lol: 'league_of_legends.png',
  valorant: 'valorant.png',
  overwatch: 'overwatch.png',
  pubg: 'pubg_helmet.png',
};

function resolveThumbnail(gameKey) {
  const name = GAME_THUMBNAIL_NAMES[gameKey] || DEFAULT_THUMBNAIL_NAME;
  const filePath = path.join(THUMBNAIL_DIR, name);
  return fs.existsSync(filePath) ? { name, filePath } : null;
}

function applyThumbnail(embed, gameKey) {
  const thumb = resolveThumbnail(gameKey);
  if (thumb) embed.setThumbnail(`attachment://${thumb.name}`);
  return embed;
}

function getThumbnailFiles(gameKey) {
  const thumb = resolveThumbnail(gameKey);
  return thumb ? [new AttachmentBuilder(thumb.filePath, { name: thumb.name })] : [];
}

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
    .setDescription(`# ${title} - 팀 배정\n${lines.join('\n')}`);
  applyThumbnail(embed, game);
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
  applyThumbnail,
  getThumbnailFiles,
};
