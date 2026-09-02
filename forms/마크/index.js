const path = require('path');
const {
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

const { ADMIN_IDS } = require('../../handlers/공용');
const { logSystem } = require('../../handlers/로그');
const {
  addApprovedMember,
  removeApprovedMember,
  isApprovedMember,
  addPendingApplication,
  removePendingApplication,
  hasPendingApplication,
  updateApprovedMemberNickname,
  setApprovedMemberPosition,
  getApprovedRoster,
  getRosterMessageId,
  setRosterMessageId,
} = require('./명단');
const { REALM_REVIEW_CHANNEL_ID, REALM_WHITELIST_ROLE_ID, REALM_RULES_CHANNEL_ID, REALM_RULES_MESSAGE_ID, GUILD_ID } = require('../../config');

// "신청하기"를 누르려면 이 이모지로 규칙 메시지에 반응을 남겨둔 상태여야 한다. 안내 문구엔
// ✅ 하나만 보여주지만, 생김새가 비슷한 다른 체크 이모지(✔️ 등)로 반응해도 인정한다.
const RULES_CHECK_EMOJI = '✅';
const RULES_CHECK_EMOJIS = ['✅', '✔️', '✔'];

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

// 검토 임베드의 필드 이름(이모지 태그 포함) — buildRealmReviewPayload가 필드를 만들 때와
// handleRealmButton이 승인/거절 처리 시 원본 임베드에서 값을 다시 읽어올 때 둘 다 이 상수를
// 쓴다. 리터럴 문자열을 양쪽에 따로 적어두면 이모지를 바꿀 때 한쪽만 고치고 지나치기 쉬워서
// (실제로 한 번 그렇게 깨진 적 있음) 하나로 묶어둔다.
const FIELD_NICKNAME = '<:Name_Tag:1544325806803652608> 닉네임';
const FIELD_APPLIED_AT = '<:Compass:1544331496238882907> 신청 일시';

// 안내 패널 썸네일. attachment:// 방식으로 메시지에 매번 첨부해 올리므로 외부 링크(만료되는
// 디스코드 CDN 서명 URL 등)에 의존하지 않는다.
const THUMBNAIL_PATH = path.join(__dirname, '..', '..', 'assets', 'mc_realm_thumbnail.webp');
const THUMBNAIL_FILENAME = 'mc_realm_thumbnail.webp';

// /마크 최초 게시에서 사용. 이후 새로고침 등이 생기면 여기를 재사용한다(패널.js 패턴과 동일).
function buildRealmPanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(REALM_COLOR)
    .setTitle('마인크래프트 렐름 참가 신청')
    .setDescription(
      [
        '-# (9/5 OPEN 예정) - 신청은 9/4부터 가능',
        '',
        '> **<:apple:1544507302948634704> 신청 방법**',
        '**<:Book:1544331697049305098>신청하기** 버튼을 눌러 **마인크래프트 닉네임**을 제출해주세요.\n검토 후 결과를 DM으로 안내드려요.',
        '',
        '> **<:flag:1544635910757425183> 주의사항**',
        '**최신 릴리스**로 접속하셔야 렐름에 입장이 가능합니다.\n서버에 접속할 때는 반드시 **Java Edition**으로 접속해주세요. Bedrock Edition은 지원하지 않습니다.',
        '',
      ].join('\n'),
    )
    .setThumbnail(`attachment://${THUMBNAIL_FILENAME}`)
    .setFooter({ text: '승인 시 @마크 역할이 자동으로 지급돼요.' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('realm:apply').setLabel('신청하기').setEmoji({ id: '1544331697049305098' }).setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setLabel('규정집 바로가기')
      .setEmoji({ id: '1544571673636773898' }) // <:Enchanted_Book:...>
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${GUILD_ID}/${REALM_RULES_CHANNEL_ID}/${REALM_RULES_MESSAGE_ID}`),
  );

  return {
    embeds: [embed],
    components: [row],
    files: [new AttachmentBuilder(THUMBNAIL_PATH, { name: THUMBNAIL_FILENAME })],
  };
}

// 규칙 스레드의 메시지에 유저가 ✅를 남겨뒀는지 확인한다. 채널/메시지가 아직 설정되지 않았거나
// 못 찾으면(오탈자, 메시지 삭제 등) 관리자 설정 문제이므로 통과시키지 않고 false를 반환한다.
async function hasAgreedToRules(interaction) {
  if (!REALM_RULES_CHANNEL_ID || !REALM_RULES_MESSAGE_ID) return false;

  const channel = await interaction.client.channels.fetch(REALM_RULES_CHANNEL_ID).catch(err => {
    console.error('렐름 규정집 채널 조회 실패(REALM_RULES_CHANNEL_ID 확인 필요):', err);
    return null;
  });
  if (!channel) return false;

  // force: true — 캐시된(반응 추가 전) 옛 메시지를 쓰지 않고 매번 새로 가져와야 방금 남긴
  // 반응까지 정확히 반영된다.
  const message = await channel.messages.fetch({ message: REALM_RULES_MESSAGE_ID, force: true }).catch(err => {
    console.error('렐름 규정집 메시지 조회 실패(REALM_RULES_MESSAGE_ID 확인 필요):', err);
    return null;
  });
  if (!message) return false;

  const reaction = message.reactions.cache.find(r => RULES_CHECK_EMOJIS.includes(r.emoji.name));
  if (!reaction) return false;

  const users = await reaction.users.fetch().catch(err => {
    console.error('렐름 규정집 반응자 목록 조회 실패:', err);
    return null;
  });
  return !!users?.has(interaction.user.id);
}

// "신청하기" 클릭 시 뜨는 신청서 모달. 규칙 동의는 이제 반응(hasAgreedToRules)으로 이미
// 확인했으므로 모달엔 닉네임만 받는다. 마인크래프트 닉네임은 자바 에디션 기준 최대 16자로 제한.
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

// 관리자 검토 채널에 올라가는 임베드. status에 따라 색/제목/버튼이 바뀐다.
// - pending: 승인/거절 버튼 표시
// - approved/rejected: 버튼 제거, 처리자 기록
// displayName/processedByName은 계정 태그가 아니라 서버 별명(GuildMember.displayName)을 넘긴다.
function buildRealmReviewPayload({ applicant, displayName, nickname, appliedAt, status = 'pending', processedByName = null }) {
  const statusMeta = {
    pending:  { title: '<:Watch:1544331505101439066> 검토 대기중', color: PENDING_COLOR },
    approved: { title: '<:Emerald:1544331499976007810> 승인됨', color: REALM_COLOR },
    rejected: { title: '<:Barrier:1544331503448625233> 거절됨', color: REJECTED_COLOR },
  }[status];

  const ts = Math.floor(appliedAt / 1000);

  const embed = new EmbedBuilder()
    .setColor(statusMeta.color)
    .setAuthor({ name: `${displayName} 님의 렐름 신청서`, iconURL: applicant.displayAvatarURL() })
    .setTitle(statusMeta.title)
    .addFields(
      { name: FIELD_NICKNAME, value: nickname, inline: true },
      { name: FIELD_APPLIED_AT, value: `<t:${ts}:f>`, inline: true },
    );

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

// 명단 메시지에는 패널.js의 "⚙️ 관리" 버튼과 같은 방식으로 진입 버튼 하나만 둔다.
// 실제 조작 버튼들은 이 버튼을 눌렀을 때 뜨는 ephemeral 관리 메뉴(buildRealmRosterAdminMenuPayload) 안에 있다.
function buildRealmRosterButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('realm:roster:menu').setLabel('관리').setEmoji({ id: '1544340150585262180' }).setStyle(ButtonStyle.Secondary),
  );
}

// "⚙️ 관리" 클릭 시 뜨는 ephemeral 메뉴 — 순서 변경/새로고침은 두 번째 줄로 분리.
function buildRealmRosterAdminMenuPayload(notice) {
  return {
    content: (notice ? `${notice}\n\n` : '') + '<:OP:1544340150585262180> **명단 관리**',
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('realm:roster:edit').setLabel('편집').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('realm:roster:add').setLabel('추가').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('realm:roster:kick').setLabel('제외').setStyle(ButtonStyle.Danger),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('realm:roster:move').setLabel('순서 변경').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('realm:roster:refresh').setLabel('새로고침').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// 검토 채널에 항상 하나만 유지되는 명단 메시지. 승인/거절이 있을 때마다 refreshRealmRosterMessage가
// 이 payload로 기존 메시지를 지우고 새로 올린다(ephemeral 아님 — 관리자 전원이 볼 수 있는 채널 메시지).
// 표(코드블록) 형태는 한글이 섞이면 디스코드 고정폭 폰트가 한글 글리프에서 폰트 대체가 일어나
// 열이 어긋나 보여서, 정렬에 기대지 않는 번호 목록으로 표시한다.
function buildRealmRosterMessagePayload(entries) {
  if (entries.length === 0) {
    const embed = new EmbedBuilder().setColor(REALM_COLOR).setTitle('<:Banner:1544331498230906931> 멤버 목록 (0명)')
      .setDescription('아직 승인된 멤버가 없습니다.');
    return { embeds: [embed], components: [buildRealmRosterButtons()] };
  }

  const display = entries.slice(0, ROSTER_DISPLAY_LIMIT);
  const lines = display.map((e, i) => `**${i + 1}.** ${e.discordName ?? '알 수 없음'} — \`${e.nickname}\``);
  if (entries.length > ROSTER_DISPLAY_LIMIT) {
    lines.push(`\n_...외 ${entries.length - ROSTER_DISPLAY_LIMIT}명 더 있음_`);
  }

  const embed = new EmbedBuilder()
    .setColor(REALM_COLOR)
    .setTitle(`<:Banner:1544331498230906931> 멤버 목록 (총 ${entries.length}명)`)
    .setDescription(lines.join('\n'));

  return { embeds: [embed], components: [buildRealmRosterButtons()] };
}

// 유저 ID 입력칸 하나는 세 모달(추가/편집/제외)이 공통으로 쓰므로 빌더로 뽑아둔다.
function buildUserIdInput() {
  return new TextInputBuilder()
    .setCustomId('user_id')
    .setLabel('디스코드 유저 ID')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('예: 457437911869161472')
    .setRequired(true);
}

// "추가" 클릭 시 뜨는 모달 — 신청 절차 없이 관리자가 직접 명단에 유저를 등록한다.
function buildAddMemberModal() {
  return new ModalBuilder()
    .setCustomId('realm:roster:add_modal')
    .setTitle('멤버 수동 추가')
    .addComponents(
      new ActionRowBuilder().addComponents(buildUserIdInput()),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('nickname')
          .setLabel('마인크래프트 닉네임 (Java Edition)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('예: Notch')
          .setRequired(true)
          .setMaxLength(16),
      ),
    );
}

// "편집" 클릭 시 뜨는 모달 — 유저 ID로 대상을 지정하고 새 닉네임을 입력한다.
function buildEditNicknameModal() {
  return new ModalBuilder()
    .setCustomId('realm:roster:edit_modal')
    .setTitle('닉네임 수정')
    .addComponents(
      new ActionRowBuilder().addComponents(buildUserIdInput()),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('nickname')
          .setLabel('새 마인크래프트 닉네임 (Java Edition)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('예: Notch')
          .setRequired(true)
          .setMaxLength(16),
      ),
    );
}

// "제외" 클릭 시 뜨는 모달 — 유저 ID만 입력하면 명단에서 빼고 마크 역할도 회수한다.
function buildKickModal() {
  return new ModalBuilder()
    .setCustomId('realm:roster:kick_modal')
    .setTitle('멤버 제외')
    .addComponents(new ActionRowBuilder().addComponents(buildUserIdInput()));
}

// "순서 변경" 클릭 시 뜨는 모달 — 유저 ID와 옮길 순번(1부터)을 입력한다.
function buildMoveModal() {
  return new ModalBuilder()
    .setCustomId('realm:roster:move_modal')
    .setTitle('순서 변경')
    .addComponents(
      new ActionRowBuilder().addComponents(buildUserIdInput()),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('position')
          .setLabel('옮길 순번 (1부터, 예: 1은 맨 앞)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('예: 1')
          .setRequired(true),
      ),
    );
}

// 검토 채널(REALM_REVIEW_CHANNEL_ID)의 명단 메시지를 최신 상태로 갱신한다. 기존 메시지가 있으면
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
    .addTextDisplayComponents(td => td.setContent(approved ? '# <:MC:1544570096859742248> 렐름 신청 승인' : '# <:MC:1544570096859742248> 렐름 신청 거절'))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(td => td.setContent(
      approved
        ? '<:Emerald:1544331499976007810> 렐름 참가 신청이 **승인**되었습니다!\n이제 렐름에 접속 가능합니다!'
        : '<:Barrier:1544331503448625233>렐름 참가 신청이 **거절**되었습니다.',
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(td => td.setContent(
      approved
        ? `<:Name_Tag:1544325806803652608> **닉네임**: \`${nickname}\`\n\n<:OP:1544340150585262180> **승인자**: \`${processedByName}\``
        : `<:Name_Tag:1544325806803652608> **닉네임**: \`${nickname}\`\n\n<:OP:1544340150585262180> **거절자**: \`${processedByName}\``,
    ))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(td => td.setContent(
      approved
        ? '-# <:Book:1544331697049305098> 관리자가 승인 처리하여 자동으로 전송되었습니다.'
        : '-# <:Book:1544331697049305098> 관리자가 거절 처리하여 자동으로 전송되었습니다.',
    ));

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

// "마크" 신청서 모듈 — /신청서(commands/신청서.js)가 선택 메뉴에서 이 폼을 고르면
// buildRealmPanelPayload로 패널을 게시하고, 이후 버튼/모달 상호작용은 아래 핸들러들이 처리한다.
module.exports = {
  buildRealmPanelPayload,
  buildRealmApplyModal,
  buildRealmReviewPayload,
  refreshRealmRosterMessage,
};

// ── "🏰 신청하기" 버튼 → 신청서 모달 / "<:Emerald:1544331499976007810> 승인"·"❌ 거절" 처리 ('realm:' 프리픽스) ──
async function handleRealmButton(interaction) {
  if (interaction.customId === 'realm:apply') {
    if (isApprovedMember(interaction.guildId, interaction.user.id)) {
      await interaction.reply({ content: '<:Barrier:1544331503448625233> **이미 렐름 참가가 승인된 멤버입니다.**', flags: MessageFlags.Ephemeral });
      return;
    }
    if (hasPendingApplication(interaction.guildId, interaction.user.id)) {
      await interaction.reply({ content: '⚠️ **이미 제출한 신청서가 검토 대기중입니다.** 처리될 때까지 기다려주세요.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (!(await hasAgreedToRules(interaction))) {
      await interaction.reply({
        content: `⚠️ **먼저 규정집 메시지에 ${RULES_CHECK_EMOJI} 이모지로 동의 표시를 해주세요.**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.showModal(buildRealmApplyModal());
    return;
  }

  if (interaction.customId.startsWith('realm:roster:')) {
    await handleRosterAdminButton(interaction);
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

  // 원본 임베드에서 닉네임/신청 일시를 그대로 읽어와 재사용한다(별도 저장소 없이 메시지 자체가 상태를 들고 있음).
  const original = interaction.message.embeds[0];
  const nickname = original.fields.find(f => f.name === FIELD_NICKNAME)?.value ?? '알 수 없음';
  const appliedAtField = original.fields.find(f => f.name === FIELD_APPLIED_AT)?.value ?? '';
  const appliedAt = (appliedAtField.match(/^<t:(\d+):f>$/)?.[1] ?? Math.floor(Date.now() / 1000)) * 1000;

  removePendingApplication(interaction.guildId, applicantId); // 처리 완료 — 승인이면 명단으로, 거절이면 재신청 가능하게

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
    }),
  );

  // 명단이 바뀌었으니(승인 추가/재거절로 제거) 검토 채널의 명단 메시지도 항상 최신 하나로 유지한다.
  await refreshRealmRosterMessage(interaction.client, interaction.guildId).catch(err => console.error('렐름 명단 메시지 갱신 실패:', err));
}

// ── 신청서 모달 제출 → 관리자 검토 채널에 임베드 전송 ────────────────────
async function handleRealmModal(interaction) {
  const nickname = interaction.fields.getTextInputValue('mc_nickname').trim();

  if (!REALM_REVIEW_CHANNEL_ID) {
    await interaction.reply({ content: '⚠️ **검토 채널이 아직 설정되지 않았습니다.** 관리자에게 문의해주세요.', flags: MessageFlags.Ephemeral });
    return;
  }

  const reviewChannel = await interaction.client.channels.fetch(REALM_REVIEW_CHANNEL_ID).catch(() => null);
  if (!reviewChannel) {
    await interaction.reply({ content: '⚠️ **검토 채널을 찾을 수 없습니다.** 관리자에게 문의해주세요.', flags: MessageFlags.Ephemeral });
    return;
  }

  const appliedAt = Date.now();
  const displayName = interaction.member?.displayName ?? interaction.user.username;
  await reviewChannel.send(buildRealmReviewPayload({ applicant: interaction.user, displayName, nickname, appliedAt, status: 'pending' }));
  addPendingApplication(interaction.guildId, interaction.user.id, { nickname, appliedAt });

  await interaction.reply({
    content: `<:Emerald:1544331499976007810> **신청이 접수되었습니다.** (닉네임: \`${nickname}\`)\n검토 후 결과를 DM으로 안내드릴게요.`,
    flags: MessageFlags.Ephemeral,
  });
}

// ── 명단 메시지 관리 버튼("⚙️ 관리" 진입 버튼 + 메뉴 안의 "편집"·"추가"·"제외"·"순서 변경"·"새로고침", 'realm:roster:' 프리픽스) ──
async function handleRosterAdminButton(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '<:Barrier:1544331503448625233> **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  const sub = interaction.customId.split(':')[2];

  if (sub === 'menu') {
    await interaction.reply({ ...buildRealmRosterAdminMenuPayload(), flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'refresh') {
    // refreshRealmRosterMessage는 API 호출 여러 번(채널/메시지 조회 → 삭제 → 재전송)이 걸려
    // 3초 응답 제한을 넘길 수 있으므로, 느린 작업 전에 먼저 defer로 상호작용을 확정해둔다.
    await interaction.deferUpdate();
    await refreshRealmRosterMessage(interaction.client, interaction.guildId).catch(err => console.error('렐름 명단 메시지 갱신 실패:', err));
    await interaction.editReply(buildRealmRosterAdminMenuPayload('<:Emerald:1544331499976007810> **명단을 새로고침했습니다.**'));
    return;
  }

  // 편집/추가/제외/순서 변경 전부 셀렉트 메뉴 없이 모달 하나로 처리한다 — 유저 ID를 직접 입력.
  const modalBySub = { add: buildAddMemberModal, edit: buildEditNicknameModal, kick: buildKickModal, move: buildMoveModal };
  if (modalBySub[sub]) {
    await interaction.showModal(modalBySub[sub]());
  }
}

// 명단 관리 모달들이 공통으로 쓰는 "유저 ID로 대상 찾기" — 멘션(<@id>)을 붙여넣어도 숫자만 남긴다.
// 대상이 없거나(오탈자 등) 명단에 없으면 ephemeral 안내만 보내고 null을 반환한다.
// 호출부(handleRealmRosterModal)가 이미 deferReply를 끝낸 상태라 editReply로 응답한다.
async function resolveRosterTarget(interaction, { requireInRoster }) {
  const userId = interaction.fields.getTextInputValue('user_id').trim().replace(/\D/g, '');
  const user = await interaction.client.users.fetch(userId).catch(() => null);
  if (!user) {
    await interaction.editReply({ content: '⚠️ **해당 ID의 유저를 찾을 수 없습니다.**' });
    return null;
  }
  if (requireInRoster && !isApprovedMember(interaction.guildId, userId)) {
    await interaction.editReply({ content: '⚠️ **명단에서 해당 유저를 찾을 수 없습니다.**' });
    return null;
  }
  return { userId, user };
}

// ── 명단 관리 모달 제출("추가"·"편집"·"제외"·"순서 변경", 'realm:roster:' 프리픽스) ──
// 넷 다 유저/멤버 조회 + 역할 지급·회수 + refreshRealmRosterMessage(채널·메시지 조회/삭제/재전송)까지
// API 호출이 여러 번 이어져 3초 응답 제한을 넘기기 쉬우므로, 맨 앞에서 먼저 deferReply로 확정해둔다.
async function handleRealmRosterModal(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '<:Barrier:1544331503448625233> **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.customId === 'realm:roster:add_modal') {
    const target = await resolveRosterTarget(interaction, { requireInRoster: false });
    if (!target) return;
    const nickname = interaction.fields.getTextInputValue('nickname').trim();

    const member = await interaction.guild.members.fetch(target.userId).catch(() => null);
    const discordName = member?.displayName ?? target.user.username;

    if (REALM_WHITELIST_ROLE_ID && member) {
      await member.roles.add(REALM_WHITELIST_ROLE_ID).catch(err => console.error('렐름 마크 역할 지급 실패:', err));
    }
    addApprovedMember(interaction.guildId, target.userId, {
      nickname,
      discordName,
      approvedAt: Date.now(),
      approvedById: interaction.user.id,
    });

    await refreshRealmRosterMessage(interaction.client, interaction.guildId).catch(err => console.error('렐름 명단 메시지 갱신 실패:', err));
    await interaction.editReply({ content: `<:Emerald:1544331499976007810> **${discordName}**님을 명단에 추가했습니다.` });
    return;
  }

  if (interaction.customId === 'realm:roster:edit_modal') {
    const target = await resolveRosterTarget(interaction, { requireInRoster: true });
    if (!target) return;
    const nickname = interaction.fields.getTextInputValue('nickname').trim();

    updateApprovedMemberNickname(interaction.guildId, target.userId, nickname);
    await refreshRealmRosterMessage(interaction.client, interaction.guildId).catch(err => console.error('렐름 명단 메시지 갱신 실패:', err));
    await interaction.editReply({ content: '<:Emerald:1544331499976007810> **닉네임을 수정했습니다.**' });
    return;
  }

  if (interaction.customId === 'realm:roster:kick_modal') {
    const target = await resolveRosterTarget(interaction, { requireInRoster: true });
    if (!target) return;

    removeApprovedMember(interaction.guildId, target.userId);
    if (REALM_WHITELIST_ROLE_ID) {
      const member = await interaction.guild.members.fetch(target.userId).catch(() => null);
      if (member) await member.roles.remove(REALM_WHITELIST_ROLE_ID).catch(err => console.error('렐름 마크 역할 회수 실패:', err));
    }
    await refreshRealmRosterMessage(interaction.client, interaction.guildId).catch(err => console.error('렐름 명단 메시지 갱신 실패:', err));
    await interaction.editReply({ content: '<:Barrier:1544331503448625233> **명단에서 제외했습니다.**' });
    return;
  }

  if (interaction.customId === 'realm:roster:move_modal') {
    const target = await resolveRosterTarget(interaction, { requireInRoster: true });
    if (!target) return;
    const position = parseInt(interaction.fields.getTextInputValue('position').trim(), 10);
    if (!Number.isInteger(position) || position < 1) {
      await interaction.editReply({ content: '⚠️ **순번은 1 이상의 숫자로 입력해주세요.**' });
      return;
    }

    setApprovedMemberPosition(interaction.guildId, target.userId, position);
    await refreshRealmRosterMessage(interaction.client, interaction.guildId).catch(err => console.error('렐름 명단 메시지 갱신 실패:', err));
    await interaction.editReply({ content: `<:Emerald:1544331499976007810> **${position}번째로 순서를 옮겼습니다.**` });
  }
}

module.exports.handleRealmButton = handleRealmButton;
module.exports.handleRealmModal = handleRealmModal;
module.exports.handleRealmRosterModal = handleRealmRosterModal;
