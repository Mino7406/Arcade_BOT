// 메뉴.js — 내전/모집/팀/불러오기의 "처음 뜨는 선택 화면"(게임 고르기, 내전 고르기, 다시 올릴 항목 고르기).
// 슬래시 명령(commands/매치/)과 안내 패널 버튼(index.js)이 같은 화면을 쓰도록 한곳에 모았다.

const { ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { menu, notice } = require('../공통/카드');
const { GAME_EMOJIS, OWNER_IDS } = require('../../config');
const { buildMatchSelectMenu } = require('./팀');

// 안내 패널의 "내전 생성" 버튼(index.js)에서도 재사용하기 위해 페이로드 생성 로직을 분리.
// 코블몬 토너먼트는 OWNER_IDS에 든 사람이 열었을 때만 선택지에 넣는다.
function buildNaejeonGameSelectPayload(userId) {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('naejeon:game_select')
    .setPlaceholder('게임을 선택하세요')
    .addOptions([
      { label: '리그 오브 레전드', value: 'lol',       emoji: { id: GAME_EMOJIS.lol } },
      { label: '발로란트',         value: 'valorant',  emoji: { id: GAME_EMOJIS.valorant } },
      { label: '오버워치',         value: 'overwatch', emoji: { id: GAME_EMOJIS.overwatch } },
      { label: '배틀그라운드',     value: 'pubg',      emoji: { id: GAME_EMOJIS.pubg } },
      { label: '직접 입력',        value: 'custom',    emoji: '✏️' },
    ]);
  if (OWNER_IDS.includes(userId)) {
    selectMenu.addOptions({ label: '코블몬 토너먼트', value: 'cobblemon', emoji: { id: GAME_EMOJIS.cobblemon } });
  }

  return menu({ header: '⚔️ 내전 생성', note: '어떤 게임의 내전을 만들까요?', rows: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
}

// 안내 패널의 "모집 생성" 버튼(index.js)에서도 재사용하기 위해 페이로드 생성 로직을 분리.
function buildMojipGameSelectPayload() {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('mojip:game_select')
    .setPlaceholder('게임을 선택하세요')
    .addOptions([
      { label: '리그 오브 레전드', value: 'lol',       emoji: { id: GAME_EMOJIS.lol } },
      { label: '발로란트',         value: 'valorant',  emoji: { id: GAME_EMOJIS.valorant } },
      { label: '오버워치',         value: 'overwatch', emoji: { id: GAME_EMOJIS.overwatch } },
      { label: '배틀그라운드',     value: 'pubg',      emoji: { id: GAME_EMOJIS.pubg } },
      { label: '직접 입력',        value: 'custom',    emoji: '✏️' },
    ]);

  return menu({ header: '📋 모집 생성', note: '어떤 게임의 모집을 만들까요?', rows: [new ActionRowBuilder().addComponents(selectMenu)], ephemeral: true });
}

// 안내 패널의 "팀 관리" 버튼(index.js)에서도 재사용하기 위해 페이로드 생성 로직을 분리.
function buildTeamMatchListPayload(interaction) {
  const matches = interaction.client.naejeonMatches;

  if (!matches || matches.size === 0) {
    return notice('⚠️ **활성화된 내전이 없습니다.**', { ephemeral: true });
  }

  const validMatches = [...matches.entries()].filter(([, m]) => m.guildId === interaction.guildId && m.participants.length >= 2);

  if (validMatches.length === 0) {
    return notice('⚠️ **참가자가 2명 이상인 내전이 없습니다.**', { ephemeral: true });
  }

  return menu({ header: '🛠️ 팀 관리', note: '어느 내전의 팀을 관리할까요?', rows: [new ActionRowBuilder().addComponents(buildMatchSelectMenu(validMatches))], ephemeral: true });
}

// 안내 패널의 "불러오기" 버튼(index.js)에서도 재사용하기 위해 페이로드 생성 로직을 분리.
// naejeonMatches/mojipMatches가 길드별로 client에 실려있기 때문에 interaction이 필요하다.
function buildReloadListPayload(interaction) {
  const naejeons = interaction.client.naejeonMatches || new Map();
  const mojips   = interaction.client.mojipMatches   || new Map();

  const options = [];
  for (const [msgId, match] of naejeons) {
    if (match.guildId !== interaction.guildId) continue;
    options.push({
      label:       `[내전] ${match.data.title}`.slice(0, 100),
      description: `${match.data.organizer?.displayName ?? '?'} · ${match.data.datetime} · ${match.closed ? '🔒 마감됨' : '🟢 모집 중'}`.slice(0, 100),
      value:       `naejeon:${msgId}`,
    });
  }
  for (const [msgId, match] of mojips) {
    if (match.guildId !== interaction.guildId) continue;
    options.push({
      label:       `[모집] ${match.data.title}`.slice(0, 100),
      description: `${match.data.organizer?.displayName ?? '?'} · ${match.data.datetime} · ${match.closed ? '🔒 마감됨' : '🟢 모집 중'}`.slice(0, 100),
      value:       `mojip:${msgId}`,
    });
  }

  if (options.length === 0) {
    return notice('⚠️ **진행 중인 내전/모집이 없습니다.**', { ephemeral: true });
  }

  return menu({
    header: '🔎 불러오기',
    note: '채팅에 묻힌 내전/모집을 다시 끌어올립니다. 다시 게시할 항목을 선택하세요.',
    rows: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('reload:select')
          .setPlaceholder('내전 / 모집 선택...')
          .addOptions(options.slice(0, 25)),
      ),
    ],
    ephemeral: true,
  });
}

module.exports = {
  buildNaejeonGameSelectPayload,
  buildMojipGameSelectPayload,
  buildTeamMatchListPayload,
  buildReloadListPayload,
};
