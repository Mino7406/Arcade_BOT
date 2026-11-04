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
  isUserXpFrozen,
  setUserXpFrozen,
} = require('../handlers/레벨링');
const { logAction } = require('../handlers/로그');
const { getRaidStatus, setAutoSpawn, setNextSpawnAt, forceSpawnRaid, forceEndRaid } = require('../handlers/레이드');
const { kstDateTimeString, parseKstDateTime } = require('../handlers/시간');
const { displayNameFromMember } = require('../handlers/이름');

// 한 번에 조정 가능한 XP 폭 / 레벨 상한. 오타로 터무니없는 값이 들어가는 것만 막는 안전장치.
const MAX_ABS = 10_000_000;
const MAX_LEVEL = 1000;

// 조정 전 공통 관문 — 막히면 true. 순서 주의: 권한을 먼저 봐서 비관리자에게 내부 상태를 흘리지 않는다.
// allowExcludedGuild: 레벨 데이터를 건드리지 않는 조작(레이드 소환/종료)은 테스트 서버에서도 허용.
async function denyGuard(interaction, { allowExcludedGuild = false } = {}) {
  if (!ADMIN_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ **권한이 없습니다.**', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (allowExcludedGuild && isExcludedGuild(interaction.guildId)) return false;
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

function buildActionRows(guildId, targetId) {
  const frozen = isUserXpFrozen(guildId, targetId);
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`xp:add:${targetId}`).setEmoji('➕').setLabel('XP').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`xp:sub:${targetId}`).setEmoji('➖').setLabel('XP').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`xp:level:${targetId}`).setEmoji('🔄').setLabel('레벨 조정').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`xp:freeze:${targetId}`)
        .setEmoji(frozen ? '✅' : '🚫')
        .setLabel(frozen ? '지급 재개' : '지급 정지')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
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
function buildManageView(notice, guildId) {
  const st = getXpState();
  const raid = getRaidStatus(guildId);
  const embed = new EmbedBuilder()
    .setColor(st.farmFrozen || st.minigameFrozen ? 0xED4245 : 0x57F287)
    .setDescription(
      `## 🛠️ XP 관리\n` +
      `**일반 파밍 XP** ${st.farmFrozen ? '🔴 정지됨' : '🟢 작동 중'}\n` +
      `-# 메인·TTS 채팅 · 통화방 체류 · 내전/모집 완료 보너스\n\n` +
      `**미니게임 XP** ${st.minigameFrozen ? '🔴 정지됨' : '🟢 작동 중'}\n` +
      `-# 오목 · 룰렛 · 틱택토 · 끝말잇기 · 퀴즈\n\n` +
      `**뉴비부스트(×2)** ${st.newbieBoostEnabled ? '🟢 ON' : '⚪ OFF'}\n` +
      `-# 뉴비부스트 역할의 메인·TTS·통화방 체류 XP 2배\n\n` +
      `**레이드 자동 출현** ${raid.autoSpawn ? '🟢 가동 중' : '🔴 중지됨'}\n` +
      `-# 하루~사흘마다(무작위) 놀이터에 출현 · 진행 중엔 채팅·통화방·미니게임 XP 정지\n\n` +
      raidStatusText(raid) +
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
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('xp:mng:raidauto')
          .setEmoji(raid.autoSpawn ? '⏸️' : '▶️')
          .setLabel(raid.autoSpawn ? '레이드 자동 출현 중지' : '레이드 자동 출현 가동')
          .setStyle(raid.autoSpawn ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId('xp:mng:raidtime')
          .setEmoji('🕒')
          .setLabel('출현 시각 변경')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!raid.autoSpawn), // 중지 중엔 일정이 없으니 가동부터
        raidButton(raid),
      ),
    ],
  };
}

// 레이드 상태 두 줄(진행 여부 / 다음 자동 출현 시각) — XP 관리 패널과 테스트 서버 화면이 공유.
function raidStatusText(raid) {
  const next = raid.nextSpawnAt ? Math.floor(raid.nextSpawnAt / 1000) : null;
  return `**레이드** ${raid.active ? `👾 ${raid.monsterName} 진행 중 (${raid.phase === 'recruit' ? '모집' : '전투'})` : '⚪ 대기'}\n` +
    `-# ${next ? `다음 자동 출현 <t:${next}:f> (<t:${next}:R>)` : raid.autoSpawn ? '다음 출현 일정 없음' : '자동 출현 중지 — 소환 버튼으로만 띄울 수 있어요'}`;
}

