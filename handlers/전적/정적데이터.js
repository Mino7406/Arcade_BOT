// 정적데이터.js — Riot Data Dragon·CommunityDragon의 챔피언·아이템·스펠·룬 이름과 아이콘.
// 아이콘은 처음 쓸 때 내려받아 dir 아래에 PNG 로 두고, 다음부터는 디스크에서 읽는다. 실패하면 null(오류를 던지지 않음).
const fs = require('fs');
const path = require('path');
const { decodePng } = require('../공통/이모지그림');
const { encodePng, boxResize } = require('./아이콘');

const DD = 'https://ddragon.leagueoflegends.com';
const CD_EMBLEM = 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem';
const VERSION_TTL_MS = 24 * 3600 * 1000;
const EMBLEM_SIZE = 128;

// 투명한 여백을 잘라 정사각형으로 만든 뒤 maxSize 이하로 줄인 PNG. 엠블럼(1280×720)·발로란트 요원(1024×1024)처럼 큰 원본을
// 그대로 읽으면 한 번에 수 MB 를 쓰므로 내려받을 때 한 번만 줄여서 저장한다.
function shrinkPng(buf, maxSize) {
  const src = decodePng(buf);
  let x0 = src.w, y0 = src.h, x1 = -1, y1 = -1;
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    if (src.data[(y * src.w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = src.w - 1; y1 = src.h - 1; }
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const sx = Math.round((x0 + x1 + 1) / 2 - side / 2), sy = Math.round((y0 + y1 + 1) / 2 - side / 2);
  const square = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const ox = sx + x, oy = sy + y;
    if (ox < 0 || oy < 0 || ox >= src.w || oy >= src.h) continue;
    src.data.copy(square, (y * side + x) * 4, (oy * src.w + ox) * 4, (oy * src.w + ox) * 4 + 4);
  }
  const out = Math.min(maxSize, side);
  const small = boxResize(square, side, side, out, out);
  const bytes = Buffer.alloc(out * out * 4);
  for (let i = 0; i < out * out; i++) {
    bytes[i * 4] = Math.round(small[i * 4]); bytes[i * 4 + 1] = Math.round(small[i * 4 + 1]);
    bytes[i * 4 + 2] = Math.round(small[i * 4 + 2]); bytes[i * 4 + 3] = Math.round(small[i * 4 + 3] * 255);
  }
  return encodePng(bytes, out, out);
}

function createStatic({ fetchJson, fetchBuffer, dir }) {
  // 옛 버전 아이콘 폴더(예: 16.22.1)는 지운다 — 패치마다 쌓이면 디스크 512MB 를 먹는다. 엠블럼·발로란트 폴더는 버전과 무관해서 남긴다.
  function removeOldVersions(current) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name) && e.name !== current) fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
      }
    } catch { /* 폴더가 아직 없으면 지울 것도 없다 */ }
  }

  let version = null, versionAt = 0;
  let champNames = {}, spellFiles = {}, runeIcons = {}, styleIcons = {};
  let loadedFor = null;

  async function getVersion() {
    if (!version || Date.now() - versionAt > VERSION_TTL_MS) {
      version = (await fetchJson(`${DD}/api/versions.json`))[0];
      versionAt = Date.now();
      removeOldVersions(version);
    }
    return version;
  }

  // 이름·번호 표를 불러온다(버전이 바뀌면 다시). 못 불러와도 던지지 않는다 — 이름은 영문, 아이콘은 null 로 대신한다.
  async function load() {
    try {
      const v = await getVersion();
      if (loadedFor === v) return;
      const [champs, spells, runes] = await Promise.all([
        fetchJson(`${DD}/cdn/${v}/data/ko_KR/champion.json`),
        fetchJson(`${DD}/cdn/${v}/data/ko_KR/summoner.json`),
        fetchJson(`${DD}/cdn/${v}/data/ko_KR/runesReforged.json`),
      ]);
      champNames = Object.fromEntries(Object.values(champs.data).map(c => [c.id, c.name]));
      spellFiles = Object.fromEntries(Object.values(spells.data).map(s => [Number(s.key), s.image.full]));
      runeIcons = {}; styleIcons = {};
      for (const tree of runes) {
        styleIcons[tree.id] = tree.icon;
        for (const slot of tree.slots) for (const r of slot.runes) runeIcons[r.id] = r.icon;
      }
      loadedFor = v;
    } catch (err) {
      console.error('Data Dragon 정보를 불러오지 못했어요(영문 이름·아이콘 없이 표시):', err?.message ?? err);
    }
  }

  const champName = key => champNames[key] ?? key;

  function sourceOf(kind, key, v) {
    switch (kind) {
      case 'champion': return `${DD}/cdn/${v}/img/champion/${key}.png`;
      case 'item': return `${DD}/cdn/${v}/img/item/${key}.png`;
      case 'profile': return `${DD}/cdn/${v}/img/profileicon/${key}.png`;
      case 'spell': return spellFiles[key] ? `${DD}/cdn/${v}/img/spell/${spellFiles[key]}` : null;
      case 'rune': return runeIcons[key] ? `${DD}/cdn/img/${runeIcons[key]}` : null;
      case 'style': return styleIcons[key] ? `${DD}/cdn/img/${styleIcons[key]}` : null;
      case 'emblem': return `${CD_EMBLEM}/emblem-${String(key).toLowerCase()}.png`;
      default: return null;
    }
  }

  // 아이콘 파일 경로. 디스크에 없으면 내려받아 저장한다. 실패는 null.
  async function iconFile(kind, key) {
    try {
      const v = await getVersion();
      const file = kind === 'emblem'
        ? path.join(dir, 'emblem', `${String(key).toLowerCase()}.png`) // 엠블럼은 버전과 무관
        : path.join(dir, v, kind, `${key}.png`);
      if (fs.existsSync(file)) return file;
      const url = sourceOf(kind, key, v);
      if (!url) return null;
      let data = await fetchBuffer(url);
      if (kind === 'emblem') data = shrinkPng(data, EMBLEM_SIZE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      return file;
    } catch {
      return null;
    }
  }

  // 주소가 정해진 아이콘(발로란트 티어·요원 등)을 dir/<kind>/<key>.png 로 내려받아 둔다. size 를 주면 그 크기 이하로 줄여 저장한다. 실패는 null.
  async function urlIcon(kind, key, url, { size } = {}) {
    try {
      const file = path.join(dir, kind, `${String(key).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`);
      if (fs.existsSync(file)) return file;
      let data = await fetchBuffer(url);
      if (size) data = shrinkPng(data, size);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      return file;
    } catch {
      return null;
    }
  }

  return { load, version: getVersion, champName, iconFile, urlIcon };
}

module.exports = { createStatic };
