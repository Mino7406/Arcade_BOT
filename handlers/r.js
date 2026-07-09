const { buildPublicMessagePayload } = require('./naejeon');
const { buildMojipMessagePayload } = require('./mojip');

async function handleRMatchSelect(interaction) {
  const value = interaction.values[0];
  const colonIdx = value.indexOf(':');
  const type  = value.slice(0, colonIdx);
  const msgId = value.slice(colonIdx + 1);
  const label = type === 'naejeon' ? '내전' : '모집';

  const matches = type === 'naejeon' ? interaction.client.naejeonMatches : interaction.client.mojipMatches;
  const match = matches && matches.get(msgId);
  if (!match || match.guildId !== interaction.guildId) {
    await interaction.update({ content: `⚠️ **만료된 ${label}입니다.**`, embeds: [], components: [] });
    return;
  }

  const payload = type === 'naejeon' ? buildPublicMessagePayload(match) : buildMojipMessagePayload(match);
  const newMsg = await interaction.channel.send({ ...payload, content: '' });
  match.message.delete().catch(() => {});
  if (type === 'naejeon') match.roleContent = '';
  matches.delete(msgId);
  match.message = newMsg;
  matches.set(newMsg.id, match);
  await interaction.update({ content: `✅ **${label} 임베드가 다시 게시되었습니다.**`, embeds: [], components: [] });
}

module.exports = { handleRMatchSelect };
