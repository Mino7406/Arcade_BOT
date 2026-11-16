const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { getXp, levelFromXp, buildProgressBar } = require('./레벨링');
const { displayNameFromMember } = require('../공통/이름');
const { card, payload, notice, COLORS, pullButton } = require('../공통/카드');
const { getGateways, GATEWAY_NAME, gatewayButtonEmoji } = require('../게임/블랙월게이트웨이');

// rows: 카드 안에 넣을 버튼 줄(나에게만 보이는 화면에는 공유하기 버튼, 공개 게시에는 없음)
function buildLevelPayload(guildId, targetUser, displayName, rows = []) {
  const xp = getXp(guildId, targetUser.id);
  const { level, currentLevelXp, neededXp } = levelFromXp(xp);
  const bar = buildProgressBar(currentLevelXp, neededXp);

  const share = pullButton(rows, /^level:share:/);
  return payload(card({
    color: COLORS.info,
    header: displayName,
    sub: '레벨 카드',
    thumb: targetUser.displayAvatarURL({ size: 256 }),
    thumbAlt: displayName,
    blocks: [
      { text: `## LEVEL ${level}\n${bar}\n**${currentLevelXp} / ${neededXp}** XP　(누적 \`${xp}\` XP)`, ...(share.button ? { button: share.button } : {}) },
    ],
    rows: share.rows,
  }));
}

function buildShareRow(targetUserId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`level:share:${targetUserId}`)
      .setLabel('📤 공유하기')
      .setStyle(ButtonStyle.Primary),
  );
}

function buildGatewayRow(count) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gateway:open').setEmoji(gatewayButtonEmoji()).setLabel(`${GATEWAY_NAME} 사용 (${count}개)`).setStyle(ButtonStyle.Secondary),
  );
}

// /레벨 실행: 나 또는 지정한 유저의 레벨 카드를 나에게만 보여 준다.
async function showLevel(interaction) {
  const targetUser = interaction.options.getUser('유저') || interaction.user;
  const targetMember = interaction.options.getMember('유저') || interaction.member;
  const displayName = displayNameFromMember(targetMember, targetUser);

  const rows = [buildShareRow(targetUser.id)];
  // 내 카드에서 블랙월 게이트웨이(??? 레이드 MVP 보상)를 갖고 있으면 쓰는 버튼을 붙인다(새 명령 없이)
  const gateways = targetUser.id === interaction.user.id ? getGateways(interaction.guildId, interaction.user.id) : 0;
  if (gateways > 0) rows.push(buildGatewayRow(gateways));
  await interaction.reply({
    ...buildLevelPayload(interaction.guildId, targetUser, displayName, rows),
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  });
}

// ── 공유하기 버튼 처리 ──────────────────────────────────────────
// 3초 인터랙션 응답 제한을 넘기지 않도록, 멤버 조회 등 오래 걸릴 수 있는 작업 전에 먼저 ack한다.
async function handleLevelShareButton(interaction) {
  await interaction.deferUpdate();
  const targetUserId = interaction.customId.slice('level:share:'.length);
  const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
  const targetUser = targetMember?.user || await interaction.client.users.fetch(targetUserId).catch(() => null);

  if (!targetUser) {
    await interaction.editReply(notice('⚠️ **유저를 찾을 수 없습니다.**'));
    return;
  }

  const displayName = targetMember?.displayName || targetUser.globalName || targetUser.username;
  await interaction.channel.send(buildLevelPayload(interaction.guildId, targetUser, displayName));
  await interaction.deleteReply();
}

module.exports.showLevel = showLevel;
module.exports.buildGatewayRow = buildGatewayRow; // 화면 모음용
module.exports.buildLevelPayload = buildLevelPayload; // 화면 모음·테스트용
module.exports.handleLevelShareButton = handleLevelShareButton;
