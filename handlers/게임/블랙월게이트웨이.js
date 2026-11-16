// 블랙월게이트웨이.js — ??? 레이드 MVP 보상 아이템 "블랙월 게이트웨이".
// 한 명을 골라 GATEWAY_FREEZE_MS(1시간) 동안 XP 지급을 멈춘다(레벨링 freezeUserXpFor — 메시지·통화방·미니게임 등 모든 자동 지급).
// 서버(길드)별로 따로 센다. 지급·사용이 드물어 바뀔 때마다 바로 저장한다. 사용은 새 명령 없이 /레벨 카드의 "블랙월 게이트웨이 사용" 버튼에서.

const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, MessageFlags } = require('discord.js');
const { writeJsonIfChanged } = require('../공통/저장');
const { logSystem } = require('../공통/로그');
const { card, payload: cardPayload, notice } = require('../공통/카드');
const { freezeUserXpFor, userXpFrozenUntil, isExcludedGuild } = require('../레벨/레벨링');

const GATEWAY_NAME = '블랙월 게이트웨이';
// 이모지는 assets/이모지/blackwall.png 를 봇의 앱 이모지로 등록해 쓴다(봇이 켜질 때 ensureGatewayEmoji). 등록 전이거나 실패하면 🌐로 보인다.
// 그림을 바꾸면 name 의 _v 숫자를 올려 새로 등록되게 한다.
const EMOJI = { name: 'blackwall_v1', file: 'blackwall.png', fallback: '🌐', id: null };
const EMOJI_DIR = path.join(__dirname, '..', '..', 'assets', '이모지');
async function ensureGatewayEmoji(client) {
  const manager = client.application?.emojis;
  if (!manager) return false;
  try {
    const list = await manager.fetch();
    let emoji = list.find(x => x.name === EMOJI.name);
    if (!emoji) {
      emoji = await manager.create({ attachment: path.join(EMOJI_DIR, EMOJI.file), name: EMOJI.name });
      logSystem({ 유형: '봇 상태', 내용: `${GATEWAY_NAME} 앱 이모지 등록 (${EMOJI.name})` });
    }
    EMOJI.id = emoji.id;
    return true;
  } catch (err) {
    console.error(`${GATEWAY_NAME} 이모지 준비 실패(대신 🌐로 표시):`, err);
    return false;
  }
}
// 글자 안에 넣는 이모지(<:이름:id>) — 등록 전이면 🌐
const gatewayEmoji = () => (EMOJI.id ? `<:${EMOJI.name}:${EMOJI.id}>` : EMOJI.fallback);
// 화면 모음(tests/카드화면.js)처럼 봇 없이 그릴 때 이모지 자리를 채우는 용도
const setGatewayEmojiId = (id) => { EMOJI.id = id; };
// 버튼 setEmoji 용 값
const gatewayButtonEmoji = () => (EMOJI.id ? { id: EMOJI.id, name: EMOJI.name } : EMOJI.fallback);
const GATEWAY_FREEZE_MS = 60 * 60 * 1000;
const GATEWAY_PATH = path.join(__dirname, '..', '..', 'DB', 'gateway.json');

let items = {}; // { [guildId]: { [userId]: 보유 개수 } }

function loadGateways() {
  try {
    if (fs.existsSync(GATEWAY_PATH)) items = JSON.parse(fs.readFileSync(GATEWAY_PATH, 'utf8')) || {};
  } catch (err) {
    console.error('블랙월 게이트웨이 기록 읽기 실패(보유량이 초기화됨):', err);
    logSystem({ 유형: '저장 오류', 내용: `gateway.json 읽기 실패 — 블랙월 게이트웨이 보유량 초기화됨: ${err?.message ?? err}` });
    items = {};
  }
}
function saveGateways() {
  try {
    fs.mkdirSync(path.dirname(GATEWAY_PATH), { recursive: true });
    writeJsonIfChanged(GATEWAY_PATH, items);
  } catch (err) {
    console.error('블랙월 게이트웨이 저장 실패:', err);
    logSystem({ 유형: '저장 오류', 내용: `gateway.json 저장 실패: ${err?.message ?? err}` });
  }
}
const getGateways = (guildId, userId) => items[guildId]?.[userId] ?? 0;
function setCount(guildId, userId, n) {
  if (!items[guildId]) items[guildId] = {};
  if (n > 0) items[guildId][userId] = n; else delete items[guildId][userId];
}
function grantGateway(guildId, userId) {
  setCount(guildId, userId, getGateways(guildId, userId) + 1);
  saveGateways();
  return true;
}
function useGateway(guildId, userId) {
  const have = getGateways(guildId, userId);
  if (have <= 0) return false;
  setCount(guildId, userId, have - 1);
  saveGateways();
  return true;
}

