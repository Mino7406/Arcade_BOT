const { buildPublicMessagePayload } = require('./내전');
const { buildMojipMessagePayload } = require('./모집');
const { notice } = require('../공통/카드');
const { armAutoEnd, autoEndAt, armNotifyReminder, saveNow, findMatchRole } = require('./공용');

async function handleRMatchSelect(interaction) {
  const value = interaction.values[0];
  const colonIdx = value.indexOf(':');
  const type  = value.slice(0, colonIdx);
  const msgId = value.slice(colonIdx + 1);
  const label = type === 'naejeon' ? '내전' : '모집';

  const matches = type === 'naejeon' ? interaction.client.naejeonMatches : interaction.client.mojipMatches;
  const match = matches && matches.get(msgId);
  if (!match || match.guildId !== interaction.guildId) {
    await interaction.update(notice(`⚠️ **만료된 ${label}입니다.**`));
    return;
  }

  // 다시 올릴 때는 역할 멘션도 한 번 더 한다(새 메시지라 알림이 다시 간다). 예전에 올라간 모집은 보관된 값이 없어 서버에서 다시 찾는다.
  const role = findMatchRole(interaction.guild, match.data);
  match.roleContent = role ? `<@&${role.id}>` : '';
  const payload = type === 'naejeon' ? buildPublicMessagePayload(match, { pingRole: true }) : buildMojipMessagePayload(match, { pingRole: true });
  const newMsg = await interaction.channel.send(payload);
  match.message.delete().catch(() => {});
  matches.delete(msgId);
  match.message = newMsg;
  matches.set(newMsg.id, match);
  saveNow(interaction.client); // 파일에 옛 메시지 ID만 남은 채 강제종료되면 새 임베드 추적이 끊긴다.
  // 재게시로 옛 메시지 ID에 걸려있던 자동 종료 타이머가 무효화되므로, 새 ID로 남은 시간만큼 다시 건다.
  // (마감 상태가 아니면 애초에 걸려있던 타이머가 없으므로 아무것도 하지 않는다.)
  if (match.closed && match.data?.autoClose) {
    const remaining = match.closedAt ? autoEndAt(match) - Date.now() : 0;
    armAutoEnd(matches, newMsg.id, match, label, Math.max(0, remaining));
  }
  // 알림 예약 타이머도 옛 메시지 ID에 걸려있으므로 새 ID로 다시 건다.
  if (match.data?.notifyAt) {
    armNotifyReminder(matches, newMsg.id, match, label);
  }
  await interaction.update(notice(`✅ **${label} 임베드가 다시 게시되었습니다.**`));
}

module.exports = { handleRMatchSelect };
