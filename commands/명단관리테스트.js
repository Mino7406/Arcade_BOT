// /명단관리테스트 — [임시] 테스트 서버 전용.
// 렐름 멤버 목록 메시지의 "관리" 버튼을 눌렀을 때 나오는 것과 똑같은 ephemeral 관리 메뉴
// (편집/추가/제외/순서 변경/새로고침)를 바로 띄운다. 그 메뉴 버튼들은 forms/마크/index.js의
// handleRealmButton('realm:roster:' 프리픽스)이 그대로 처리한다.
//
// 여기에 더해, 이 명령어 전용 버튼 "신청서 패널 새로고침"(realmtest:panelrefresh)을 한 줄 얹는다.
// 누르면 본서버 모집글에 이미 올라간 렐름 신청서 패널(config의 REALM_PANEL_*)을 그 자리에서
// 최신 상태(APPLY_DISABLED 반영)로 다시 그린다. 렐름 오픈 후 이 파일은 지워도 된다.

const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { isTestGuild } = require('../config');
const { ADMIN_IDS } = require('../handlers/공용');
const { buildRealmRosterAdminMenuPayload, refreshRealmPanelMessage } = require('../forms/마크');

const PANEL_REFRESH_ID = 'realmtest:panelrefresh';

function buildTestMenuPayload(notice) {
  const base = buildRealmRosterAdminMenuPayload(notice);
  return {
    ...base,
    components: [
      ...base.components,
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(PANEL_REFRESH_ID).setLabel('신청서 패널 새로고침 (본서버)').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

// index.js의 버튼 라우팅에서 'realmtest:' 프리픽스로 연결된다.
async function handleRealmTestButton(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '<:Barrier:1544331503448625233> **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.customId !== PANEL_REFRESH_ID) return;

  // 채널/메시지 조회 + edit까지 API가 여러 번 걸려 3초 제한을 넘길 수 있으므로 먼저 defer.
  await interaction.deferUpdate();
  const error = await refreshRealmPanelMessage(interaction.client);
  await interaction.editReply(buildTestMenuPayload(
    error
      ? `<:Barrier:1544331503448625233> **패널 새로고침 실패:** ${error}`
      : '<:Emerald:1544331499976007810> **본서버 신청서 패널을 새로고침했습니다.**',
  ));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('명단관리테스트')
    .setDescription('[임시·테스트 서버 전용] 렐름 명단 관리 메뉴를 엽니다.'),

  async execute(interaction) {
    if (!isTestGuild(interaction.guildId)) {
      await interaction.reply({ content: '<:Barrier:1544331503448625233> **테스트 서버 전용 명령어입니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '<:Barrier:1544331503448625233> **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({ ...buildTestMenuPayload(), flags: MessageFlags.Ephemeral });
  },

  handleRealmTestButton,
};
