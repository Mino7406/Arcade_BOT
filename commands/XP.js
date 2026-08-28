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
  EXCLUDED_GUILD_IDS,
} = require('../handlers/레벨');
const { logAction } = require('../handlers/로그');

// 한 번에 조정 가능한 XP 폭 / 레벨 상한. 오타로 터무니없는 값이 들어가는 것만 막는 안전장치.
const MAX_ABS = 10_000_000;
const MAX_LEVEL = 1000;

// 조정 전 공통 관문 — 막히면 true. 순서 주의: 권한을 먼저 봐서 비관리자에게 내부 상태를 흘리지 않는다.
async function denyGuard(interaction) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', ephemeral: true });
    return true;
  }
  if (EXCLUDED_GUILD_IDS.includes(interaction.guildId)) {
    await interaction.reply({ content: '⚠️ **이 서버는 레벨 시스템이 비활성화돼 있어 XP를 조정할 수 없습니다.**', ephemeral: true });
    return true;
  }
  if (!isLevelsLoaded()) {
    // 복원 전에는 levels가 빈 객체라, 여기서 조정+저장하면 levels.json이 통째로 비워진다.
    await interaction.reply({ content: '⚠️ **레벨 데이터를 복원하는 중입니다. 잠시 후 다시 시도하세요.**', ephemeral: true });
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
  const displayName = member?.displayName || user?.globalName || user?.username || '알 수 없는 유저';
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
    .setDescription('[관리자 전용] 유저의 XP/레벨을 버튼으로 수동 조정합니다.'),

  async execute(interaction) {
    if (await denyGuard(interaction)) return;
    await interaction.reply({
      content: '조정할 유저를 선택하세요.',
      components: [buildPickRow()],
      ephemeral: true,
    });
  },
};

// ── 유저 선택 ────────────────────────────────────────────────
async function handleXpUserSelect(interaction) {
  if (await denyGuard(interaction)) return;
  const targetId = interaction.values[0];
  await interaction.update(await buildPanel(interaction, targetId));
}

// ── 버튼(➕/➖/🎚️) → 모달 오픈 ───────────────────────────────
async function handleXpButton(interaction) {
  if (await denyGuard(interaction)) return;
  const [, action, targetId] = interaction.customId.split(':');

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
        ephemeral: true,
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
        ephemeral: true,
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