// ── /블랙월: 보유 개수 + 대상 고르기 → 확인 → 사용 ─────────────────────
function menuView(guildId, userId, message = null) {
  const have = getGateways(guildId, userId);
  const blocks = [{ text: `${gatewayEmoji()} **${GATEWAY_NAME}** 보유 **${have}개**\n-# 한 명을 골라 **1시간 동안 XP 지급을 멈춥니다**(채팅·통화방·미니게임 전부).` }];
  if (message) blocks.unshift({ text: message });
  const rows = have > 0
    ? [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('gateway:pick').setPlaceholder('XP를 멈출 사람 고르기').setMinValues(1).setMaxValues(1))]
    : [];
  return cardPayload(card({ color: 'info', top: '-# 🌐 **블랙월 게이트웨이**', header: have > 0 ? '누구의 XP를 멈출까요?' : '아이템이 없어요', headerLevel: 3, blocks, rows }), { ephemeral: true });
}
// /레벨 카드의 버튼 → 나에게만 보이는 새 메시지로 대상 고르기 화면
async function openMenu(interaction) {
  await interaction.reply(menuView(interaction.guildId, interaction.user.id));
}

// 유저 선택 → 확인 화면
async function handleGatewayPick(interaction) {
  const targetId = interaction.values[0];
  const target = interaction.users?.get(targetId) ?? interaction.members?.get(targetId)?.user;
  if (getGateways(interaction.guildId, interaction.user.id) <= 0) { await interaction.update(menuView(interaction.guildId, interaction.user.id)); return; }
  if (target?.bot) { await interaction.update(menuView(interaction.guildId, interaction.user.id, '🤖 봇에게는 쓸 수 없어요.')); return; }
  if (targetId === interaction.user.id) { await interaction.update(menuView(interaction.guildId, interaction.user.id, '🙅 자기 자신에게는 쓸 수 없어요.')); return; }
  const until = userXpFrozenUntil(interaction.guildId, targetId);
  const already = until ? `\n-# 이미 멈춰 있어요(<t:${Math.floor(until / 1000)}:R>까지) — 더 늦게 풀리는 쪽으로 남아요` : '';
  await interaction.update(cardPayload(card({
    color: 'warn',
    top: '-# 🌐 **블랙월 게이트웨이**',
    header: `<@${targetId}>의 XP를 1시간 멈출까요?`,
    headerLevel: 3,
    blocks: [{ text: `${gatewayEmoji()} ${GATEWAY_NAME} 1개를 씁니다. 되돌릴 수 없어요.${already}` }],
    rows: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gateway:use:${targetId}`).setLabel('사용').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('gateway:cancel').setLabel('취소').setStyle(ButtonStyle.Secondary),
    )],
  }), { ephemeral: true }));
}

async function handleGatewayButton(interaction) {
  const [, kind, arg] = interaction.customId.split(':');
  if (kind === 'open') { await openMenu(interaction); return; }
  if (kind === 'cancel') { await interaction.update(menuView(interaction.guildId, interaction.user.id)); return; }
  if (kind !== 'use') return;
  const guildId = interaction.guildId, userId = interaction.user.id;
  if (!useGateway(guildId, userId)) { await interaction.update(menuView(guildId, userId, '⚠️ 아이템이 없어요.')); return; }
  // 레벨 시스템이 없는 서버(테스트 서버)는 실제로 멈추지 않고 문구만 — 아이템은 소모된다
  const until = isExcludedGuild(guildId) ? Date.now() + GATEWAY_FREEZE_MS : freezeUserXpFor(guildId, arg, GATEWAY_FREEZE_MS);
  logSystem({ 유형: '아이템', 내용: `${GATEWAY_NAME} 사용 — <@${userId}> → <@${arg}> XP 1시간 정지${isExcludedGuild(guildId) ? ' (테스트 서버: 실제 정지 없음)' : ''}` });
  await interaction.update(cardPayload(card({
    color: 'ok',
    top: '-# 🌐 **블랙월 게이트웨이**',
    header: `<@${arg}>의 XP 지급이 멈췄습니다`,
    headerLevel: 3,
    blocks: [{ text: `⏱️ <t:${Math.floor(until / 1000)}:R> 풀려요 · 남은 ${GATEWAY_NAME} **${getGateways(guildId, userId)}개**` }],
  }), { ephemeral: true }));
}

module.exports = { GATEWAY_NAME, gatewayEmoji, ensureGatewayEmoji, setGatewayEmojiId, GATEWAY_FREEZE_MS, loadGateways, saveGateways, getGateways, grantGateway, useGateway, openMenu, menuView, gatewayButtonEmoji, handleGatewayPick, handleGatewayButton };
