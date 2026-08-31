const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');

const { ADMIN_IDS, AUTO_CLOSE_DELAY_MS, disarmAutoEnd, clearNotifyTimer, deleteMentionMessage, announceMatchCompletionXp, getCancelledDeletions } = require('../handlers/공용');
// 끝말잇기/틱택토/레벨/랭킹은 이 채널(놀이터)에서만 사용 가능.
const { PLAYGROUND_CHANNEL_ID } = require('../config');

// 안내 패널의 "명령어 보기" 버튼(index.js)에서 재사용.
const COMMAND_LIST = [
  { name: '/내전', value: '게임 내전을 생성합니다.' },
  { name: '/모집', value: '게임 모집을 생성합니다.' },
  { name: '/불러오기', value: '진행 중인 내전/모집 게시글을 다시 불러옵니다.' },
  { name: '/팀', value: '내전 참가자를 팀으로 배정합니다.' },
];

// 놀이터 채널에서만 사용 가능한 명령어(PLAYGROUND_CHANNEL_ID). 위 목록과 구분선으로 구역을 나눠 표시한다.
const PLAYGROUND_COMMAND_LIST = [
  { name: '/끝말잇기', value: '끝말잇기 게임을 시작합니다.' },
  { name: '/틱택토', value: '틱택토 게임을 시작합니다.' },
  { name: '/레벨', value: '나 또는 다른 유저의 레벨/XP를 확인합니다.' },
  { name: '/랭킹', value: '서버 XP 랭킹을 확인합니다.' },
  { name: '/룰렛', value: 'XP를 걸고 룰렛머신을 돌립니다. (하루 1회)' },
];

function buildCommandListPayload() {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📖 명령어 목록')
    .addFields(
      ...COMMAND_LIST.map(c => ({ name: `\`${c.name}\``, value: c.value, inline: true })),
      { name: '​', value: '**🎡 놀이터 채널 전용**', inline: false },
      ...PLAYGROUND_COMMAND_LIST.map(c => ({ name: `\`${c.name}\``, value: c.value, inline: true })),
    );

  return { embeds: [embed], flags: MessageFlags.Ephemeral };
}

// /패널 최초 게시와 "🔄 새로고침" 버튼(index.js)에서 함께 사용.
function buildSetupPanelPayload(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
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
    .setColor(0x57F287)
    .setTitle('🎡 놀이터 채널 안내')
    .setDescription(
      '**끝말잇기, 틱택토, 오목, 룰렛, 레벨, 랭킹**은 놀이터 채널에서만 이용할 수 있어요.\n아래 버튼으로 바로 이동하세요.',
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
    new ButtonBuilder().setCustomId('recruit:관리').setLabel('⚙️ 관리').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed, playgroundEmbed], components: [row1, row2] };
}

// "⚙️ 관리" 버튼(index.js) → 관리자에게만 표시되는 패널 관리 메뉴. 새로고침 등 관리자 전용
// 조작은 패널에 바로 노출하지 않고 이 메뉴 안에 둔다. panelMessageId로 원본 패널 메시지를 지정해
// 어느 패널을 갱신할지 특정한다(채널에 패널이 여러 개 게시돼 있을 수 있으므로). 이 메뉴 내부의
// 모든 상호작용(새로고침/채널 청소/매치 삭제/봇 메시지 삭제)은 'panel:' 프리픽스로 공개 패널 버튼('recruit:')과 구분한다.
// 이 페이로드는 최초 노출(reply)뿐 아니라 update/editReply로도 재사용되는데, 뒤의 둘은 Ephemeral
// flag를 받지 않는다(이미 비공개 메시지라 붙일 필요가 없다). 그래서 flags는 여기 두지 않고 reply 호출부에서만 붙인다.
function buildAdminMenuPayload(panelMessageId, notice) {
  return {
    content: (notice ? `${notice}\n\n` : '') + '⚙️ **패널 관리**',
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel:refresh:${panelMessageId}`).setLabel('🔄 새로고침').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`panel:purge:${panelMessageId}`).setLabel('🧹 채널 청소').setStyle(ButtonStyle.Success),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel:match_delete:${panelMessageId}`).setLabel('🗑️ 내전/모집 삭제').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`panel:bot_msg_delete:${panelMessageId}`).setLabel('🤖 봇 메시지 삭제').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function buildBackRow(panelMessageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`panel:menu:${panelMessageId}`).setLabel('↩️ 돌아가기').setStyle(ButtonStyle.Secondary),
  );
}

