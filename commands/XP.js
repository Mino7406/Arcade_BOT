const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const { ADMIN_IDS } = require('../config');
const {
  getXp,
  levelFromXp,
  buildProgressBar,
  adjustXp,
  setXp,
  xpForLevelStart,
  saveLevels,
  isLevelsLoaded,
  isExcludedGuild,
  getXpState,
  setXpSwitch,
} = require('../handlers/레벨링');
const { logAction } = require('../handlers/로그');
const { displayNameFromMember } = require('../handlers/이름');

// 한 번에 조정 가능한 XP 폭 / 레벨 상한. 오타로 터무니없는 값이 들어가는 것만 막는 안전장치.
const MAX_ABS = 10_000_000;
const MAX_LEVEL = 1000;

// 조정 전 공통 관문 — 막히면 true. 순서 주의: 권한을 먼저 봐서 비관리자에게 내부 상태를 흘리지 않는다.
async function denyGuard(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (isExcludedGuild(interaction.guildId)) {
    await interaction.reply({ content: '⚠️ **이 서버는 레벨 시스템이 비활성화돼 있어 XP를 조정할 수 없습니다.**', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (!isLevelsLoaded()) {
    // 복원 전에는 levels가 빈 객체라, 여기서 조정+저장하면 levels.json이 통째로 비워진다.
    await interaction.reply({ content: '⚠️ **레벨 데이터를 복원하는 중입니다. 잠시 후 다시 시도하세요.**', flags: MessageFlags.Ephemeral });
    return true;
  }
  return false;
}

function persist() {
  try {
    saveLevels();
  } catch (err) {
    console.error('/xp 저장 실패:', err);
  }
}

// ── 화면 구성 ─────────────────────────────────────────────────

function buildPickRow(selectedId) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId('xp:pick')
    .setPlaceholder('조정할 유저를 선택하세요')
    .setMinValues(1)
    .setMaxValues(1);
  if (selectedId) menu.setDefaultUsers([selectedId]);
  return new ActionRowBuilder().addComponents(menu);
}

function buildActionRow(targetId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`xp:add:${targetId}`).setEmoji('➕').setLabel('XP').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`xp:sub:${targetId}`).setEmoji('➖').setLabel('XP').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`xp:level:${targetId}`).setEmoji('🔄').setLabel('레벨 조정').setStyle(ButtonStyle.Primary),
  );
}

