const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { ADMIN_IDS, endMatch, announceMatchCompletionXp, deleteMentionMessage } = require('../handlers/공용');

// 메시지 ID 또는 디스코드 메시지 링크에서 { channelId, messageId }를 추출한다.
// channelId가 없으면(순수 ID만 입력) 명령어를 실행한 현재 채널을 사용한다.
function parseMessageRef(input) {
  const linkMatch = input.match(/channels\/\d+\/(\d+)\/(\d+)/);
  if (linkMatch) return { channelId: linkMatch[1], messageId: linkMatch[2] };
  if (/^\d{17,20}$/.test(input)) return { channelId: null, messageId: input };
  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('관리')
    .setDescription('[관리자 전용] 내전/모집을 관리하거나 봇 메시지를 삭제합니다.')
    .addStringOption(opt =>
      opt.setName('메시지삭제')
        .setDescription('삭제할 봇 메시지의 ID 또는 링크 (입력 시 바로 삭제, 비우면 내전/모집 관리 메뉴)')
        .setRequired(false),
    ),

  async execute(interaction) {
    if (!ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
      return;
    }

    const messageInput = interaction.options.getString('메시지삭제');
    if (messageInput) {
      const ref = parseMessageRef(messageInput.trim());
      if (!ref) {
        await interaction.reply({ content: '⚠️ **올바른 메시지 ID 또는 링크가 아닙니다.**', ephemeral: true });
        return;
      }

      const channel = ref.channelId
        ? await interaction.client.channels.fetch(ref.channelId).catch(() => null)
        : interaction.channel;
      const message = channel ? await channel.messages.fetch(ref.messageId).catch(() => null) : null;

      if (!message) {
        await interaction.reply({ content: '⚠️ **메시지를 찾을 수 없습니다.**', ephemeral: true });
        return;
      }
      if (message.author.id !== interaction.client.user.id) {
        await interaction.reply({ content: '⚠️ **봇이 보낸 메시지만 삭제할 수 있습니다.**', ephemeral: true });
        return;
      }

      await message.delete();
      await interaction.reply({ content: '✅ **메시지를 삭제했습니다.**', ephemeral: true });
      return;
    }

    const naejeons = interaction.client.naejeonMatches || new Map();
    const mojips   = interaction.client.mojipMatches   || new Map();

    const options = [];
    for (const [msgId, match] of naejeons) {
      if (match.guildId !== interaction.guildId) continue;
      options.push({
        label:       `[내전] ${match.data.title}`.slice(0, 100),
        description: `${match.data.organizer?.displayName ?? '?'} · ${match.data.datetime} · ${match.closed ? '🔒 마감됨' : '🟢 모집중'}`.slice(0, 100),
        value:       `naejeon:${msgId}`,
      });
    }
    for (const [msgId, match] of mojips) {
      if (match.guildId !== interaction.guildId) continue;
      options.push({
        label:       `[모집] ${match.data.title}`.slice(0, 100),
        description: `${match.data.organizer?.displayName ?? '?'} · ${match.data.datetime} · ${match.closed ? '🔒 마감됨' : '🟢 모집중'}`.slice(0, 100),
        value:       `mojip:${msgId}`,
      });
    }

    if (options.length === 0) {
      await interaction.reply({ content: '⚠️ **활성된 내전/모집이 없습니다.**', ephemeral: true });
      return;
    }

    await interaction.reply({
      content: '🔧 **관리자 메뉴** — 관리할 내전/모집을 선택하세요.',
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
  if (!ADMIN_IDS.includes(interaction.user.id)) {
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

  if (!match || match.guildId !== interaction.guildId) {
    await interaction.update({ content: '⚠️ **해당 내전/모집을 찾을 수 없습니다.**', components: [] });
    return;
  }

  const label = type === 'naejeon' ? '내전' : '모집';
  await interaction.update({
    content: `⚠️ **"${match.data.title}" ${label}을 어떻게 처리하시겠습니까?**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`admin:end_confirm:${value}`)
          .setLabel('⌛ 종료')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`admin:end_delete:${value}`)
          .setLabel('🗑️ 삭제')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
}

// ── 버튼 처리 ────────────────────────────────────────────────────
async function handleAdminButton(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
    return;
  }

  const { customId } = interaction;

  if (customId.startsWith('admin:end_delete:')) {
    const value    = customId.slice('admin:end_delete:'.length);
    const colonIdx = value.indexOf(':');
    const type     = value.slice(0, colonIdx);
    const msgId    = value.slice(colonIdx + 1);

    const map   = type === 'naejeon'
      ? interaction.client.naejeonMatches
      : interaction.client.mojipMatches;
    const match = map?.get(msgId);

    if (!match || match.guildId !== interaction.guildId) {
      await interaction.update({ content: '⚠️ **이미 종료된 내전/모집입니다.**', components: [] });
      return;
    }

    await announceMatchCompletionXp(match);
    map.delete(msgId);
    await deleteMentionMessage(interaction.client, match);
    await match.message.delete();
    await interaction.update({ content: '✅ **종료 처리 후 삭제되었습니다.**', components: [] });
    return;
  }

  if (customId.startsWith('admin:end_confirm:')) {
    const value    = customId.slice('admin:end_confirm:'.length);
    const colonIdx = value.indexOf(':');
    const type     = value.slice(0, colonIdx);
    const msgId    = value.slice(colonIdx + 1);

    const map   = type === 'naejeon'
      ? interaction.client.naejeonMatches
      : interaction.client.mojipMatches;
    const match = map?.get(msgId);

    if (!match || match.guildId !== interaction.guildId) {
      await interaction.update({ content: '⚠️ **이미 종료된 내전/모집입니다.**', components: [] });
      return;
    }

    const label = type === 'naejeon' ? '내전' : '모집';
    await endMatch(map, msgId, match, label);
    await interaction.update({ content: '✅ **종료 처리되었습니다.**', components: [] });
  }
}

module.exports.handleAdminSelect = handleAdminSelect;
module.exports.handleAdminButton = handleAdminButton;
