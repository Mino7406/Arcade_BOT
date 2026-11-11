const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { card, payload, notice, hasCustomId, COLORS, headerSide } = require('../공통/카드');
const { getLeaderboard, getLeaderboardSize, buildProgressBar } = require('./레벨링');

const PAGE_SIZE = 5;
const MEDALS = ['🥇', '🥈', '🥉'];
const BAR_LENGTH = 10;
const MEMBER_FETCH_CHUNK_SIZE = 100; // 디스코드 게이트웨이 멤버 조회 1회 요청당 유저 ID 최대 개수

// 랭킹은 서버에 남아있는 유저만 보여주려고 XP가 있는 전원을 조회하는데, 예전엔 ◀ ▶ 를 누를
// 때마다 수백 명을 다시 조회했다. 이름·잔류 여부는 몇 분 사이에 거의 안 바뀌므로 서버별로
// 이름만(멤버 객체는 들고 있지 않음) MEMBER_NAMES_TTL_MS 동안 재사용하고, 그 사이 랭킹에 새로
// 들어온 유저만 추가로 조회한다.
const MEMBER_NAMES_TTL_MS = 5 * 60 * 1000;
const memberNamesCache = new Map(); // guildId → { at, checked: Set<userId>, names: Map<userId, displayName> }

// userIds가 100개를 넘으면 한 번에 조회가 안 되므로 100개씩 나눠 병렬로 조회한다.
// 조회에 실패한 묶음은 checked에 넣지 않는다 — 일시적 오류로 그 유저들이 TTL 동안 "서버를
// 나간 사람"처럼 랭킹에서 빠지지 않고, 다음 페이지 이동 때 다시 조회되게.
async function getMemberNames(guild, userIds) {
  let entry = memberNamesCache.get(guild.id);
  if (!entry || Date.now() - entry.at > MEMBER_NAMES_TTL_MS) {
    entry = { at: Date.now(), checked: new Set(), names: new Map() };
    memberNamesCache.set(guild.id, entry);
  }
  const missing = userIds.filter(id => !entry.checked.has(id));
  const chunks = [];
  for (let i = 0; i < missing.length; i += MEMBER_FETCH_CHUNK_SIZE) {
    chunks.push(missing.slice(i, i + MEMBER_FETCH_CHUNK_SIZE));
  }
  await Promise.all(chunks.map(async (chunk) => {
    const members = await guild.members.fetch({ user: chunk }).catch(() => null);
    if (!members) return;
    for (const id of chunk) entry.checked.add(id);
    for (const [id, member] of members) entry.names.set(id, member.displayName);
  }));
  return entry.names;
}

function formatEntry(entry, name) {
  const medal = MEDALS[entry.rank - 1];
  const rankText = medal ? `${medal} **${entry.rank}위**` : `**${entry.rank}위**`;
  const bar = buildProgressBar(entry.currentLevelXp, entry.neededXp, BAR_LENGTH);
  // 인용구(>) 두 줄: 순위·이름 / 레벨·막대·XP — 원래 랭킹 모양
  return `> ${rankText} · **${name}**\n> -# Lv.${entry.level} ・ \`${bar}\` ・ ${entry.xp} XP`;
}

