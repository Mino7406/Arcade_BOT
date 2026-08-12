const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

const { ADMIN_IDS } = require('../handlers/공용');

// 끝말잇기/틱택토/레벨/랭킹은 이 채널(놀이터)에서만 사용 가능.
const PLAYGROUND_CHANNEL_ID = '1522174367075663872';

// 안내 패널의 "명령어 보기" 버튼(index.js)에서 재사용.
const COMMAND_LIST = [
  { name: '/내전', value: '게임 내전을 생성합니다' },
  { name: '/모집', value: '게임 모집을 생성합니다' },
  { name: '/불러오기', value: '진행 중인 내전/모집 게시글을 다시 불러옵니다' },
  { name: '/팀', value: '내전 참가자를 팀으로 배정합니다' },
];

// 놀이터 채널에서만 사용 가능한 명령어(PLAYGROUND_CHANNEL_ID). 위 목록과 구분선으로 구역을 나눠 표시한다.
const PLAYGROUND_COMMAND_LIST = [
  { name: '/끝말잇기', value: '끝말잇기 게임을 시작합니다' },
  { name: '/틱택토', value: '틱택토 게임을 시작합니다 (상대방 없으면 봇과 대결)' },
  { name: '/레벨', value: '나 또는 다른 유저의 레벨/XP를 확인합니다' },
  { name: '/랭킹', value: '서버 XP 랭킹을 확인합니다' },
];

function buildCommandListPayload() {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📖 명령어 목록')
    .addFields(
      ...COMMAND_LIST.map(c => ({ name: `\`${c.name}\``, value: c.value, inline: true })),
      { name: '​', value: '**🎡 놀이터 채널 전용**', inline: false },
      ...PLAYGROUND_COMMAND_LIST.map(c => ({ name: `\`${c.name}\``, value: c.value, inline: true })),
    );

  return { embeds: [embed], ephemeral: true };
}

// /배치 최초 게시와 "🔄 새로고침" 버튼(index.js)에서 함께 사용.
function buildSetupPanelPayload(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('게임모집 채널에 오신 걸 환영합니다!')
    .setDescription(
      [
        '> **명령어 없이 바로 이용하세요. **',
        '아래 버튼 하나로 내전/모집 생성부터 관리까지 최소한의 동작으로 끝낼 수 있도록 만들었어요.',
        '',
        '> **⚔️ 내전 생성**',
        '팀 배정까지 포함된 정식 내전 모집을 만들어요.',
        '',
        '> **📋 모집 생성**',
        '팀 배정 없는 가벼운 인원 모집을 만들어요.',
        '',
        '> **🔎 불러오기**',
        '채팅에 묻힌 내전/모집 게시글을 다시 끌어올려요.',
        '',
        '> **🛠️ 팀 관리**',
        '진행 중인 내전의 팀을 수동/자동으로 배정해요.',
        '',
        '> **📖 명령어가 궁금하신가요? **',
        '**명령어 보기** 버튼을 누르면 전체 명령어 목록을 바로 확인할 수 있어요.',
      ].join('\n'),
    )
    .setThumbnail(interaction.client.user.displayAvatarURL())
    .setFooter({
      text: '버튼 말고도 해당 채널에서 명령어로도 사용 가능합니다.',
      iconURL: interaction.client.user.displayAvatarURL(),
    })
    .setTimestamp();

  const playgroundEmbed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🎡 놀이터 채널 안내')
    .setDescription(
      '**끝말잇기, 틱택토, 레벨, 랭킹**은 놀이터 채널에서만 이용할 수 있어요.\n아래 버튼으로 바로 이동하세요.',
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('recruit:내전').setLabel('⚔️ 내전 생성').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('recruit:모집').setLabel('📋 모집 생성').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('recruit:불러오기').setLabel('🔎 불러오기').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('recruit:팀').setLabel('🛠️ 팀 관리').setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('recruit:명령어').setLabel('📖 명령어 보기').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setLabel('🎡 놀이터 바로가기')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${interaction.guild.id}/${PLAYGROUND_CHANNEL_ID}`),
    new ButtonBuilder().setCustomId('recruit:새로고침').setLabel('🔄 새로고침').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed, playgroundEmbed], components: [row1, row2] };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('배치')
    .setDescription('[관리자 전용] 현재 채널에 내전/모집 안내 패널을 게시합니다.'),

  async execute(interaction) {
    if (!ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
      return;
    }

    await interaction.channel.send(buildSetupPanelPayload(interaction));
    await interaction.reply({ content: '✅ **안내 패널을 게시했습니다.**', ephemeral: true });
  },

  buildSetupPanelPayload,
  buildCommandListPayload,
};
