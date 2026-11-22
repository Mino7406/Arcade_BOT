// 계정.js — /전적에서 쓰는 Riot ID 연결 저장소와 "테스트 서버 한정" 판정.
// 저장 모양: { [discordUserId]: { lol?: { puuid, name, tag }, valorant?: { name, tag, region } } }
const fs = require('fs');
const path = require('path');
const { writeJsonIfChanged } = require('../공통/저장');
const { RECORD_SEARCH_TEST_ONLY, isTestGuild } = require('../../config');

const ACCOUNTS_PATH = path.join(__dirname, '..', '..', 'DB', 'riot-accounts.json');
let accounts = {};

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
  writeJsonIfChanged(ACCOUNTS_PATH, accounts);
}

function getLinked(userId) {
  return accounts[userId] ?? null;
}

function setLinked(userId, linked) {
  accounts[userId] = { ...(accounts[userId] ?? {}), ...linked };
}

// 테스트 한정 동안은 테스트 서버(길드)에서만 true.
function canUseRecordSearch(guildId) {
  return !RECORD_SEARCH_TEST_ONLY || isTestGuild(guildId);
}

module.exports = { parseRiotId, loadRecordAccounts, saveRecordAccounts, getLinked, setLinked, canUseRecordSearch };
