const path = require('path');
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  ContainerBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require('discord.js');

const { ADMIN_IDS } = require('../handlers/공용');
const { logSystem } = require('../handlers/로그');
const {
  addApprovedMember,
  removeApprovedMember,
  isApprovedMember,
  getApprovedRoster,
  getRosterMessageId,
  setRosterMessageId,
} = require('../handlers/마크');
const { REALM_REVIEW_CHANNEL_ID, REALM_WHITELIST_ROLE_ID } = require('../config');

// DM을 보낼 수 없는 정상적인 상황(수신자가 DM 차단 / 봇과 공통 서버 없음)의 디스코드 에러 코드.
// handlers/공용.js의 마감·시작 알림 DM과 동일한 기준.
const DM_UNREACHABLE_CODES = new Set([50007, 50278]);

function logRealmDmFailure(err, applicant) {
  const 유저 = `${applicant?.tag ?? '알 수 없는 유저'}(${applicant?.id})`;
  if (DM_UNREACHABLE_CODES.has(err?.code)) {
    console.warn(`렐름 결과 DM 전송 생략(DM 차단 등, ${err.code}): ${유저}`);
    logSystem({ 유형: 'DM 실패', 유저, 내용: `렐름 결과 DM 미발송 — ${err.code}` });
  } else {
    console.error('렐름 결과 DM 전송 실패:', err);
    logSystem({ 유형: 'DM 실패', 유저, 내용: `렐름 결과 DM 발송 오류 — ${err?.message ?? err}` });
  }
}

const REALM_COLOR = 0x57F287;
const PENDING_COLOR = 0xF0B232;
const REJECTED_COLOR = 0xED4245;
const ROSTER_DISPLAY_LIMIT = 40; // 임베드 description 한도(4096자) 안에서 넉넉하게 보여줄 상한

// 안내 패널 썸네일. attachment:// 방식으로 메시지에 매번 첨부해 올리므로 외부 링크(만료되는
// 디스코드 CDN 서명 URL 등)에 의존하지 않는다.
const THUMBNAIL_PATH = path.join(__dirname, '..', 'assets', 'mc_realm_thumbnail.webp');
const THUMBNAIL_FILENAME = 'mc_realm_thumbnail.webp';

// /마크 최초 게시에서 사용. 이후 새로고침 등이 생기면 여기를 재사용한다(패널.js 패턴과 동일).
function buildRealmPanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(REALM_COLOR)
    .setTitle('마인크래프트 렐름 참가 신청')
    .setDescription(
      [
        '> **📜 신청 자격**',
        '디스코드 서버 가입 후 3일이 지난 멤버만 신청할 수 있어요.',
        '',
        '> **⚠️ 유의사항**',
        '그리핑, 무단 PvP, 상점 사기 등이 적발되면 즉시 추방되며 재신청도 제한돼요.',
        '',
        '> **📝 신청 방법**',
        '아래 **🏰 신청하기** 버튼을 눌러 마인크래프트 닉네임만 입력해주세요. 참가 후 결과를 DM으로 안내드려요.',
      ].join('\n'),
    )
    .setThumbnail(`attachment://${THUMBNAIL_FILENAME}`)
    .setFooter({ text: '승인 시 마크 역할이 자동으로 지급돼요.' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('realm:apply').setLabel('신청하기').setEmoji({ id: '1544331697049305098' }).setStyle(ButtonStyle.Success),
  );

  return {
    embeds: [embed],
    components: [row],
    files: [new AttachmentBuilder(THUMBNAIL_PATH, { name: THUMBNAIL_FILENAME })],
  };
}

// "신청하기" 클릭 시 뜨는 신청서 모달. 마인크래프트 자바 닉네임 최대 길이(16자)로 제한.
function buildRealmApplyModal() {
  return new ModalBuilder()
    .setCustomId('realm:modal')
    .setTitle('렐름 참가 신청서')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('mc_nickname')
          .setLabel('마인크래프트 닉네임 (Java Edition)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('예: Notch')
          .setRequired(true)
          .setMaxLength(16),
      ),
    );
}

