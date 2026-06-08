const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { buildPublicMessagePayload } = require('./naejeon');

async function handleRMatchSelect(interaction) {
  const matchMsgId = interaction.values[0];
  const matches = interaction.client.naejeonMatches;
  const match = matches && matches.get(matchMsgId);

  if (!match) {
    await interaction.update({ content: '⚠️ **만료된 내전입니다.**', embeds: [], components: [] });
    return;
  }

  const payload = buildPublicMessagePayload(match);
  const linkButton = new ButtonBuilder()
    .setLabel('📌 메시지로 이동')
    .setURL(match.message.url)
    .setStyle(ButtonStyle.Link);

  await interaction.update({
    content: '',
    embeds: payload.embeds,
    components: [new ActionRowBuilder().addComponents(linkButton)],
    allowedMentions: { parse: [] },
  });
}

module.exports = { handleRMatchSelect };
