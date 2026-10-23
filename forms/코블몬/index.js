const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');

const COBBLEMON_COLOR = 0xE8344E;

// 안내 패널 썸네일. 마크 패널과 같이 attachment:// 방식으로 매번 첨부해 올린다.
const THUMBNAIL_PATH = path.join(__dirname, '..', '..', 'assets', 'cobblemon_thumbnail.png');
const THUMBNAIL_FILENAME = 'cobblemon_thumbnail.png';

// "설치기 다운로드" 버튼이 여는 다운로드 링크. 비어 있으면 링크 버튼 대신 "준비 중" 안내 버튼을 띄운다.
const INSTALLER_URL = 'https://github.com/Mino7406/ACI/releases/latest/download/ARCADE_Cobblemon_Installer.exe';

// "코블몬" 안내 패널 — 신청 절차 없이 설치기 링크와 모드 사용법 버튼만 둔다.
// client를 넘기면 footer 아이콘에 봇 프로필 사진을 붙인다(안 넘겨도 동작).
function buildCobblemonPanelPayload(client) {
  const embed = new EmbedBuilder()
    .setColor(COBBLEMON_COLOR)
    .setTitle('ARCADE 코블몬 서버 안내')
    .setDescription(
      [
        '-# **2026.10.25 ~**',
        '',
        '> **<:pokeball:1563009328368066590> 참가 방법**',
        '**<:cobblemon:1562830370368528384>설치기 다운로드** 버튼을 누르면 다운로드 링크로 이동됩니다.\n해당 서버는 위 설치기를 통해야만 **접속이 가능합니다.**',
        '',
        '> **<:greatball:1563009326543675493> 주의사항**',
        '해당 서버는 렉을 최소화하기 위해 **월드 제한**을 두고 있습니다.\n**렉을 유발하는 장치 제작, 행동은 제제 대상**입니다.',
        '',
        '> **<:ultraball:1563009329974747156> 행동 강령**',
        'ARCADE 전용 모드 제작으로 갈등 발생을 최소화 하였으나 **갈등을 조장하는 장치 제작, 행동은 제제 대상**입니다.',
      ].join('\n'),
    )
    .setThumbnail(`attachment://${THUMBNAIL_FILENAME}`)
    .setFooter({
      text: "관련 문의는 임원 '김민호' 에게 해주시면 됩니다.",
      iconURL: client?.user?.displayAvatarURL() ?? undefined,
    });

  const installerButton = INSTALLER_URL
    ? new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(INSTALLER_URL)
    : new ButtonBuilder().setCustomId('cobblemon:installer').setStyle(ButtonStyle.Success);

  const row = new ActionRowBuilder().addComponents(
    installerButton.setLabel('설치기 다운로드').setEmoji({ id: '1562830370368528384' }), // <:cobblemon:...>
    new ButtonBuilder()
      .setCustomId('cobblemon:guide')
      .setLabel('ARCADE 모드 사용법')
      .setEmoji({ id: '1563093933809074247' }) // <:pokedex:...>
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [embed],
    components: [row],
    files: [new AttachmentBuilder(THUMBNAIL_PATH, { name: THUMBNAIL_FILENAME })],
  };
}

// ── "설치기 다운로드"(링크 미설정 시)·"ARCADE 모드 사용법" 버튼 ('cobblemon:' 프리픽스) ──
async function handleCobblemonButton(interaction) {
  const sub = interaction.customId.split(':')[1];
  if (sub === 'installer' || sub === 'guide') {
    await interaction.reply({ content: '**아직 준비 중입니다.**', flags: MessageFlags.Ephemeral });
  }
}

module.exports = {
  buildCobblemonPanelPayload,
  handleCobblemonButton,
};
