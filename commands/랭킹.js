const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getLeaderboard, getLeaderboardSize, buildProgressBar } = require('../handlers/levels');

const PAGE_SIZE = 5;
const DESCRIPTION_LIMIT = 4096; // Discord 임베드 description 최대 길이
const HEADER = '## 🏆 서버 랭킹\n\n';
const TRUNCATE_NOTICE = '\n\n*(목록이 길어 일부 순위는 생략되었습니다)*';
const MEDALS = ['🥇', '🥈', '🥉'];
const BAR_LENGTH = 10;

function formatEntry(entry, name) {
  const medal = MEDALS[entry.rank - 1];
  const rankText = medal ? `${medal} **${entry.rank}위**` : `**${entry.rank}위**`;
  const bar = buildProgressBar(entry.currentLevelXp, entry.neededXp, BAR_LENGTH);
  return `> ${rankText} · **${name}**\n> -# Lv.${entry.level} ・ \`${bar}\` ・ ${entry.xp} XP`;
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

// includeShare: false면 공유하기 버튼을 뺀다 (이미 공개된 메시지에는 다시 공유할 이유가 없음).
function buildComponents(page, totalPages, includeShare = true) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`ranking:page:${page - 1}`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`ranking:page:${page + 1}`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
  ];
  if (includeShare) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`ranking:share:${page}`)
        .setLabel('📤 공유하기')
        .setStyle(ButtonStyle.Primary),
    );
  }
  return [new ActionRowBuilder().addComponents(...buttons)];
}

// 반환값이 null이면 랭킹 기록이 없다는 뜻 (호출부에서 안내 메시지를 대신 보낸다).
async function buildRankingView(guild, page, includeShare = true) {
  const total = getLeaderboardSize(guild.id);
  if (total === 0) return null;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const offset = (clampedPage - 1) * PAGE_SIZE;
  const entries = getLeaderboard(guild.id, PAGE_SIZE, offset);

  // 유저마다 따로 fetch하면 페이지당 여러 번 API를 왕복해 느려지므로, ID를 한 번에 묶어서 조회한다.
  const members = entries.length > 0
    ? await guild.members.fetch({ user: entries.map(e => e.userId) }).catch(() => new Map())
    : new Map();

  const lines = entries.map((entry) => {
    const member = members.get(entry.userId);
    const name = member?.displayName || `알 수 없는 사용자 (${entry.userId})`;
    return formatEntry(entry, name);
  });

  const embed = new EmbedBuilder()
    .setColor(0xFEE75C)
    .setDescription(buildDescription(lines))
    .setFooter({ text: `${clampedPage} / ${totalPages} 페이지` })
    .setTimestamp();

  return { embed, components: buildComponents(clampedPage, totalPages, includeShare) };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('랭킹')
    .setDescription('서버 레벨 순위표를 확인합니다.'),

  async execute(interaction) {
    const view = await buildRankingView(interaction.guild, 1);
    if (!view) {
      await interaction.reply({ content: '📭 **아직 레벨 기록이 없습니다.**', ephemeral: true });
      return;
    }

    await interaction.reply({ embeds: [view.embed], components: view.components, ephemeral: true });
  },
};

// ── 페이지 이동 버튼 처리 ────────────────────────────────────────
// 3초 인터랙션 응답 제한을 넘기지 않도록, 멤버 조회 등 오래 걸릴 수 있는 작업 전에 먼저 ack한다.
async function handleRankingPageButton(interaction) {
  await interaction.deferUpdate();
  const page = parseInt(interaction.customId.slice('ranking:page:'.length), 10) || 1;
  const view = await buildRankingView(interaction.guild, page);
  if (!view) {
    await interaction.editReply({ content: '📭 **아직 레벨 기록이 없습니다.**', embeds: [], components: [] });
    return;
  }

  await interaction.editReply({ embeds: [view.embed], components: view.components });
}

// ── 공유하기 버튼 처리 ──────────────────────────────────────────
// 채널에 공개로 올리는 메시지에도 페이지 이동 버튼을 그대로 붙여서 넘겨보게 하고,
// 원래 나에게만 보이던 비공개 메시지는 공유하는 즉시 닫는다.
async function handleRankingShareButton(interaction) {
  await interaction.deferUpdate();
  const page = parseInt(interaction.customId.slice('ranking:share:'.length), 10) || 1;
  const view = await buildRankingView(interaction.guild, page, false);
  if (!view) {
    await interaction.editReply({ content: '📭 **아직 레벨 기록이 없습니다.**', embeds: [], components: [] });
    return;
  }

  await interaction.channel.send({ embeds: [view.embed], components: view.components });
  await interaction.deleteReply();
}

module.exports.handleRankingPageButton = handleRankingPageButton;
module.exports.handleRankingShareButton = handleRankingShareButton;