// 관리자 참가 채널에 올라가는 임베드. status에 따라 색/제목/버튼이 바뀐다.
// - pending: 승인/거절 버튼 표시
// - approved/rejected: 버튼 제거, 처리자 기록
// displayName/processedByName은 계정 태그가 아니라 서버 별명(GuildMember.displayName)을 넘긴다.
function buildRealmReviewPayload({ applicant, displayName, nickname, appliedAt, status = 'pending', processedByName = null, processedAt = null }) {
  const statusMeta = {
    pending:  { title: '<:Watch:1544331505101439066> 참가 대기중', color: PENDING_COLOR },
    approved: { title: '<:Emerald:1544331499976007810> 승인됨', color: REALM_COLOR },
    rejected: { title: '<:Barrier:1544331503448625233> 거절됨', color: REJECTED_COLOR },
  }[status];

  const ts = Math.floor(appliedAt / 1000);

  const embed = new EmbedBuilder()
    .setColor(statusMeta.color)
    .setAuthor({ name: `${displayName} 님의 렐름 신청서`, iconURL: applicant.displayAvatarURL() })
    .setTitle(statusMeta.title)
    .addFields(
      { name: '<:Name_Tag:1544325806803652608> 닉네임', value: nickname, inline: true },
      { name: '<:Compass:1544331496238882907> 신청 일시', value: `<t:${ts}:f>`, inline: true },
    )
    .setTimestamp(processedAt ?? appliedAt); // 푸터 옆에 처리(또는 신청) 시각이 함께 표시됨

  if (processedByName) embed.setFooter({ text: `처리자: ${processedByName}` });

  const components = status === 'pending'
    ? [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`realm:approve:${applicant.id}`).setLabel('승인').setEmoji({ id: '1544331499976007810' }).setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`realm:reject:${applicant.id}`).setLabel('거절').setEmoji({ id: '1544331503448625233' }).setStyle(ButtonStyle.Danger),
        ),
      ]
    : [];

  return { embeds: [embed], components };
}

// 참가 채널에 항상 하나만 유지되는 명단 메시지. 승인/거절이 있을 때마다 refreshRealmRosterMessage가
// 이 payload로 기존 메시지를 지우고 새로 올린다(ephemeral 아님 — 관리자 전원이 볼 수 있는 채널 메시지).
// 표(코드블록) 형태는 한글이 섞이면 디스코드 고정폭 폰트가 한글 글리프에서 폰트 대체가 일어나
// 열이 어긋나 보여서, 정렬에 기대지 않는 번호 목록으로 표시한다.
function buildRealmRosterMessagePayload(entries) {
  if (entries.length === 0) {
    const embed = new EmbedBuilder().setColor(REALM_COLOR).setTitle('<:Banner:1544331498230906931> 렐름 멤버 목록 (0명)')
      .setDescription('아직 승인된 멤버가 없습니다.');
    return { embeds: [embed] };
  }

  const display = entries.slice(0, ROSTER_DISPLAY_LIMIT);
  const lines = display.map((e, i) => `**${i + 1}.** ${e.discordName ?? '알 수 없음'} — \`${e.nickname}\``);
  if (entries.length > ROSTER_DISPLAY_LIMIT) {
    lines.push(`\n_...외 ${entries.length - ROSTER_DISPLAY_LIMIT}명 더 있음_`);
  }

  const embed = new EmbedBuilder()
    .setColor(REALM_COLOR)
    .setTitle(`<:Banner:1544331498230906931> 렐름 멤버 목록 (총 ${entries.length}명)`)
    .setDescription(lines.join('\n'));

  return { embeds: [embed] };
}

