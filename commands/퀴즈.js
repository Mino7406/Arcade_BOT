const {
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { ADMIN_IDS } = require('../handlers/공용');
const { pauseQuiz, resumeQuiz, postCustomQuiz, getQuizStatus } = require('../handlers/퀴즈');
const { KST_OFFSET_MS } = require('../handlers/시간');

const MODE_LABELS = { chosung: '초성퀴즈', sangsik: '상식퀴즈' };
const WORD_ONLY = /^[가-힣]{2,10}$/;

function formatKst(epochMs) {
  if (!epochMs) return '-';
  const kst = new Date(epochMs + KST_OFFSET_MS);
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} ${hh}:${mm}`;
}

// /퀴즈 실행 시(그리고 각 버튼 조작 후) 보여줄 메인 패널: 현재 상태 요약 + 조작 버튼.
// notice가 있으면 상태 요약 위에 방금 한 조작의 결과 한 줄을 덧붙인다.
function buildQuizPanelPayload(notice) {
  const state = getQuizStatus();

  if (!state) {
    return {
      content: (notice ? `${notice}\n\n` : '') + '🛠️ **퀴즈 관리**\n아직 출제 기록이 없습니다. 봇이 막 시작됐다면 잠시 후 다시 확인해주세요.',
      components: [buildMainRow(false)],
    };
  }

  const lines = [
    '🛠️ **퀴즈 관리**',
    `상태 : ${state.paused ? '⏸️ 중지됨' : '▶️ 자동 출제 중'}`,
    `오늘 모드 : ${MODE_LABELS[state.mode] ?? state.mode}`,
    `오늘 출제 여부 : ${state.posted ? '✅ 출제됨' : '⏳ 대기 중'}`,
    `출제 예정 시각 : ${state.posted ? '-' : formatKst(state.scheduledAt)} (KST)`,
    `자동 출제 미해결 문제 : ${state.activeQuiz ? `${MODE_LABELS[state.activeQuiz.mode] ?? state.activeQuiz.mode} · \`${state.activeQuiz.word}\`` : '없음'}`,
    `관리자 출제 미해결 문제 : ${state.activeManualQuiz ? `${MODE_LABELS[state.activeManualQuiz.mode] ?? state.activeManualQuiz.mode} · \`${state.activeManualQuiz.word}\` (1시간 후 자동 마감)` : '없음'}`,
  ];

  return {
    content: (notice ? `${notice}\n\n` : '') + lines.join('\n'),
    components: [buildMainRow(state.paused)],
  };
}

function buildMainRow(paused) {
  return new ActionRowBuilder().addComponents(
    paused
      ? new ButtonBuilder().setCustomId('quiz:resume').setLabel('▶️ 재개').setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId('quiz:pause').setLabel('⏸️ 중지').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('quiz:create_menu').setLabel('✍️ 문제 만들기').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('quiz:refresh').setLabel('🔄 새로고침').setStyle(ButtonStyle.Secondary),
  );
}

// "✍️ 문제 만들기" 클릭 시 보여줄 모드 선택 화면 — 고르면 바로 입력용 모달이 뜬다.
function buildCreateMenuPayload() {
  return {
    content: '✍️ **문제 직접 만들기 — 어떤 모드로 낼까요?**\n단어와 힌트(뜻풀이)를 직접 입력해서 지금 바로 출제합니다. 자동 출제(초성퀴즈·상식퀴즈)와는 완전히 별개로 진행되는 보너스 문제라 중지 상태여도, 오늘 자동 출제가 이미 나갔어도 상관없이 낼 수 있습니다. 다만 **1시간 안에 못 맞히면 자동으로 마감**됩니다.',
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('quiz:create:chosung').setLabel('🔤 초성퀴즈로 만들기').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('quiz:create:sangsik').setLabel('📚 상식퀴즈로 만들기').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('quiz:back').setLabel('◀️ 취소').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function buildCreateModal(modeKey) {
  return new ModalBuilder()
    .setCustomId(`quiz:create_modal:${modeKey}`)
    .setTitle(`${MODE_LABELS[modeKey]} 직접 만들기`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('word')
          .setLabel(modeKey === 'chosung' ? '정답 단어 (초성은 자동 계산됩니다)' : '정답 단어')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('예: 축구공')
          .setMinLength(2)
          .setMaxLength(10)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('hint')
          .setLabel('힌트 (뜻풀이/설명)')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('예: 발로 차서 골대에 넣는 둥근 공.')
          .setMinLength(2)
          .setMaxLength(200)
          .setRequired(true),
      ),
    );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('퀴즈')
    .setDescription('[관리자 전용] 초성퀴즈·상식퀴즈 자동 출제를 버튼으로 직접 제어합니다.'),

  async execute(interaction) {
    if (!ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
      return;
    }
    await interaction.reply({ ...buildQuizPanelPayload(), ephemeral: true });
  },
};

// ── 버튼 처리 ────────────────────────────────────────────────────
async function handleQuizAdminButton(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
    return;
  }

  const { customId } = interaction;

  if (customId === 'quiz:pause') {
    pauseQuiz();
    await interaction.update(buildQuizPanelPayload('⏸️ 자동 출제를 중지했습니다. 이미 출제되어 있는 문제는 계속 채점됩니다.'));
    return;
  }

  if (customId === 'quiz:resume') {
    resumeQuiz(interaction.client);
    await interaction.update(buildQuizPanelPayload('▶️ 자동 출제를 다시 시작했습니다.'));
    return;
  }

  if (customId === 'quiz:refresh') {
    await interaction.update(buildQuizPanelPayload());
    return;
  }

  if (customId === 'quiz:create_menu') {
    await interaction.update(buildCreateMenuPayload());
    return;
  }

  if (customId === 'quiz:back') {
    await interaction.update(buildQuizPanelPayload());
    return;
  }

  if (customId.startsWith('quiz:create:')) {
    const modeKey = customId.slice('quiz:create:'.length); // 'chosung' | 'sangsik'
    await interaction.showModal(buildCreateModal(modeKey));
  }
}

// ── 모달(직접 문제 입력) 처리 ──────────────────────────────────────
async function handleQuizCreateModal(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
    return;
  }

  const modeKey = interaction.customId.slice('quiz:create_modal:'.length); // 'chosung' | 'sangsik'
  const word = interaction.fields.getTextInputValue('word').trim();
  const hint = interaction.fields.getTextInputValue('hint').trim();

  if (!WORD_ONLY.test(word)) {
    await interaction.reply({ content: '⚠️ **단어는 공백·특수문자 없이 한글 2~10자로 입력해주세요.**', ephemeral: true });
    return;
  }
  if (!hint) {
    await interaction.reply({ content: '⚠️ **힌트를 입력해주세요.**', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const result = await postCustomQuiz(interaction.client, modeKey, word, hint);
  const notice = result.ok
    ? `✅ **직접 만든 ${MODE_LABELS[result.mode]}를 출제했습니다.** (정답: \`${word}\`, 1시간 안에 못 맞히면 자동 마감)`
    : '⚠️ **출제에 실패했습니다.** 놀이터 채널을 찾을 수 없거나 오류가 발생했습니다.';
  await interaction.editReply(buildQuizPanelPayload(notice));
}

module.exports.handleQuizAdminButton = handleQuizAdminButton;
module.exports.handleQuizCreateModal = handleQuizCreateModal;