// ── /xp 첫 화면: "XP 조정" / "XP 관리" 분기 ──────────────────────
function buildMenuView() {
  return {
    content: '**XP 콘솔** — 항목을 선택하세요.',
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('xp:menu:adjust').setEmoji('⚙️').setLabel('XP 조정').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('xp:menu:manage').setEmoji('🛠️').setLabel('XP 관리').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ── "XP 관리" 패널: 일반파밍/미니게임 긴급정지 + 뉴비부스트 토글 ──
function buildManageView(notice) {
  const st = getXpState();
  const embed = new EmbedBuilder()
    .setColor(st.farmFrozen || st.minigameFrozen ? 0xED4245 : 0x57F287)
    .setDescription(
      `## 🛠️ XP 관리\n` +
      `**일반 파밍 XP** ${st.farmFrozen ? '🔴 정지됨' : '🟢 작동 중'}\n` +
      `-# 메인·TTS 채팅 · 통화방 체류 · 내전/모집 완료 보너스\n\n` +
      `**미니게임 XP** ${st.minigameFrozen ? '🔴 정지됨' : '🟢 작동 중'}\n` +
      `-# 오목 · 룰렛 · 틱택토 · 끝말잇기 · 퀴즈\n\n` +
      `**뉴비부스트(×1.5)** ${st.newbieBoostEnabled ? '🟢 ON' : '⚪ OFF'}\n` +
      `-# 뉴비부스트 역할의 메인·TTS·통화방 체류 XP 1.5배` +
      (notice ? `\n\n${notice}` : ''),
    )
    .setTimestamp();
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('xp:mng:farm')
          .setEmoji(st.farmFrozen ? '▶️' : '⏸️')
          .setLabel(st.farmFrozen ? '일반파밍 재개' : '일반파밍 긴급정지')
          .setStyle(st.farmFrozen ? ButtonStyle.Success : ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('xp:mng:game')
          .setEmoji(st.minigameFrozen ? '▶️' : '⏸️')
          .setLabel(st.minigameFrozen ? '미니게임 재개' : '미니게임 긴급정지')
          .setStyle(st.minigameFrozen ? ButtonStyle.Success : ButtonStyle.Danger),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('xp:mng:boost')
          .setEmoji('✨')
          .setLabel(st.newbieBoostEnabled ? '뉴비부스트 끄기' : '뉴비부스트 켜기')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('xp:menu:home').setEmoji('↩️').setLabel('메뉴로').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ── 긴급정지 ON/OFF 확인 화면 ──────────────────────────────────
function buildConfirmView(which) {
  const st = getXpState();
  const isFarm = which === 'farm';
  const frozen = isFarm ? st.farmFrozen : st.minigameFrozen;
  const label = isFarm ? '일반 파밍' : '미니게임';
  const act = frozen ? '재개' : '긴급정지';
  const embed = new EmbedBuilder()
    .setColor(frozen ? 0x57F287 : 0xED4245)
    .setDescription(
      `## ⚠️ 확인\n**${label} XP 지급을 ${act}**하시겠습니까?\n\n` +
      (frozen
        ? '재개하면 즉시 다시 XP가 지급됩니다.'
        : `정지하면 관리자가 다시 켤 때까지 ${label} 관련 XP가 전혀 지급되지 않습니다.`),
    );
  return {
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`xp:mngyes:${which}`).setLabel(`네, ${act}합니다`)
          .setStyle(frozen ? ButtonStyle.Success : ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('xp:mngno').setLabel('취소').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function buildPanelEmbed(guildId, targetId, targetUser, displayName, notice) {
  const xp = getXp(guildId, targetId);
  const { level, currentLevelXp, neededXp } = levelFromXp(xp);
  const bar = buildProgressBar(currentLevelXp, neededXp);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setDescription(
      `## ⚙️ XP 조정\n` +
      `대상 : <@${targetId}> (\`${displayName}\`)\n\n` +
      `**LEVEL ${level}**\n${bar}\n**${currentLevelXp} / ${neededXp}** XP　(누적 \`${xp}\` XP)` +
      (notice ? `\n\n${notice}` : ''),
    )
    .setFooter({ text: '아래 버튼으로 XP를 조정할 수 있습니다.' })
    .setTimestamp();
  if (targetUser) embed.setThumbnail(targetUser.displayAvatarURL({ size: 256 }));
  return embed;
}

async function resolveTarget(interaction, targetId) {
  const member = await interaction.guild.members.fetch(targetId).catch(() => null);
  const user = member?.user || await interaction.client.users.fetch(targetId).catch(() => null);
  const displayName = displayNameFromMember(member, user);
  return { user, displayName };
}

async function buildPanel(interaction, targetId, notice) {
  return buildPanelView(interaction, targetId, await resolveTarget(interaction, targetId), notice);
}

function buildPanelView(interaction, targetId, { user, displayName }, notice) {
  return {
    content: '',
    embeds: [buildPanelEmbed(interaction.guildId, targetId, user, displayName, notice)],
    components: [buildPickRow(targetId), buildActionRow(targetId)],
  };
}

// 로그 파일(DB/log.json)에 남길 감사 한 줄. 레벨이 그대로면 Lv.만, 바뀌면 전→후로 표기.
function xpLogLine(result) {
  const sign = result.appliedDelta >= 0 ? '+' : '';
  const lv = result.oldLevel === result.newLevel
    ? `Lv.${result.newLevel}`
    : `Lv.${result.oldLevel}→${result.newLevel}`;
  const clip = result.appliedDelta !== result.requestedDelta ? ` [요청 ${result.requestedDelta}]` : '';
  return `${sign}${result.appliedDelta} XP (${result.oldXp}→${result.newXp}, ${lv})${clip}`;
}

function formatAdjustNotice(result) {
  const sign = result.appliedDelta >= 0 ? '+' : '';
  let s = `✅ **${sign}${result.appliedDelta} XP** 적용 (누적 \`${result.oldXp}\` → \`${result.newXp}\`)`;
  if (result.leveledUp) s += `\n📈 레벨 **${result.oldLevel} → ${result.newLevel}**`;
  else if (result.leveledDown) s += `\n📉 레벨 **${result.oldLevel} → ${result.newLevel}**`;
  if (result.appliedDelta !== result.requestedDelta) {
    s += `\n-# 요청값 ${result.requestedDelta} 중 ${result.appliedDelta}만 적용됨 (XP는 0 미만이 될 수 없음)`;
  }
  return s;
}

// ── 진입 커맨드 ──────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('xp')
    .setDescription('[관리자 전용] XP 수동 조정 · XP 시스템 긴급정지/뉴비부스트 관리.'),

  async execute(interaction) {
    if (await denyGuard(interaction)) return;
    await interaction.reply({ ...buildMenuView(), flags: MessageFlags.Ephemeral });
  },
};

// ── 유저 선택 ────────────────────────────────────────────────
async function handleXpUserSelect(interaction) {
  if (await denyGuard(interaction)) return;
  const targetId = interaction.values[0];
  await interaction.update(await buildPanel(interaction, targetId));
}

// ── 버튼 라우팅: 메뉴 분기 / XP 관리 토글 / ➕➖🔄 모달 오픈 ────
async function handleXpButton(interaction) {
  if (await denyGuard(interaction)) return;
  const [, action, targetId] = interaction.customId.split(':');

  // 첫 화면 분기
  if (action === 'menu') {
    if (targetId === 'adjust') {
      await interaction.update({ content: '조정할 유저를 선택하세요.', embeds: [], components: [buildPickRow()] });
    } else if (targetId === 'manage') {
      await interaction.update(buildManageView());
    } else if (targetId === 'home') {
      await interaction.update(buildMenuView());
    }
    return;
  }

  // XP 관리 패널
  if (action === 'mng') {
    if (targetId === 'boost') {
      const st = setXpSwitch('newbieBoostEnabled', !getXpState().newbieBoostEnabled);
      logAction(interaction, 'XP 관리', `뉴비부스트 ${st.newbieBoostEnabled ? 'ON' : 'OFF'}`);
      await interaction.update(buildManageView(`✅ 뉴비부스트를 **${st.newbieBoostEnabled ? '켰습니다' : '껐습니다'}**.`));
    } else if (targetId === 'farm' || targetId === 'game') {
      await interaction.update(buildConfirmView(targetId));
    }
    return;
  }
  if (action === 'mngno') {
    await interaction.update(buildManageView());
    return;
  }
  if (action === 'mngyes') {
    const isFarm = targetId === 'farm';
    const key = isFarm ? 'farmFrozen' : 'minigameFrozen';
    const label = isFarm ? '일반 파밍' : '미니게임';
    const next = !getXpState()[key];
    const st = setXpSwitch(key, next);
    logAction(interaction, 'XP 관리', `${label} XP ${next ? '긴급정지' : '재개'}`);
    await interaction.update(buildManageView(
      st[key] ? `🛑 **${label} XP 지급을 정지**했습니다.` : `▶️ **${label} XP 지급을 재개**했습니다.`,
    ));
    return;
  }

  if (action === 'add' || action === 'sub') {
    const modal = new ModalBuilder()
      .setCustomId(`xp:${action}Modal:${targetId}`)
      .setTitle(action === 'add' ? 'XP 추가' : 'XP 차감')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('amount')
            .setLabel(action === 'add' ? '추가할 XP (숫자)' : '차감할 XP (숫자)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder('예: 500'),
        ),
      );
    await interaction.showModal(modal);
    return;
  }

  if (action === 'level') {
    const currentLevel = levelFromXp(getXp(interaction.guildId, targetId)).level;
    const modal = new ModalBuilder()
      .setCustomId(`xp:levelModal:${targetId}`)
      .setTitle('레벨 조정')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('level')
            .setLabel('설정할 레벨 (해당 레벨 시작 XP로 맞춤)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(String(currentLevel)),
        ),
      );
    await interaction.showModal(modal);
    return;
  }
}

// ── 모달 제출 → 실제 조정 & 화면 갱신 ────────────────────────
async function handleXpModal(interaction) {
  if (await denyGuard(interaction)) return;
  const [, kind, targetId] = interaction.customId.split(':');

  if (kind === 'addModal' || kind === 'subModal') {
    const raw = interaction.fields.getTextInputValue('amount').trim().replace(/,/g, '');
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_ABS) {
      await interaction.reply({
        content: `⚠️ **1 ~ ${MAX_ABS.toLocaleString()} 사이의 정수를 입력하세요.**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const delta = kind === 'addModal' ? n : -n;
    const result = adjustXp(interaction.guildId, targetId, delta);
    persist();
    const target = await resolveTarget(interaction, targetId);
    logAction(interaction, 'XP 조정', `${target.displayName}(${targetId}) ${xpLogLine(result)}`);
    await interaction.update(buildPanelView(interaction, targetId, target, formatAdjustNotice(result)));
    return;
  }

  if (kind === 'levelModal') {
    const raw = interaction.fields.getTextInputValue('level').trim();
    const lv = Number(raw);
    if (!Number.isInteger(lv) || lv < 0 || lv > MAX_LEVEL) {
      await interaction.reply({
        content: `⚠️ **0 ~ ${MAX_LEVEL} 사이의 정수를 입력하세요.**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const result = setXp(interaction.guildId, targetId, xpForLevelStart(lv));
    persist();
    const target = await resolveTarget(interaction, targetId);
    logAction(interaction, 'XP 조정', `${target.displayName}(${targetId}) 레벨설정→${lv} : ${xpLogLine(result)}`);
    const notice =
      `🎚️ 레벨 **${result.oldLevel} → ${result.newLevel}** 로 설정\n` +
      `(누적 \`${result.oldXp}\` → \`${result.newXp}\` XP)`;
    await interaction.update(buildPanelView(interaction, targetId, target, notice));
    return;
  }
}

module.exports.handleXpUserSelect = handleXpUserSelect;
module.exports.handleXpButton = handleXpButton;
module.exports.handleXpModal = handleXpModal;