// 참가 채널(REALM_REVIEW_CHANNEL_ID)의 명단 메시지를 최신 상태로 갱신한다. 기존 메시지가 있으면
// 지우고 새로 올려서(맨 아래로) 채널에는 항상 명단 메시지가 하나만 존재하게 한다.
async function refreshRealmRosterMessage(client, guildId) {
  if (!REALM_REVIEW_CHANNEL_ID) return;
  const channel = await client.channels.fetch(REALM_REVIEW_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const oldId = getRosterMessageId(guildId);
  if (oldId) {
    const oldMessage = await channel.messages.fetch(oldId).catch(() => null);
    if (oldMessage) await oldMessage.delete().catch(() => {});
  }

  const entries = getApprovedRoster(guildId);
  const newMessage = await channel.send(buildRealmRosterMessagePayload(entries)).catch(err => {
    console.error('렐름 명단 메시지 게시 실패:', err);
    return null;
  });
  if (newMessage) setRosterMessageId(guildId, newMessage.id);
}

// 승인/거절 결과 DM. handlers/공용.js의 마감·시작 알림 DM(ContainerBuilder + Components V2)과
// 동일한 형식으로 맞춘다 — 제목 → 구분선 → 본문 → 구분선 → 안내 문구(-# 회색 소문구) 순서.
function buildRealmResultDm(status, nickname, processedByName) {
  const approved = status === 'approved';
  const container = new ContainerBuilder()
    .addTextDisplayComponents(td => td.setContent(approved ? '# <:Emerald:1544331499976007810> 렐름 신청 승인' : '# <:Barrier:1544331503448625233> 렐름 신청 거절'))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(td => td.setContent(
      approved
        ? `렐름 참가 신청이 **승인**되었습니다!\n이제 렐름에 접속 가능합니다!\n\n<:Name_Tag:1544325806803652608> 닉네임: \`${nickname}\``
        : `렐름 참가 신청이 **거절**되었습니다.\n\n<:Name_Tag:1544325806803652608> 닉네임: \`${nickname}\``,
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(td => td.setContent(
      approved
        ? `-# <:Book:1544331697049305098> 관리자가 승인 처리하여 자동으로 전송되었습니다.\n-# 승인자: ${processedByName}`
        : `-# <:Book:1544331697049305098> 관리자가 거절 처리하여 자동으로 전송되었습니다.\n-# 거절자: ${processedByName}`,
    ));

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('마크')
    .setDescription('[관리자 전용] 현재 채널에 마인크래프트 렐름 참가 신청 패널을 게시합니다.'),

  async execute(interaction) {
    if (!ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '<:Barrier:1544331503448625233> **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.channel.send(buildRealmPanelPayload());
    await interaction.reply({ content: '<:Emerald:1544331499976007810> **마크 신청 패널을 게시했습니다.**', flags: MessageFlags.Ephemeral });
  },

  buildRealmPanelPayload,
  buildRealmApplyModal,
  buildRealmReviewPayload,
  refreshRealmRosterMessage,
};

// ── "🏰 신청하기" 버튼 → 신청서 모달 / "<:Emerald:1544331499976007810> 승인"·"❌ 거절" 처리 ('realm:' 프리픽스) ──
async function handleRealmButton(interaction) {
  if (interaction.customId === 'realm:apply') {
    if (isApprovedMember(interaction.guildId, interaction.user.id)) {
      await interaction.reply({ content: '<:Emerald:1544331499976007810> **이미 렐름 참가가 승인된 멤버입니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(buildRealmApplyModal());
    return;
  }

  const [, action, applicantId] = interaction.customId.split(':');
  if (action !== 'approve' && action !== 'reject') return;

  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '<:Barrier:1544331503448625233> **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  const applicant = await interaction.client.users.fetch(applicantId).catch(() => null);
  if (!applicant) {
    await interaction.followUp({ content: '⚠️ **신청자 정보를 찾을 수 없습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }
  // 서버 별명(닉네임)을 쓰기 위해 GuildMember도 함께 가져온다 — 탈퇴 등으로 없으면 계정 이름으로 대체.
  const applicantMember = await interaction.guild.members.fetch(applicantId).catch(() => null);
  const displayName = applicantMember?.displayName ?? applicant.username;
  const processedByName = interaction.member?.displayName ?? interaction.user.username;
  const processedAt = Date.now();

  // 원본 임베드에서 닉네임/신청 일시를 그대로 읽어와 재사용한다(별도 저장소 없이 메시지 자체가 상태를 들고 있음).
  const original = interaction.message.embeds[0];
  const nickname = original.fields.find(f => f.name === '<:Name_Tag:1544325806803652608> 닉네임')?.value ?? '알 수 없음';
  const appliedAtField = original.fields.find(f => f.name === '<:Compass:1544331496238882907> 신청 일시')?.value ?? '';
  const appliedAt = (appliedAtField.match(/^<t:(\d+):f>$/)?.[1] ?? Math.floor(Date.now() / 1000)) * 1000;

  if (action === 'approve') {
    if (REALM_WHITELIST_ROLE_ID && applicantMember) {
      await applicantMember.roles.add(REALM_WHITELIST_ROLE_ID).catch(err => console.error('렐름 마크 역할 지급 실패:', err));
    }
    addApprovedMember(interaction.guildId, applicantId, {
      nickname,
      discordName: displayName,
      approvedAt: Date.now(),
      approvedById: interaction.user.id,
    });
    await applicant.send(buildRealmResultDm('approved', nickname, processedByName)).catch(err => logRealmDmFailure(err, applicant));
  } else {
    removeApprovedMember(interaction.guildId, applicantId); // 승인 후 재처리로 거절된 경우 명단에서 제거
    await applicant.send(buildRealmResultDm('rejected', nickname, processedByName)).catch(err => logRealmDmFailure(err, applicant));
  }

  await interaction.editReply(
    buildRealmReviewPayload({
      applicant,
      displayName,
      nickname,
      appliedAt,
      status: action === 'approve' ? 'approved' : 'rejected',
      processedByName,
      processedAt,
    }),
  );

  // 명단이 바뀌었으니(승인 추가/재거절로 제거) 참가 채널의 명단 메시지도 항상 최신 하나로 유지한다.
  await refreshRealmRosterMessage(interaction.client, interaction.guildId).catch(err => console.error('렐름 명단 메시지 갱신 실패:', err));
}

// ── 신청서 모달 제출 → 관리자 참가 채널에 임베드 전송 ────────────────────
async function handleRealmModal(interaction) {
  const nickname = interaction.fields.getTextInputValue('mc_nickname').trim();

  if (!REALM_REVIEW_CHANNEL_ID) {
    await interaction.reply({ content: '⚠️ **참가 채널이 아직 설정되지 않았습니다.** 관리자에게 문의해주세요.', flags: MessageFlags.Ephemeral });
    return;
  }

  const reviewChannel = await interaction.client.channels.fetch(REALM_REVIEW_CHANNEL_ID).catch(() => null);
  if (!reviewChannel) {
    await interaction.reply({ content: '⚠️ **참가 채널을 찾을 수 없습니다.** 관리자에게 문의해주세요.', flags: MessageFlags.Ephemeral });
    return;
  }

  const appliedAt = Date.now();
  const displayName = interaction.member?.displayName ?? interaction.user.username;
  await reviewChannel.send(buildRealmReviewPayload({ applicant: interaction.user, displayName, nickname, appliedAt, status: 'pending' }));

  await interaction.reply({
    content: `<:Emerald:1544331499976007810> **신청이 접수되었습니다.** (닉네임: \`${nickname}\`)\n참가 후 결과를 DM으로 안내드릴게요.`,
    flags: MessageFlags.Ephemeral,
  });
}

module.exports.handleRealmButton = handleRealmButton;
module.exports.handleRealmModal = handleRealmModal;