// Discord bulkDelete는 14일 넘은 메시지를 지울 수 없다(filterOld=true로 자동 스킵). 채널 전체가
// 오래된 메시지뿐인 경우 무한정 과거까지 훑지 않도록 페이지 수에도 상한을 둔다.
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MESSAGE_PURGE_MAX_PAGES = 20; // 최대 2000개까지만 훑는다.

async function purgeUserMessages(channel) {
  const cutoff = Date.now() - BULK_DELETE_MAX_AGE_MS;
  let deleted = 0;
  let before;

  for (let page = 0; page < MESSAGE_PURGE_MAX_PAGES; page++) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch || batch.size === 0) break;

    const targets = batch.filter(m => !m.author.bot && m.createdTimestamp >= cutoff);
    if (targets.size > 0) {
      const result = await channel.bulkDelete(targets, true).catch(() => null);
      if (result) deleted += result.size;
    }

    const oldest = batch.last();
    if (!oldest || oldest.createdTimestamp < cutoff) break; // 이보다 오래된 메시지는 일괄삭제 불가
    before = oldest.id;
    if (batch.size < 100) break;
  }

  return deleted;
}

// deleteAt(epoch ms) 시점까지 남은 시간을 "약 N시간 후 자동삭제"로 표현한다.
// 내전/모집 마감 후 자동삭제, 취소된 게시글 자동삭제 표시에서 공용으로 쓴다.
function formatHoursLeft(deleteAt) {
  const hoursLeft = Math.max(0, Math.ceil((deleteAt - Date.now()) / (60 * 60 * 1000)));
  return `약 ${hoursLeft}시간 후 자동삭제`;
}

// 내전/모집 셀렉트 옵션의 상태 문구 — 모집 중이면 그대로, 마감됐다면 자동삭제(autoClose) 켜짐
// 여부에 따라 "🔒 마감됨"만 표시하거나 취소된 게시글과 동일하게 남은 시간까지 함께 보여준다.
function formatMatchStatus(match) {
  if (!match.closed) return '🟢 모집 중';
  if (!match.data?.autoClose || !match.closedAt) return '🔒 마감됨';
  return `🔒 마감됨 · ${formatHoursLeft(match.closedAt + AUTO_CLOSE_DELAY_MS)}`;
}

// 현재 서버에서 삭제 가능한 항목(진행 중/마감된 내전·모집 + 취소되어 자동삭제 대기 중인 게시글)을
// 모두 모은다. 셀렉트 목록 생성과 "전체 삭제" 양쪽에서 공유한다. 취소된 게시글은 naejeonMatches/
// mojipMatches가 아니라 client.cancelledDeletions에 채널ID만 기록돼 있어(handlers/공용.js 참고)
// 채널을 조회해야 이름과 길드를 알 수 있다.
async function collectGuildMatchEntries(interaction) {
  const naejeons = interaction.client.naejeonMatches || new Map();
  const mojips   = interaction.client.mojipMatches   || new Map();
  const cancelledDeletions = getCancelledDeletions(interaction.client);

  const entries = [];
  for (const [msgId, match] of naejeons) {
    if (match.guildId !== interaction.guildId) continue;
    entries.push({
      type: 'naejeon', msgId,
      label:       `[내전] ${match.data.title}`.slice(0, 100),
      description: `${match.data.organizer?.displayName ?? '?'} · ${match.data.datetime} · ${formatMatchStatus(match)}`.slice(0, 100),
      confirmText: `"${match.data.title}" 내전`,
    });
  }
  for (const [msgId, match] of mojips) {
    if (match.guildId !== interaction.guildId) continue;
    entries.push({
      type: 'mojip', msgId,
      label:       `[모집] ${match.data.title}`.slice(0, 100),
      description: `${match.data.organizer?.displayName ?? '?'} · ${match.data.datetime} · ${formatMatchStatus(match)}`.slice(0, 100),
      confirmText: `"${match.data.title}" 모집`,
    });
  }
  for (const [msgId, info] of cancelledDeletions) {
    const channel = interaction.client.channels.cache.get(info.channelId)
      || await interaction.client.channels.fetch(info.channelId).catch(() => null);
    if (!channel || channel.guildId !== interaction.guildId) continue;
    entries.push({
      type: 'cancelled', msgId,
      label:       `[취소됨] #${channel.name}`.slice(0, 100),
      description: `🔴 취소됨 · ${formatHoursLeft(info.deleteAt)}`.slice(0, 100),
      confirmText: `취소된 게시글 (#${channel.name})`,
    });
  }
  return entries;
}

