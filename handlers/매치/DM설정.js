// DM설정.js — 내전/모집 DM 알림(시작 알림·마감 알림)을 받을지 유저가 직접 정하는 설정.
// 기본값은 ON이라 저장 파일에는 "끈 사람"만 남긴다(켜면 기록을 지운다).
// 게임모집 패널의 "🔔 DM 알림 설정" 버튼 → On(초록)/Off(회색) 카드. 지금 상태 쪽 버튼이 비활성화된다.
// 이 모듈은 카드·저장 헬퍼만 쓴다(공용.js 가 이 모듈을 가져다 쓰므로 순환참조 방지).

const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { card, payload, COLORS } = require('../공통/카드');
const { writeJsonIfChanged } = require('../공통/저장');

const STORE_PATH = path.join(__dirname, '..', '..', 'DB', 'dm-pref.json');
fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });

let off = new Set(); // DM 알림을 끈 유저 ID

function loadDmPrefs() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
      off = new Set(Array.isArray(saved?.off) ? saved.off.map(String) : []);
    }
  } catch (err) {
    // 읽기에 실패하면 모두 ON으로 돌아간다(끈 사람에게도 DM이 가게 됨).
    console.error('DM 알림 설정 읽기 실패(모두 ON으로 초기화됨):', err);
    off = new Set();
  }
}

function saveDmPrefs() {
  writeJsonIfChanged(STORE_PATH, { off: [...off].sort() });
}

function isDmEnabled(userId) {
  return !off.has(String(userId));
}

function setDmEnabled(userId, enabled) {
  if (enabled) off.delete(String(userId));
  else off.add(String(userId));
}

// On(초록) / Off(회색) 두 버튼. 지금 상태와 같은 쪽을 비활성화해 "눌린 상태"처럼 보이게 한다.
function buildDmSettingPayload(userId, { ephemeral = false } = {}) {
  const enabled = isDmEnabled(userId);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('dmpref:on').setLabel('ON').setEmoji('🔔').setStyle(ButtonStyle.Success).setDisabled(enabled),
    new ButtonBuilder().setCustomId('dmpref:off').setLabel('OFF').setEmoji('🔕').setStyle(ButtonStyle.Secondary).setDisabled(!enabled),
  );
  return payload(card({
    color: enabled ? COLORS.ok : COLORS.muted,
    header: '🔔 DM 알림 설정',
    sub: ['내전 · 모집', enabled ? '🟢 ON' : '⚪ OFF'],
    blocks: [
      enabled
        ? '**지금은 DM 알림을 받는 상태예요.**\n주최자가 예약한 시작 알림(참가한 내전/모집)과, 내가 연 모집의 마감 알림을 DM으로 알려드려요.'
        : '**지금은 DM 알림을 받지 않는 상태예요.**\n주최자가 예약한 시작 알림과 내가 연 모집의 마감 알림 DM이 모두 오지 않아요. 게시글은 그대로 확인할 수 있어요.',
    ],
    footer: '아래 버튼으로 언제든 바꿀 수 있어요. (기본값은 ON)',
    rows: [row],
  }), { ephemeral });
}

// 버튼 한 번에 설정을 바꾸고 같은 카드를 새 상태로 갱신한다.
async function handleDmSettingButton(interaction) {
  const enabled = interaction.customId === 'dmpref:on';
  setDmEnabled(interaction.user.id, enabled);
  try { saveDmPrefs(); } catch (err) { console.error('DM 알림 설정 저장 실패:', err); }
  await interaction.update(buildDmSettingPayload(interaction.user.id));
}

module.exports = { loadDmPrefs, saveDmPrefs, isDmEnabled, setDmEnabled, buildDmSettingPayload, handleDmSettingButton };
