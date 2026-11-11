const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { menu, notice } = require('../handlers/공통/카드');

// 안내 패널의 "불러오기" 버튼(index.js)에서도 재사용하기 위해 페이로드 생성 로직을 분리.
// naejeonMatches/mojipMatches가 길드별로 client에 실려있기 때문에 interaction이 필요하다.
function buildReloadListPayload(interaction) {
  const naejeons = interaction.client.naejeonMatches || new Map();
  const mojips   = interaction.client.mojipMatches   || new Map();

  const options = [];
  for (const [msgId, match] of naejeons) {
    if (match.guildId !== interaction.guildId) continue;
    options.push({
      label:       `[내전] ${match.data.title}`.slice(0, 100),
      description: `${match.data.organizer?.displayName ?? '?'} · ${match.data.datetime} · ${match.closed ? '🔒 마감됨' : '🟢 모집 중'}`.slice(0, 100),
      value:       `naejeon:${msgId}`,
    });
  }
  for (const [msgId, match] of mojips) {
    if (match.guildId !== interaction.guildId) continue;
    options.push({
      label:       `[모집] ${match.data.title}`.slice(0, 100),
      description: `${match.data.organizer?.displayName ?? '?'} · ${match.data.datetime} · ${match.closed ? '🔒 마감됨' : '🟢 모집 중'}`.slice(0, 100),
      value:       `mojip:${msgId}`,
    });
  }

  if (options.length === 0) {
    return notice('⚠️ **진행 중인 내전/모집이 없습니다.**', { ephemeral: true });
  }

  return menu({
    header: '🔎 불러오기',
    note: '채팅에 묻힌 내전/모집을 다시 끌어올립니다. 다시 게시할 항목을 선택하세요.',
    rows: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('reload:select')
          .setPlaceholder('내전 / 모집 선택...')
          .addOptions(options.slice(0, 25)),
      ),
    ],
    ephemeral: true,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('불러오기')
    .setDescription('진행 중인 내전 또는 모집 임베드를 다시 불러옵니다.'),

  async execute(interaction) {
    await interaction.reply(buildReloadListPayload(interaction));
  },

  buildReloadListPayload,
};