// 취소되어 자동삭제 대기 중인 게시글 하나를 즉시 삭제한다. scheduleCancelledDelete가 건 타이머는
// 별도 핸들 없이 client.cancelledDeletions에 있는지만 확인하고 발동하므로(handlers/공용.js),
// 여기서 맵에서 지우는 것만으로 이후 타이머가 조용히 no-op된다 — clearTimeout이 따로 필요 없다.
async function deleteCancelledEntry(interaction, msgId) {
  const info = getCancelledDeletions(interaction.client).get(msgId);
  if (!info) return false;

  const channel = interaction.client.channels.cache.get(info.channelId)
    || await interaction.client.channels.fetch(info.channelId).catch(() => null);
  if (!channel || channel.guildId !== interaction.guildId) return false;

  getCancelledDeletions(interaction.client).delete(msgId);
  const message = await channel.messages.fetch(msgId).catch(() => null);
  if (message) await message.delete().catch(() => {});
  return true;
}

// "🗑️ 내전/모집 삭제"·"🗑️ 전체 삭제" 공통 삭제 로직 — type에 따라 활성 매치 정리 절차
// (8시간 자동삭제 타이머 취소, 완료 보너스 XP 지급, 참가자 멘션 삭제) 또는 취소된 게시글 삭제로 분기한다.
async function deleteMatchEntry(interaction, type, msgId) {
  if (type === 'cancelled') return deleteCancelledEntry(interaction, msgId);

  const map   = type === 'naejeon' ? interaction.client.naejeonMatches : interaction.client.mojipMatches;
  const match = map?.get(msgId);
  if (!match || match.guildId !== interaction.guildId) return false;

  disarmAutoEnd(match); // 마감된 매치라면 걸려있던 8시간 자동 삭제 타이머를 취소 — 즉시 삭제와 중복 실행되지 않도록.
  clearNotifyTimer(match); // 삭제된 매치는 알림을 보내지 않으므로 남은 예약 타이머를 취소한다.
  await announceMatchCompletionXp(match);
  map.delete(msgId);
  await deleteMentionMessage(interaction.client, match);
  await match.message.delete().catch(() => {});
  return true;
}

