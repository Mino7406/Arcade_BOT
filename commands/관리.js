const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const ADMIN_ID = '457437911869161472';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('관리')
    .setDescription('[관리자 전용] 내전/모집을 관리합니다.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (interaction.user.id !== ADMIN_ID) {
      await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
      return;
    }

    const naejeons = interaction.client.naejeonMatches || new Map();
    const mojips   = interaction.client.mojipMatches   || new Map();

    const options = [];
    for (const [msgId, match] of naejeons) {
      options.push({
        label:       `[내전] ${match.data.title}`.slice(0, 100),
        description: `${match.data.datetime} | ${match.closed ? '🔒 마감' : '🟢 모집중'}`.slice(0, 100),
        value:       `naejeon:${msgId}`,
      });
    }
    for (const [msgId, match] of mojips) {
      options.push({
        label:       `[모집] ${match.data.title}`.slice(0, 100),
        description: `${match.data.datetime} | ${match.closed ? '🔒 마감' : '🟢 모집중'}`.slice(0, 100),
        value:       `mojip:${msgId}`,
      });
    }

    if (options.length === 0) {
      await interaction.reply({ content: '⚠️ **활성 내전/모집이 없습니다.**', ephemeral: true });
      return;
    }

    await interaction.reply({
      content: '🔧 **관리자 메뉴** — 삭제할 내전/모집을 선택하세요.',
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('admin:select')
            .setPlaceholder('내전 / 모집 선택...')
            .addOptions(options.slice(0, 25)),
        ),
      ],
      ephemeral: true,
    });
  },
};

// ── 셀렉트 메뉴 처리 ────────────────────────────────────────────
async function handleAdminSelect(interaction) {
  if (interaction.user.id !== ADMIN_ID) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
    return;
  }

  const value = interaction.values[0];
  const colonIdx = value.indexOf(':');
  const type  = value.slice(0, colonIdx);
  const msgId = value.slice(colonIdx + 1);

  const map   = type === 'naejeon'
    ? interaction.client.naejeonMatches
    : interaction.client.mojipMatches;
  const match = map?.get(msgId);

  if (!match) {
    await interaction.update({ content: '⚠️ **해당 내전/모집을 찾을 수 없습니다.**', components: [] });
    return;
  }

  const label = type === 'naejeon' ? '내전' : '모집';
  await interaction.update({
    content: `⚠️ **"${match.data.title}" ${label}을 삭제하시겠습니까?**\n메시지가 완전히 삭제되고 복구할 수 없습니다.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`admin:delete_confirm:${value}`)
          .setLabel('✅ 삭제 확정')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('admin:cancel')
          .setLabel('↩️ 취소')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

// ── 버튼 처리 ────────────────────────────────────────────────────
async function handleAdminButton(interaction) {
  if (interaction.user.id !== ADMIN_ID) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
    return;
  }

  const { customId } = interaction;

  if (customId === 'admin:cancel') {
    await interaction.update({ content: '취소되었습니다.', components: [] });
    return;
  }

  if (customId.startsWith('admin:delete_confirm:')) {
    const value    = customId.slice('admin:delete_confirm:'.length);
    const colonIdx = value.indexOf(':');
    const type     = value.slice(0, colonIdx);
    const msgId    = value.slice(colonIdx + 1);

    const map   = type === 'naejeon'
      ? interaction.client.naejeonMatches
      : interaction.client.mojipMatches;
    const match = map?.get(msgId);

    if (!match) {
      await interaction.update({ content: '⚠️ **이미 삭제된 내전/모집입니다.**', components: [] });
      return;
    }

    await match.message.delete().catch(() =>
      match.message.edit({ content: '', embeds: [], components: [] }),
    );
    map.delete(msgId);
    await interaction.update({ content: '✅ **삭제되었습니다.**', components: [] });
  }
}

module.exports.handleAdminSelect = handleAdminSelect;
module.exports.handleAdminButton = handleAdminButton;
