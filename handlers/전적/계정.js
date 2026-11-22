// 계정.js — /전적에서 쓰는 Riot ID 연결 저장소와 "테스트 서버 한정" 판정.
// 저장 모양: { [discordUserId]: { lol?: { puuid, name, tag }, valorant?: { name, tag, region } } }
const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../공통/저장');
const { RECORD_SEARCH_TEST_ONLY, RECORD_SEARCH_CHANNEL_IDS, isTestGuild } = require('../../config');
const { isTempVoiceChannel } = require('../레벨/음성채널');

const ACCOUNTS_PATH = path.join(__dirname, '..', '..', 'DB', 'riot-accounts.json');
let accounts = {};
let dirty = false; // 마지막 저장 뒤 바뀌었나

// "이름#태그" → { name, tag }. 이름 3~16자(공백·한글 허용), 태그 3~5자(영문·숫자). 틀리면 null.
function parseRiotId(text) {
  if (typeof text !== 'string') return null;
  const i = text.lastIndexOf('#');
  if (i < 0) return null;
  const name = text.slice(0, i).trim();
  const tag = text.slice(i + 1).trim();
  if (name.length < 3 || name.length > 16) return null;
  if (!/^[A-Za-z0-9]{3,5}$/.test(tag)) return null;
  return { name, tag };
}

function loadRecordAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_PATH)) accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  } catch (err) {
    console.error('전적 계정 연결 읽기 실패(연결 정보가 초기화됨):', err);
    accounts = {};
  }
}

function saveRecordAccounts() {
  if (!dirty) return;
  writeJsonIfChanged(ACCOUNTS_PATH, accounts);
  dirty = false;
}

function getLinked(userId) {
  return accounts[userId] ?? null;
}

function setLinked(userId, linked) {
  accounts[userId] = { ...(accounts[userId] ?? {}), ...linked };
  dirty = true;
}

// 테스트 한정 동안은 테스트 서버(길드)에서만 true.
function canUseRecordSearch(guildId) {
  return !RECORD_SEARCH_TEST_ONLY || isTestGuild(guildId);
}

// 이 채널에서 /전적을 쓸 수 있나: 테스트 서버는 어디서나, 그 밖에는 메인·TTS 채팅과 임시 음성채널 채팅방에서만.
function canUseRecordChannel(guildId, channelId) {
  return isTestGuild(guildId) || RECORD_SEARCH_CHANNEL_IDS.includes(channelId) || isTempVoiceChannel(channelId);
}

module.exports = { canUseRecordChannel, parseRiotId, loadRecordAccounts, saveRecordAccounts, getLinked, setLinked, canUseRecordSearch };
