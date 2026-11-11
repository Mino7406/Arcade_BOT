// /관리 화면 로직 — 관리자용 명령을 한 곳에 모은 통합 패널(XP 관리·XP 조정·퀴즈·패널 게시·소식 알림·게시물 최신화).
// 예전에는 /xp, /퀴즈, /패널이 따로 있었다. 이제 /관리 하나로 열고, 각 기능 화면은 "↩️ 메뉴로"로 이 홈에 돌아온다.
// 홈에서 자주 쓰는 스위치(소식 알림 일시정지 등)는 줄 오른쪽 버튼으로 바로 누를 수 있다.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { ADMIN_IDS } = require('../../config');
const { card, payload, asEphemeral, notice, COLORS } = require('../공통/카드');
const { getXpState } = require('../레벨/레벨링');
const { getRaidStatus } = require('../레이드');
const { getQuizStatus } = require('../게임/퀴즈');
const { getPatchNoteStatus, setPatchNotePaused, checkPatchNotesNow, sendPatchNoteTest } = require('./패치노트');
const { logAction } = require('../공통/로그');

// 같은 게임의 패치노트·점검 확인을 한 줄로 합쳐 보여 준다(리그 오브 레전드 = 패치노트 + 점검).
function patchSourceLines(status) {
  const byName = new Map();
  for (const g of status.games) {
    const cur = byName.get(g.name) ?? { name: g.name, lastAt: null, bad: false, tried: false };
    if (g.lastAt) { cur.tried = true; cur.lastAt = Math.max(cur.lastAt ?? 0, g.lastAt); }
    if (g.ok === false) cur.bad = true;
    byName.set(g.name, cur);
  }
  return [...byName.values()].map(g => {
    if (!g.tried) return `⏳ **${g.name}** — 확인 전`;
    const t = Math.floor(g.lastAt / 1000);
    return `${g.bad ? '⚠️' : '✅'} **${g.name}** — <t:${t}:R>${g.bad ? ' · 확인 실패' : ''}`;
  }).join('\n');
}

function buildPatchBlocks(status) {
  if (!status) return [{ text: '### 📣 소식 알림\n⚪ 아직 시작되지 않았어요' }];
  const pauseButton = status.paused
    ? new ButtonBuilder().setCustomId('admin:patch:toggle').setLabel('재개').setEmoji('▶️').setStyle(ButtonStyle.Success)
    : new ButtonBuilder().setCustomId('admin:patch:toggle').setLabel('일시정지').setStyle(ButtonStyle.Danger);
  return [
    {
      text: `### 📣 소식 알림\n${status.paused ? '⏸️ 일시정지됨' : '▶️ 작동 중'} · 오늘 ${status.today}개 알림\n-# 롤 · 발로란트 · 오버워치 · 배그 공식 홈페이지의 패치노트와 점검 공지`,
      button: pauseButton,
    },
    `### 🔎 출처별 마지막 확인\n${patchSourceLines(status)}`,
  ];
}

// 홈 화면. note: 방금 한 조작의 결과 한 줄.
function buildAdminHome({ guildId, note } = {}) {
  const xp = getXpState();
  const raid = getRaidStatus(guildId);
  const quiz = getQuizStatus();
  const patch = getPatchNoteStatus();

  const xpLine = [
    `파밍 ${xp.farmFrozen ? '🔴' : '🟢'}`,
    `미니게임 ${xp.minigameFrozen ? '🔴' : '🟢'}`,
    `부스트 ${xp.newbieBoostEnabled ? '🟢' : '⚪'}`,
    `레이드 자동 ${raid.autoSpawn ? '🟢' : '🔴'}`,
  ].join(' · ');
  const quizLine = quiz
    ? `자동 출제 ${quiz.paused ? '⏸️ 중지됨' : '▶️ 작동 중'} · 오늘 ${quiz.posted ? '✅ 출제됨' : '⏳ 대기 중'}`
    : '출제 기록 없음';

  const bad = xp.farmFrozen || xp.minigameFrozen || patch?.paused;
  return payload(card({
    color: bad ? COLORS.warn : COLORS.ok,
    header: '🛠️ ARCADE 관리',
    sub: '소식 알림 · XP · 퀴즈 · 패널 · 게시물 · 채널',
    blocks: [
      note || null,
      ...buildPatchBlocks(patch),
      {
        text: `### ✨ XP\n${xpLine}`,
        button: new ButtonBuilder().setCustomId('xp:menu:manage').setLabel('XP 관리').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
      },
      {
        text: `### 🧠 퀴즈\n${quizLine}`,
        button: new ButtonBuilder().setCustomId('admin:quiz').setLabel('퀴즈 관리').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
      },
      {
        rows: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('xp:menu:adjust').setLabel('XP 조정').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('admin:panels').setLabel('패널 게시').setEmoji('📌').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('admin:refresh').setLabel('게시물 최신화').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('admin:channel').setLabel('채널 관리').setEmoji('🧹').setStyle(ButtonStyle.Secondary),
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('admin:home').setLabel('새로고침').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('admin:patch:check').setLabel('지금 확인').setEmoji('📡').setStyle(ButtonStyle.Secondary).setDisabled(!!patch?.paused || !patch),
            new ButtonBuilder().setCustomId('admin:patch:test').setLabel('테스트 알림').setEmoji('🧪').setStyle(ButtonStyle.Secondary).setDisabled(!patch),
          ),
        ],
      },
    ],
  }));
}

function backRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:home').setLabel('메뉴로').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
  );
}

async function denyUnlessAdmin(interaction) {
  if (ADMIN_IDS.includes(interaction.user.id)) return false;
  await interaction.reply(notice('❌ **권한이 없습니다.**', { ephemeral: true }));
  return true;
}

// 'admin:' 버튼 처리. 퀴즈·패널 화면은 기존 모듈의 빌더를 그대로 쓰고 "메뉴로" 버튼만 붙는다.
async function handleAdminButton(interaction) {
  if (await denyUnlessAdmin(interaction)) return;
  const sub = interaction.customId.split(':').slice(1).join(':');
  const guildId = interaction.guildId;

  if (sub === 'home') {
    await interaction.update(buildAdminHome({ guildId }));
    return;
  }

  if (sub === 'patch:toggle') {
    const status = getPatchNoteStatus();
    if (!status) { await interaction.update(buildAdminHome({ guildId, note: '⚠️ **소식 알림이 아직 시작되지 않았어요.**' })); return; }
    const next = !status.paused;
    setPatchNotePaused(next);
    logAction(interaction, '관리', `소식 알림 ${next ? '일시정지' : '재개'}`);
    await interaction.update(buildAdminHome({ guildId, note: next ? '⏸️ **소식 알림을 일시정지했어요.** 재개할 때까지 새 글이 올라와도 알리지 않아요.' : '▶️ **소식 알림을 재개했어요.** 곧 한 번 확인해요.' }));
    return;
  }

  if (sub === 'patch:check') {
    await interaction.deferUpdate();
    const ran = await checkPatchNotesNow().catch(() => false);
    await interaction.editReply(buildAdminHome({ guildId, note: ran ? '📡 **모든 출처를 지금 확인했어요.**' : '⚠️ **일시정지 중이거나 아직 시작 전이라 확인하지 않았어요.**' }));
    return;
  }

  if (sub === 'patch:test') {
    await interaction.deferUpdate();
    let note;
    try {
      await sendPatchNoteTest();
      logAction(interaction, '관리', '소식 알림 테스트 공지 전송');
      note = '🧪 **테스트 알림을 공지 채널에 보냈어요.**';
    } catch (err) {
      note = `⚠️ **테스트 알림 전송 실패:** ${err?.message ?? err}`;
    }
    await interaction.editReply(buildAdminHome({ guildId, note }));
    return;
  }

  if (sub === 'quiz') {
    const { buildQuizPanelPayload } = require('./퀴즈관리');
    await interaction.update(buildQuizPanelPayload(interaction.user.id));
    return;
  }

  if (sub === 'panels') {
    const { buildPanelSelectPayload } = require('./패널');
    await interaction.update(buildPanelSelectPayload({ withBack: true }));
    return;
  }

  if (sub === 'channel') {
    const { buildAdminMenuPayload } = require('./패널');
    await interaction.update(buildAdminMenuPayload('admin'));
    return;
  }

  if (sub === 'refresh') {
    await interaction.deferUpdate();
    const { refreshPostedMessages } = require('./최신화');
    const result = await refreshPostedMessages(interaction.client, { includeCobblemon: true }).catch(err => ({ error: err?.message ?? String(err) }));
    logAction(interaction, '관리', `게시물 최신화 — ${result.summary ?? result.error}`);
    await interaction.editReply(buildAdminHome({ guildId, note: result.error ? `⚠️ **최신화 중 오류:** ${result.error}` : `🔄 **게시물을 최신 디자인으로 갱신했어요.**\n-# ${result.summary}` }));
    return;
  }
}

// /관리 실행: 관리자만, 나만 보이는 홈 카드로.
async function openAdminHome(interaction) {
  if (await denyUnlessAdmin(interaction)) return;
  await interaction.reply(asEphemeral(buildAdminHome({ guildId: interaction.guildId })));
}

module.exports = {
  openAdminHome,
  buildAdminHome,
  backRow,
  handleAdminButton,
};
