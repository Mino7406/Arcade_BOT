const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { buildPublicMessagePayload } = require('./naejeon');
const { buildMojipMessagePayload } = require('./mojip');

async function handleRButton(interaction) {
  const { customId } = interaction;

  if (customId === '불러오기:type:naejeon') {
    const matches = interaction.client.naejeonMatches;
    if (!matches || matches.size === 0) {
      await interaction.update({ content: '⚠️ **현재 진행 중인 내전이 없습니다.**', components: [] });
      return;
    }
    const options = [...matches.entries()].map(([id, m]) => {
      const emojiStr = m.data.gameInfo.emoji;
      const cm = emojiStr.match(/^<a?:(\w+):(\d+)>$/);
      const emoji = cm ? { id: cm[2], name: cm[1] } : emojiStr;
      return {
        label: m.data.title.slice(0, 100),
        description: `${m.data.organizer.displayName} · 참가자 ${m.participants.length}명 · ${m.data.datetime}`.slice(0, 100),
        value: id,
        emoji,
      };
    });
    const sel = new StringSelectMenuBuilder()
      .setCustomId('불러오기:naejeon_select')
      .setPlaceholder('내전을 선택하세요')
      .addOptions(options);
    await interaction.update({
      content: '🔎 **내전 임베드 불러오기** - 불러올 내전을 선택하세요.',
      components: [new ActionRowBuilder().addComponents(sel)],
    });
    return;
  }

  if (customId === '불러오기:type:mojip') {
    const matches = interaction.client.mojipMatches;
    if (!matches || matches.size === 0) {
      await interaction.update({ content: '⚠️ **현재 진행 중인 모집이 없습니다.**', components: [] });
      return;
    }
    const options = [...matches.entries()].map(([id, m]) => {
      const emojiStr = m.data.gameInfo.emoji;
      const cm = emojiStr.match(/^<a?:(\w+):(\d+)>$/);
      const emoji = cm ? { id: cm[2], name: cm[1] } : emojiStr;
      return {
        label: m.data.title.slice(0, 100),
        description: `${m.data.organizer.displayName} · 참가자 ${m.participants.length}명 · ${m.data.datetime}`.slice(0, 100),
        value: id,
        emoji,
      };
    });
    const sel = new StringSelectMenuBuilder()
      .setCustomId('불러오기:mojip_select')
      .setPlaceholder('모집을 선택하세요')
      .addOptions(options);
    await interaction.update({
      content: '🔎 **모집 임베드 불러오기** - 불러올 모집을 선택하세요.',
      components: [new ActionRowBuilder().addComponents(sel)],
    });
    return;
  }
}

async function handleRMatchSelect(interaction) {
  const { customId } = interaction;

  if (customId === '불러오기:naejeon_select') {
    const matchMsgId = interaction.values[0];
    const matches = interaction.client.naejeonMatches;
    const match = matches && matches.get(matchMsgId);
    if (!match) {
      await interaction.update({ content: '⚠️ **만료된 내전입니다.**', embeds: [], components: [] });
      return;
    }
    const payload = buildPublicMessagePayload(match);
    const newMsg = await interaction.channel.send({ ...payload, content: '' });
    match.message.edit({ components: [] }).catch(() => {});
    match.roleContent = '';
    matches.delete(matchMsgId);
    match.message = newMsg;
    matches.set(newMsg.id, match);
    await interaction.update({ content: '✅ **내전 임베드가 다시 게시되었습니다.**', embeds: [], components: [] });
    return;
  }

  if (customId === '불러오기:mojip_select') {
    const msgId = interaction.values[0];
    const matches = interaction.client.mojipMatches;
    const match = matches && matches.get(msgId);
    if (!match) {
      await interaction.update({ content: '⚠️ **만료된 모집입니다.**', embeds: [], components: [] });
      return;
    }
    const payload = buildMojipMessagePayload(match);
    const newMsg = await interaction.channel.send({ ...payload, content: '' });
    match.message.edit({ components: [] }).catch(() => {});
    matches.delete(msgId);
    match.message = newMsg;
    matches.set(newMsg.id, match);
    await interaction.update({ content: '✅ **모집 임베드가 다시 게시되었습니다.**', embeds: [], components: [] });
    return;
  }
}

module.exports = { handleRButton, handleRMatchSelect };
