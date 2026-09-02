// /신청서 — 관리자가 "게시할 신청서"를 본인만 보이는 메뉴에서 골라 현재 채널에 신청 패널을
// 게시한다. 지금은 "마크"(마인크래프트 렐름) 하나뿐이지만, 앞으로 다른 신청서가 생기면
// forms/ 아래에 폼 모듈을 만들고 여기 FORMS 표에 한 줄만 추가하면 된다.
//
// 각 폼의 버튼/모달 상호작용 핸들러는 폼 모듈 쪽에 두고 index.js에서 프리픽스로 라우팅한다
// (마크: 'realm:' / 'realm:roster:'). 이 파일은 "어떤 폼을 게시할지" 고르는 진입점만 담당한다.

const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');

const { ADMIN_IDS } = require('../handlers/공용');
const { buildRealmPanelPayload } = require('../forms/마크');

// 신청서 종류 등록표. 새 신청서를 추가할 때는 여기에 { 종류: { label, emoji, build, done } } 한 줄만 더한다.
// - build: 현재 채널에 보낼 패널 payload를 만드는 함수
// - done:  게시 후 메뉴 자리에 남길 안내 문구
const FORMS = {
  realm: {
    label: '마크',
    emoji: { id: '1544570096859742248' }, // <:MC:...>
    build: buildRealmPanelPayload,
    done: '<:Emerald:1544331499976007810> **마크 신청 패널을 게시했습니다.**',
  },
};

// /신청서 실행 시 뜨는 본인만 보이는 선택 메뉴. FORMS의 각 항목이 버튼 하나가 된다('form:publish:<종류>').
function buildFormSelectPayload() {
  const row = new ActionRowBuilder().addComponents(
    ...Object.entries(FORMS).map(([type, form]) =>
      new ButtonBuilder()
        .setCustomId(`form:publish:${type}`)
        .setLabel(form.label)
        .setEmoji(form.emoji)
        .setStyle(ButtonStyle.Success),
    ),
  );

  return {
    content: '**게시할 신청서를 선택하십시오.**',
    components: [row],
    flags: MessageFlags.Ephemeral,
  };
}

// ── 선택 메뉴 버튼('form:publish:<종류>') → 고른 신청서 패널을 현재 채널에 게시 ──
async function handleFormSelectButton(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '<:Barrier:1544331503448625233> **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  const type = interaction.customId.split(':')[2];
  const form = FORMS[type];
  if (!form) return;

  await interaction.channel.send(form.build());
  await interaction.update({ content: form.done, components: [] });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('신청서')
    .setDescription('[관리자 전용] 게시할 신청서를 골라 현재 채널에 신청 패널을 게시합니다.'),

  async execute(interaction) {
    if (!ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '<:Barrier:1544331503448625233> **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply(buildFormSelectPayload());
  },

  buildFormSelectPayload,
  handleFormSelectButton,
};