function raidButton(raid) {
  return raid.active
    ? new ButtonBuilder().setCustomId('xp:mng:raidend').setEmoji('🛑').setLabel('레이드 종료').setStyle(ButtonStyle.Danger)
    : new ButtonBuilder().setCustomId('xp:mng:raid').setEmoji('👾').setLabel('레이드 소환').setStyle(ButtonStyle.Danger);
}

// 소환/종료 후 다시 그릴 화면 — 테스트 서버면 테스트 화면, 아니면 XP 관리 패널.
function raidResultView(interaction, notice) {
  return isExcludedGuild(interaction.guildId) ? buildRaidTestView(notice, interaction.guildId) : buildManageView(notice, interaction.guildId);
}

// 레벨 시스템이 꺼진 서버(테스트 서버)에서 /xp를 쓰면 XP 조정 대신 이 화면만 보여준다.
// 레이드를 실제 서버 XP와 무관하게 시험해볼 수 있게 하기 위함(그 서버에서 띄운 레이드는
// 버튼을 누른 채널에 뜨고, 본서버 XP를 멈추지도 보상을 주지도 않는다).
function buildRaidTestView(notice, guildId) {
  const raid = getRaidStatus(guildId);
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setDescription(
      `## 🧪 레이드 테스트\n` +
      `이 서버는 레벨 시스템이 꺼져 있어 XP 조정은 할 수 없고, 레이드만 시험할 수 있어요.\n` +
      `-# 여기서 소환하면 이 채널에 뜨고, 이 서버의 놀이터 기능만 멈춰요(본서버와 따로 돌고, XP를 멈추지도 보상을 주지도 않아요).\n\n` +
      `**레이드** ${raid.active ? `👾 ${raid.monsterName} 진행 중 (${raid.phase === 'recruit' ? '모집' : '전투'})` : '⚪ 대기'}` +
      (notice ? `\n\n${notice}` : ''),
    );
  return { content: '', embeds: [embed], components: [new ActionRowBuilder().addComponents(raidButton(raid))] };
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
  const frozen = isUserXpFrozen(guildId, targetId);

  const embed = new EmbedBuilder()
    .setColor(frozen ? 0xED4245 : 0x5865F2)
    .setDescription(
      `## ⚙️ XP 조정\n` +
      `대상 : <@${targetId}> (\`${displayName}\`)` +
      (frozen ? `\n🚫 **지급 정지 중** — 자동 지급 경로(채팅·통화방·미니게임 등)에서 더 이상 XP를 받지 않습니다.` : '') +
      `\n\n**LEVEL ${level}**\n${bar}\n**${currentLevelXp} / ${neededXp}** XP　(누적 \`${xp}\` XP)` +
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
    components: [buildPickRow(targetId), ...buildActionRows(interaction.guildId, targetId)],
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
    if (await denyGuard(interaction, { allowExcludedGuild: true })) return;
    const view = isExcludedGuild(interaction.guildId) ? buildRaidTestView(undefined, interaction.guildId) : buildMenuView();
    await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
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
  const [, action, targetId] = interaction.customId.split(':');
  const isRaidAction = action === 'mng' && (targetId === 'raid' || targetId === 'raidend');
  if (await denyGuard(interaction, { allowExcludedGuild: isRaidAction })) return;

  // 첫 화면 분기
  if (action === 'menu') {
    if (targetId === 'adjust') {
      await interaction.update({ content: '조정할 유저를 선택하세요.', embeds: [], components: [buildPickRow()] });
    } else if (targetId === 'manage') {
      await interaction.update(buildManageView(undefined, interaction.guildId));
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
      await interaction.update(buildManageView(`✅ 뉴비부스트를 **${st.newbieBoostEnabled ? '켰습니다' : '껐습니다'}**.`, interaction.guildId));
    } else if (targetId === 'raidauto') {
      const raid = setAutoSpawn(!getRaidStatus(interaction.guildId).autoSpawn);
      logAction(interaction, 'XP 관리', `레이드 자동 출현 ${raid.autoSpawn ? '가동' : '중지'}`);
      await interaction.update(buildManageView(raid.autoSpawn ? '▶️ **레이드 자동 출현을 가동했습니다.**' : '⏸️ **레이드 자동 출현을 중지했습니다.**', interaction.guildId));
    } else if (targetId === 'raidtime') {
      const raid = getRaidStatus(interaction.guildId);
      if (!raid.autoSpawn) {
        await interaction.update(buildManageView('⚠️ 자동 출현이 중지돼 있어요. 먼저 가동해 주세요.', interaction.guildId));
        return;
      }
      const input = new TextInputBuilder()
        .setCustomId('when')
        .setLabel('다음 출현 시각 (한국 시간)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(30)
        .setPlaceholder('예: 2026-11-07 20:00 · 11-07 20:00 · 20:00(오늘/내일)');
      if (raid.nextSpawnAt) input.setValue(kstDateTimeString(raid.nextSpawnAt));
      await interaction.showModal(new ModalBuilder()
        .setCustomId('xp:raidTimeModal')
        .setTitle('레이드 다음 출현 시각')
        .addComponents(new ActionRowBuilder().addComponents(input)));
    } else if (targetId === 'farm' || targetId === 'game') {
      await interaction.update(buildConfirmView(targetId));
    } else if (targetId === 'raid') {
      // 본서버에서는 놀이터에, 테스트 서버에서는 이 채널에 띄운다(handlers/레이드.js의 forceSpawnRaid).
      // 출현 메시지 전송을 기다리는 동안 3초 응답 제한을 넘기지 않게 먼저 ack한다.
      await interaction.deferUpdate();
      const error = await forceSpawnRaid(interaction);
      if (!error) logAction(interaction, 'XP 관리', '레이드 수동 소환');
      await interaction.editReply(raidResultView(interaction, error ? `⚠️ ${error}` : '👾 **레이드를 소환했습니다.**'));
    } else if (targetId === 'raidend') {
      await interaction.deferUpdate();
      const ended = await forceEndRaid(interaction.guildId);
      if (ended) logAction(interaction, 'XP 관리', '레이드 강제 종료');
      await interaction.editReply(raidResultView(interaction, ended ? '🛑 **레이드를 종료했습니다.** XP 정지도 풀렸습니다.' : '⚠️ 진행 중인 레이드가 없어요.'));
    }
    return;
  }
  if (action === 'mngno') {
    await interaction.update(buildManageView(undefined, interaction.guildId));
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
      st[key] ? `🛑 **${label} XP 지급을 정지**했습니다.` : `▶️ **${label} XP 지급을 재개**했습니다.`, interaction.guildId,
    ));
    return;
  }

  if (action === 'freeze') {
    const frozen = isUserXpFrozen(interaction.guildId, targetId);
    setUserXpFrozen(interaction.guildId, targetId, !frozen);
    const target = await resolveTarget(interaction, targetId);
    logAction(interaction, 'XP 조정', `${target.displayName}(${targetId}) XP 지급 ${frozen ? '재개' : '정지'}`);
    await interaction.update(buildPanelView(interaction, targetId, target,
      frozen ? '✅ **이 유저의 XP 지급을 재개**했습니다.' : '🚫 **이 유저의 XP 지급을 정지**했습니다.',
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

  if (kind === 'raidTimeModal') {
    const raw = interaction.fields.getTextInputValue('when');
    const ms = parseKstDateTime(raw);
    const error = ms === null
      ? '시각을 알아볼 수 없어요. `2026-11-07 20:00`처럼 적어 주세요.'
      : setNextSpawnAt(ms);
    if (error) {
      await interaction.reply({ content: `⚠️ **${error}**`, flags: MessageFlags.Ephemeral });
      return;
    }
    logAction(interaction, 'XP 관리', `레이드 다음 출현 시각 변경 → ${kstDateTimeString(ms)} (KST)`);
    await interaction.update(buildManageView(`🕒 **다음 레이드 출현을 <t:${Math.floor(ms / 1000)}:f>로 바꿨습니다.**`, interaction.guildId));
    return;
  }

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
