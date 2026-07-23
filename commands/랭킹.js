const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getLeaderboard, buildProgressBar } = require('../handlers/levels');

const DESCRIPTION_LIMIT = 4096; // Discord 임베드 description 최대 길이
const HEADER = '## 🏆 서버 랭킹\n\n';
const TRUNCATE_NOTICE = '\n\n*(목록이 길어 일부 순위는 생략되었습니다)*';
const MEDALS = ['🥇', '🥈', '🥉'];
const BAR_LENGTH = 10;

function formatEntry(entry, name) {
  const medal = MEDALS[entry.rank - 1];
  const rankText = medal ? `${medal} **${entry.rank}위**` : `**${entry.rank}위**`;
  const bar = buildProgressBar(entry.currentLevelXp, entry.neededXp, BAR_LENGTH);
  return `> ${rankText} · **${name}**\n> -# Lv.${entry.level} ・ ${bar} ・ ${entry.xp} XP`;
}

// 인용구(>) 줄 사이에 빈 줄을 넣어야 하나로 이어붙지 않고 유저마다 별도 블록으로 보인다.
// 목록이 길어져도 Discord embed description 한도(4096자)를 넘지 않도록 안전하게 자른다.
function buildDescription(lines) {
  const full = HEADER + lines.join('\n\n');
  if (full.length <= DESCRIPTION_LIMIT) return full;

  const budget = DESCRIPTION_LIMIT - HEADER.length - TRUNCATE_NOTICE.length;
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const add = kept.length === 0 ? line.length : line.length + 2; // '\n\n' 구분자 포함
    if (used + add > budget) break;
    kept.push(line);
    used += add;
  }
  return HEADER + kept.join('\n\n') + TRUNCATE_NOTICE;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('랭킹')
    .setDescription('서버 레벨 순위표를 확인합니다.'),

  async execute(interaction) {
    const top = getLeaderboard(interaction.guildId, 10);
    if (top.length === 0) {
      await interaction.reply({ content: '📭 **아직 레벨 기록이 없습니다.**', ephemeral: true });
      return;
    }

    const lines = await Promise.all(top.map(async (entry) => {
      const member = await interaction.guild.members.fetch(entry.userId).catch(() => null);
      const name = member?.displayName || `알 수 없는 사용자 (${entry.userId})`;
      return formatEntry(entry, name);
    }));

    const embed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setDescription(buildDescription(lines))
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