// includeShare: false면 공유하기 버튼을 뺀다 (이미 공개된 메시지에는 다시 공유할 이유가 없음).
function buildComponents(page, totalPages, includeShare = true) {
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`ranking:page:${page - 1}`)
      .setLabel('◀')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`ranking:goto:${totalPages}`)
      .setLabel('🔍 페이지 이동')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(totalPages <= 1),
    new ButtonBuilder()
      .setCustomId(`ranking:page:${page + 1}`)
      .setLabel('▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
  ];
  const rows = [new ActionRowBuilder().addComponents(...buttons)];
  // 공유하기 버튼은 2열로 따로 내린다.
  if (includeShare) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ranking:share:${page}`)
        .setLabel('📤 공유하기')
        .setStyle(ButtonStyle.Success),
    ));
  }
  return rows;
}

// 반환값이 null이면 랭킹 기록이 없다는 뜻 (호출부에서 안내 메시지를 대신 보낸다).
async function buildRankingView(guild, page, includeShare = true) {
  const rawTotal = getLeaderboardSize(guild.id);
  if (rawTotal === 0) return null;

  // 서버를 나갔거나 조회가 안 되는 유저를 목록에서 완전히 빼려면, 페이지 단위가 아니라
  // 전체 랭킹을 먼저 가져와 멤버 여부를 확인한 뒤 걸러내고 그 결과로 페이지를 나눠야 한다.
  // (레벨 데이터는 파일 하나짜리 인메모리 객체라 전체를 훑어도 부담이 없다.)
  const allEntries = getLeaderboard(guild.id, rawTotal, 0);
  const names = await getMemberNames(guild, allEntries.map(e => e.userId));
  const entries = allEntries.filter(e => names.has(e.userId));
  if (entries.length === 0) return null;

  const total = entries.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const offset = (clampedPage - 1) * PAGE_SIZE;
  const pageEntries = entries.slice(offset, offset + PAGE_SIZE);

  // 한 사람이 한 블록(구분선 없이 간격만) — 5명이라 글자 수 한도(약 4000자)에 걸릴 일이 없다.
  const blocks = pageEntries.map((entry) => ({ text: formatEntry(entry, names.get(entry.userId)), noDivider: true }));

  const rankingCard = card({
    color: COLORS.gold,
    header: '🏆 서버 랭킹',
    sub: [`${clampedPage} / ${totalPages} 페이지`, `전체 ${total}명`],
    blocks,
    ...headerSide(buildComponents(clampedPage, totalPages, includeShare), /^ranking:share:/), // 공유하기는 제목 줄 오른쪽으로
  });

  return { payload: payload(rankingCard) };
}

// /랭킹 실행: 멤버 조회(네트워크 요청) 전에 먼저 ack해서 3초 인터랙션 응답 제한을 넘기지 않는다.
async function showRanking(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const view = await buildRankingView(interaction.guild, 1);
  if (!view) {
    await interaction.editReply(notice('📭 **아직 레벨 기록이 없습니다.**'));
    return;
  }
  await interaction.editReply(view.payload);
}

// ── 페이지 이동 버튼 처리 ────────────────────────────────────────
// 3초 인터랙션 응답 제한을 넘기지 않도록, 멤버 조회 등 오래 걸릴 수 있는 작업 전에 먼저 ack한다.
async function handleRankingPageButton(interaction) {
  await interaction.deferUpdate();
  await showRankingPage(interaction, parseInt(interaction.customId.slice('ranking:page:'.length), 10) || 1);
}

// 페이지 이동 버튼: 이동할 페이지 번호를 입력받는 모달을 연다.
async function handleRankingGotoButton(interaction) {
  const totalPages = parseInt(interaction.customId.slice('ranking:goto:'.length), 10) || 1;
  const modal = new ModalBuilder()
    .setCustomId('ranking:goto_modal')
    .setTitle('페이지 이동')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('page')
        .setLabel(`이동할 페이지 (1 ~ ${totalPages})`)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('숫자를 입력하세요')
        .setMinLength(1)
        .setMaxLength(6)
        .setRequired(true),
    ));
  await interaction.showModal(modal);
}

async function handleRankingGotoModal(interaction) {
  // 버튼을 눌러 연 모달이 아니면(메시지와 연결되지 않으면) 갱신할 임베드가 없으므로 무시한다.
  if (!interaction.isFromMessage()) return;
  await interaction.deferUpdate();
  const input = interaction.fields.getTextInputValue('page').trim();
  if (!/^[0-9]+$/.test(input)) {
    await interaction.followUp(notice('❌ 페이지 번호는 숫자로 입력해주세요.', { ephemeral: true }));
    return;
  }
  await showRankingPage(interaction, parseInt(input, 10)); // 범위를 벗어난 값은 buildRankingView에서 보정된다.
}

async function showRankingPage(interaction, page) {
  // 지금 누른 메시지에 원래 공유하기 버튼이 있었는지 그대로 유지한다.
  // (공개 채널 메시지는 공유하기 버튼이 없어야 하므로, 페이지를 넘겨도 다시 생기면 안 된다.)
  // 행 전체를 훑어서 확인한다 — 배포 시점에 따라 공유하기 버튼이 어느 행에 있었는지가 달라질 수 있다.
  const includeShare = hasCustomId(interaction.message.components, 'ranking:share:');
  const view = await buildRankingView(interaction.guild, page, includeShare);
  if (!view) {
    await interaction.editReply(notice('📭 **아직 레벨 기록이 없습니다.**'));
    return;
  }

  await interaction.editReply(view.payload);
}

// ── 공유하기 버튼 처리 ──────────────────────────────────────────
// 채널에 공개로 올리는 메시지에도 페이지 이동 버튼을 그대로 붙여서 넘겨보게 하고,
// 원래 나에게만 보이던 비공개 메시지는 공유하는 즉시 닫는다.
async function handleRankingShareButton(interaction) {
  await interaction.deferUpdate();
  const page = parseInt(interaction.customId.slice('ranking:share:'.length), 10) || 1;
  const view = await buildRankingView(interaction.guild, page, false);
  if (!view) {
    await interaction.editReply(notice('📭 **아직 레벨 기록이 없습니다.**'));
    return;
  }

  await interaction.channel.send(view.payload);
  await interaction.deleteReply();
}

module.exports.showRanking = showRanking;
module.exports.buildRankingView = buildRankingView; // 화면 모음·테스트용
module.exports.handleRankingPageButton = handleRankingPageButton;
module.exports.handleRankingGotoButton = handleRankingGotoButton;
module.exports.handleRankingGotoModal = handleRankingGotoModal;
module.exports.handleRankingShareButton = handleRankingShareButton;