// "🗑️ 내전/모집 삭제" 클릭 시 보여줄 셀렉트 메뉴 — 현재 서버의 삭제 가능한 항목을 모두 표시한다.
async function buildMatchDeleteListPayload(interaction, panelMessageId) {
  const entries = await collectGuildMatchEntries(interaction);

  if (entries.length === 0) {
    return { content: '⚠️ **삭제할 수 있는 내전/모집이 없습니다.**', components: [buildBackRow(panelMessageId)] };
  }

  return {
    content: '🗑️ **삭제할 내전/모집을 선택하거나, 아래에서 전체를 삭제하세요.**',
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`panel:match_delete_select:${panelMessageId}`)
          .setPlaceholder('내전 / 모집 선택...')
          .addOptions(entries.slice(0, 25).map(e => ({ label: e.label, description: e.description, value: `${e.type}:${e.msgId}` }))),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel:match_delete_all:${panelMessageId}`).setLabel('🗑️ 전체 삭제').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`panel:menu:${panelMessageId}`).setLabel('↩️ 돌아가기').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function buildMatchDeleteConfirmPayload(panelMessageId, type, msgId, confirmText) {
  return {
    content: `⚠️ **${confirmText}을 삭제하시겠습니까?**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel:match_delete_confirm:${panelMessageId}:${type}:${msgId}`).setLabel('✅ 삭제').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`panel:menu:${panelMessageId}`).setLabel('↩️ 취소').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function buildMatchDeleteAllConfirmPayload(panelMessageId, count) {
  return {
    content: `⚠️ **현재 서버의 내전/모집 ${count}건을 전부 삭제하시겠습니까?**`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`panel:match_delete_all_confirm:${panelMessageId}`).setLabel('✅ 전체 삭제').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`panel:menu:${panelMessageId}`).setLabel('↩️ 취소').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// 메시지 ID 또는 디스코드 메시지 링크에서 { channelId, messageId }를 추출한다.
// channelId가 없으면(순수 ID만 입력) 채널을 특정할 수 없어, 아래 findBotMessage가 서버 전체를 훑는다.
function parseMessageRef(input) {
  const linkMatch = input.match(/channels\/\d+\/(\d+)\/(\d+)/);
  if (linkMatch) return { channelId: linkMatch[1], messageId: linkMatch[2] };
  if (/^\d{17,20}$/.test(input)) return { channelId: null, messageId: input };
  return null;
}

// ref로 메시지를 찾는다.
// - 링크(채널ID 포함): 그 채널에서만 조회
// - 순수 ID: 패널이 있는 현재 채널 → 없으면 이 서버에서 봇이 볼 수 있는 모든 텍스트 채널을 훑는다
//   (메시지 ID는 서버 안에서 유일하므로, 놀이터 등 다른 채널의 봇 메시지도 ID만으로 삭제 가능)
async function findBotMessage(interaction, ref) {
  if (ref.channelId) {
    const ch = await interaction.client.channels.fetch(ref.channelId).catch(() => null);
    return ch?.messages ? ch.messages.fetch(ref.messageId).catch(() => null) : null;
  }

  const here = await interaction.channel?.messages?.fetch(ref.messageId).catch(() => null);
  if (here) return here;

  const guild = interaction.guild;
  if (!guild) return null;
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return null;
  for (const ch of channels.values()) {
    if (!ch || ch.id === interaction.channelId) continue;
    if (typeof ch.isTextBased !== 'function' || !ch.isTextBased() || !ch.viewable) continue;
    const msg = await ch.messages.fetch(ref.messageId).catch(() => null);
    if (msg) return msg;
  }
  return null;
}

// "🤖 봇 메시지 삭제" 클릭 시 뜨는 모달 — ID/링크 하나만 입력받는다.
function buildBotMessageDeleteModal(panelMessageId) {
  return new ModalBuilder()
    .setCustomId(`panel:bot_msg_delete_modal:${panelMessageId}`)
    .setTitle('봇 메시지 삭제')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('message_ref')
          .setLabel('삭제할 메시지 ID 또는 링크')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('다른 채널이면 메시지 링크를 붙여넣으세요')
          .setRequired(true),
      ),
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('패널')
    .setDescription('[관리자 전용] 현재 채널에 내전/모집 안내 패널을 게시합니다.'),

  async execute(interaction) {
    if (!ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.channel.send(buildSetupPanelPayload(interaction));
    await interaction.reply({ content: '✅ **안내 패널을 게시했습니다.**', flags: MessageFlags.Ephemeral });
  },

  buildSetupPanelPayload,
  buildCommandListPayload,
  buildAdminMenuPayload,
};

// ── 관리 메뉴 버튼 처리 ('panel:' 프리픽스) ─────────────────────────
async function handlePanelButton(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  const [, action, panelMessageId, ...extra] = interaction.customId.split(':');

  if (action === 'menu') {
    await interaction.update(buildAdminMenuPayload(panelMessageId));
    return;
  }

  if (action === 'refresh') {
    await interaction.deferUpdate();
    const panelMessage = await interaction.channel.messages.fetch(panelMessageId).catch(() => null);
    if (!panelMessage) {
      await interaction.editReply(buildAdminMenuPayload(panelMessageId, '⚠️ **패널 메시지를 찾을 수 없습니다.**'));
      return;
    }
    await panelMessage.edit(buildSetupPanelPayload(interaction));
    await interaction.editReply(buildAdminMenuPayload(panelMessageId, '✅ **패널을 새로고침했습니다.**'));
    return;
  }

  if (action === 'purge') {
    await interaction.deferUpdate();
    await purgeUserMessages(interaction.channel);
    await interaction.editReply(buildAdminMenuPayload(panelMessageId, '🧹 **채널의 모든 유저 메시지를 삭제하였습니다.**'));
    return;
  }

  if (action === 'match_delete') {
    await interaction.deferUpdate();
    await interaction.editReply(await buildMatchDeleteListPayload(interaction, panelMessageId));
    return;
  }

  if (action === 'match_delete_confirm') {
    const [type, msgId] = extra;
    await interaction.deferUpdate();
    const deleted = await deleteMatchEntry(interaction, type, msgId);
    await interaction.editReply(buildAdminMenuPayload(panelMessageId, deleted ? '✅ **삭제했습니다.**' : '⚠️ **이미 삭제된 내전/모집입니다.**'));
    return;
  }

  if (action === 'match_delete_all') {
    await interaction.deferUpdate();
    const entries = await collectGuildMatchEntries(interaction);
    await interaction.editReply(buildMatchDeleteAllConfirmPayload(panelMessageId, entries.length));
    return;
  }

  if (action === 'match_delete_all_confirm') {
    await interaction.deferUpdate();
    const entries = await collectGuildMatchEntries(interaction);
    let count = 0;
    for (const entry of entries) {
      if (await deleteMatchEntry(interaction, entry.type, entry.msgId)) count++;
    }
    await interaction.editReply(buildAdminMenuPayload(panelMessageId, `✅ **내전/모집 ${count}건을 삭제했습니다.**`));
    return;
  }

  if (action === 'bot_msg_delete') {
    await interaction.showModal(buildBotMessageDeleteModal(panelMessageId));
  }
}

// ── 관리 메뉴 모달 처리 ("🤖 봇 메시지 삭제") ────────────────────────
async function handlePanelBotMessageDeleteModal(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  const raw = interaction.fields.getTextInputValue('message_ref').trim();
  const ref = parseMessageRef(raw);
  if (!ref) {
    await interaction.reply({ content: '⚠️ **올바른 메시지 ID 또는 링크가 아닙니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  // 순수 ID면 서버 전체를 훑을 수 있어 3초를 넘길 수 있으므로 먼저 응답을 확정한다.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const message = await findBotMessage(interaction, ref);

  if (!message) {
    await interaction.editReply('⚠️ **메시지를 찾을 수 없습니다.** 봇이 볼 수 있는 채널의 메시지여야 합니다 — 확실하지 않으면 메시지 **링크**를 붙여넣어 보세요.');
    return;
  }
  if (message.author.id !== interaction.client.user.id) {
    await interaction.editReply('⚠️ **봇이 보낸 메시지만 삭제할 수 있습니다.**');
    return;
  }

  try {
    await message.delete();
  } catch (err) {
    await interaction.editReply(`⚠️ **삭제에 실패했습니다.** <#${message.channelId}> 채널에서 봇에게 '메시지 관리' 권한이 있는지 확인하세요.\n-# ${err?.message ?? err}`);
    return;
  }
  await interaction.editReply('✅ **메시지를 삭제했습니다.**');
}

// ── 관리 메뉴 셀렉트 메뉴 처리 ("🗑️ 내전/모집 삭제" 목록) ────────────
async function handlePanelMatchDeleteSelect(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  const panelMessageId = interaction.customId.split(':')[2];
  const value    = interaction.values[0];
  const colonIdx = value.indexOf(':');
  const type     = value.slice(0, colonIdx);
  const msgId    = value.slice(colonIdx + 1);

  await interaction.deferUpdate();
  const entries = await collectGuildMatchEntries(interaction);
  const entry = entries.find(e => e.type === type && e.msgId === msgId);

  if (!entry) {
    await interaction.editReply(buildAdminMenuPayload(panelMessageId, '⚠️ **해당 항목을 찾을 수 없습니다.**'));
    return;
  }

  await interaction.editReply(buildMatchDeleteConfirmPayload(panelMessageId, type, msgId, entry.confirmText));
}

module.exports.handlePanelButton = handlePanelButton;
module.exports.handlePanelMatchDeleteSelect = handlePanelMatchDeleteSelect;
module.exports.handlePanelBotMessageDeleteModal = handlePanelBotMessageDeleteModal;
