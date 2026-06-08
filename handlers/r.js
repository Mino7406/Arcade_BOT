const { buildPublicMessagePayload } = require('./naejeon');

async function handleRMatchSelect(interaction) {
  const matchMsgId = interaction.values[0];
  const matches = interaction.client.naejeonMatches;
  const match = matches && matches.get(matchMsgId);

  if (!match) {
    await interaction.update({ content: '⚠️ **만료된 내전입니다.**', embeds: [], components: [] });
    return;
  }

  // 새 메시지로 임베드 + 버튼 재게시 (역할 멘션 제외)
  const payload = buildPublicMessagePayload(match);
  const newMsg = await interaction.channel.send({ ...payload, content: '' });

  // 기존 메시지 버튼 비활성화 (조용히 실패해도 무방)
  match.message.edit({ components: [] }).catch(() => {});

  // 매치 참조를 새 메시지로 교체
  matches.delete(matchMsgId);
  match.message = newMsg;
  matches.set(newMsg.id, match);

  await interaction.update({ content: '✅ **내전 임베드가 다시 게시되었습니다.**', embeds: [], components: [] });
}

module.exports = { handleRMatchSelect };
