const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { getXp, levelFromXp, buildProgressBar } = require('../handlers/레벨링');
const { displayNameFromMember } = require('../handlers/이름');
const { card, payload, notice, COLORS, pullButton } = require('../handlers/카드');

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('레벨')
    .setDescription('나 또는 다른 사용자의 레벨과 XP를 확인합니다.')
    .addUserOption(opt =>
      opt.setName('유저').setDescription('확인할 유저 (비우면 본인)').setRequired(false),
    ),

  async execute(interaction) {
    const targetUser = interaction.options.getUser('유저') || interaction.user;
    const targetMember = interaction.options.getMember('유저') || interaction.member;
    const displayName = displayNameFromMember(targetMember, targetUser);

    await interaction.reply({
      ...buildLevelPayload(interaction.guildId, targetUser, displayName, [buildShareRow(targetUser.id)]),
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    });
  },
};

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

module.exports.buildLevelPayload = buildLevelPayload; // 화면 모음·테스트용
module.exports.handleLevelShareButton = handleLevelShareButton;
