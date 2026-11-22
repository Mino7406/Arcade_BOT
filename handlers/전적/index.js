// 전적/index.js — /전적 명령의 상호작용: 나에게만 보이는 선택창([롤] [발로란트] [계정 연결]) → 채널에 공개되는 전적 이미지.
// 지금은 테스트 서버에서만 쓸 수 있다(config.js 의 RECORD_SEARCH_TEST_ONLY). 외부 서비스는 createRecordHandlers 로 주입해서 테스트한다.
//
// customId 규칙(100자 이하):
//   record:lol:<대상>   record:val:<대상>   — 대상: me | u:<디스코드 유저 id> (none 은 멤버를 고르기 전의 회색 버튼)
//   record:pick         — 다른 사람 전적의 멤버 선택 메뉴
//   record:link / record:link_modal — 계정 연결 모달 열기 / 제출
//   record:find / record:find_modal — 닉네임으로 검색 모달 열기 / 제출
//   record:q:lol:<all|solo|flex>:<puuid> — 롤 이미지의 큐 탭
const path = require('path');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, MessageFlags,
} = require('discord.js');
const accounts = require('./계정');
const { parseRiotId } = accounts;
const { createLimiter } = require('./요청대기열');
const { createRiotClient, RiotError, riotErrorMessage } = require('./리오트');
const { createMatchStore } = require('./경기저장');
const { createStatic } = require('./정적데이터');
const { createLolService } = require('./롤');
const { createValorantService } = require('./발로');
const { fetchValorant } = require('./헨릭');
const { card, payload, menu, notice } = require('../공통/카드');

const EPHEMERAL = MessageFlags.Ephemeral;
const NOT_READY = '🚧 전적 검색은 아직 준비 중이에요.';
const WRONG_CHANNEL = '이 채널에서는 /전적을 쓸 수 없어요. 메인 채팅, TTS 채팅, 임시 음성채널 채팅에서 사용해 주세요.';
const QUEUE_TABS = [['all', '전체'], ['solo', '솔로랭크'], ['flex', '자유랭크']];
const eph = content => notice(content, { ephemeral: true }); // 나에게만 보이는 안내 카드(프로젝트의 v2 카드 형식)
const ACCENT = { lol: 0x3b82f6, valorant: 0xff4655 };
// 앱 이모지(개발자 포털에 올려 둔 롤·발로란트 로고)
const EMOJI = { lol: { id: '1510933684750913626', name: 'Lol' }, valorant: { id: '1510933698349109268', name: 'Val' } };

// 전적 이미지 한 장(또는 그림을 못 그릴 때 글자)을 카드 메시지로 만든다. row 는 카드 안에 들어갈 버튼 줄.
function resultPayload(res, game, row) {
  const rows = row ? [row] : [];
  if (!res.png) return payload(card({ color: ACCENT[game], blocks: [res.text], rows }));
  return { ...payload(card({ color: ACCENT[game], blocks: [{ image: 'attachment://record.png' }], rows })), files: [new AttachmentBuilder(res.png, { name: 'record.png' })] };
}

function createRecordHandlers({ canUse, canUseHere, getLinked, setLinked, save, lol, valorant, verifyLol, verifyValorant }) {
  // 쓸 수 없는 곳이면 안내 문구, 쓸 수 있으면 null(서버 한정 → 채널 제한 순서)
  const blockedMessage = i => (!canUse(i.guildId) ? NOT_READY : !canUseHere(i.guildId, i.channelId) ? WRONG_CHANNEL : null);
  const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  const queueRow = (puuid, current) => new ActionRowBuilder().addComponents(
    QUEUE_TABS.map(([q, label]) => button(`record:q:lol:${q}:${puuid}`, label, q === current ? ButtonStyle.Primary : ButtonStyle.Secondary)));

  // 선택 카드 한 장: 구분선으로 "내 전적 / 다른 사람 전적"을 나눈다. pickedId 가 있으면 그 멤버용 버튼이 켜진다.
  function selectCard(pickedId, ephemeral) {
    const mine = new ActionRowBuilder().addComponents(
      button('record:lol:me', '롤', ButtonStyle.Primary).setEmoji(EMOJI.lol),
      button('record:val:me', '발로란트', ButtonStyle.Danger).setEmoji(EMOJI.valorant),
      button('record:link', '계정 연결').setEmoji('🔗'));
    const pick = new UserSelectMenuBuilder().setCustomId('record:pick').setPlaceholder('👤 멤버를 골라 주세요').setMinValues(1).setMaxValues(1);
    if (pickedId) pick.setDefaultUsers(pickedId);
    const others = new ActionRowBuilder().addComponents(
      button(pickedId ? `record:lol:u:${pickedId}` : 'record:lol:none', '롤', ButtonStyle.Primary).setEmoji(EMOJI.lol).setDisabled(!pickedId),
      button(pickedId ? `record:val:u:${pickedId}` : 'record:val:none', '발로란트', ButtonStyle.Danger).setEmoji(EMOJI.valorant).setDisabled(!pickedId),
      button('record:find', '닉네임으로 검색').setEmoji('🔍'));
    return payload(card({
      color: 'info', header: '📊 전적 검색', sub: '롤 · 발로란트',
      blocks: ['### 🙋 내 전적', { rows: [mine] }, '### 👥 다른 사람 전적', { rows: [new ActionRowBuilder().addComponents(pick), others] }],
    }), { ephemeral });
  }

  // /전적 → 나에게만 보이는 선택 카드
  async function startRecordCommand(interaction) {
    const blocked = blockedMessage(interaction);
    if (blocked) return interaction.reply(eph(blocked));
    return interaction.reply(selectCard(null, true));
  }

  // 멤버 선택 메뉴: 같은 카드를 그 멤버용 버튼이 켜진 모습으로 바꾼다
  async function handleRecordSelect(interaction) {
    const blocked = blockedMessage(interaction);
    if (blocked) return interaction.reply(eph(blocked));
    return interaction.update(selectCard(interaction.values[0], false));
  }

  // 대상 키(me | u:<id>) → 조회할 계정. 연결이 없으면 target 이 null.
  function resolveTarget(key, userId, game) {
    const ownerId = key.startsWith('u:') ? key.slice(2) : userId;
    const acc = getLinked(ownerId)?.[game];
    if (!acc) return { target: null, own: ownerId === userId };
    return { target: game === 'lol' ? { name: acc.name, tag: acc.tag, puuid: acc.puuid } : { name: acc.name, tag: acc.tag }, own: ownerId === userId };
  }

  async function postResult(interaction, res, game, row) {
    if (!res.ok) return interaction.followUp(eph(res.message));
    try {
      await interaction.channel.send(resultPayload(res, game, row));
    } catch (err) {
      console.error('전적 이미지를 올리지 못함:', err);
      await interaction.followUp(eph('이미지를 올리지 못했어요. 봇이 이 채널에 파일을 올릴 수 있는지 확인해 주세요.'));
    }
  }

  async function handleRecordButton(interaction) {
    const blocked = blockedMessage(interaction);
    if (blocked) return interaction.reply(eph(blocked));
    const parts = interaction.customId.split(':');
    const action = parts[1];

    if (action === 'link') {
      const input = (id, label) => new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setPlaceholder('이름#태그 (예: Mino#KR1)').setRequired(false).setMaxLength(30));
      return interaction.showModal(new ModalBuilder().setCustomId('record:link_modal').setTitle('게임 계정 연결')
        .addComponents(input('lol', '롤 Riot ID (비워두면 연결 안 함)'), input('valorant', '발로란트 Riot ID (비워두면 연결 안 함)')));
    }

    if (action === 'find') {
      const input = (id, label) => new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setPlaceholder('이름#태그 (예: Mino#KR1)').setRequired(false).setMaxLength(30));
      return interaction.showModal(new ModalBuilder().setCustomId('record:find_modal').setTitle('닉네임으로 전적 검색')
        .addComponents(input('lol', '롤 Riot ID (비워두면 조회 안 함)'), input('valorant', '발로란트 Riot ID (비워두면 조회 안 함)')));
    }

    if (action === 'q') { // 롤 이미지의 큐 탭: 같은 메시지를 새 이미지로 바꾼다
      const queue = parts[3], puuid = parts[4];
      await interaction.deferUpdate();
      const res = await lol.lookup({ puuid }, queue);
      if (!res.ok) return interaction.followUp(eph(res.message));
      return interaction.editReply(resultPayload(res, 'lol', queueRow(res.puuid ?? puuid, queue))); // 첨부를 비우고 새 그림으로 바꾼다
    }

    if (action === 'lol' || action === 'val') {
      const game = action === 'lol' ? 'lol' : 'valorant';
      const { target, own } = resolveTarget(parts.slice(2).join(':'), interaction.user.id, game);
      if (!target) {
        const name = game === 'lol' ? '롤' : '발로란트';
        return interaction.reply(eph(own ? `아직 ${name} 계정이 연결되지 않았어요. [계정 연결]을 눌러 먼저 연결해 주세요.` : `그 멤버는 아직 ${name} 계정을 연결하지 않았어요. [닉네임으로 검색]으로 직접 찾아보세요.`));
      }
      await interaction.deferUpdate();
      const res = await (game === 'lol' ? lol : valorant).lookup(target, 'all');
      return postResult(interaction, res, game, game === 'lol' && res.ok && res.png ? queueRow(res.puuid, 'all') : null);
    }
  }

  async function checkOne(label, text, verify) {
    const id = parseRiotId(text);
    if (!id) return { error: `${label}: 이름#태그 형식으로 적어 주세요. (예: Mino#KR1)` };
    try {
      return { account: await verify(id.name, id.tag) };
    } catch (err) {
      return { error: `${label}: ${err instanceof RiotError ? riotErrorMessage(err) : '확인하지 못했어요. 잠시 후 다시 해 주세요.'}` };
    }
  }

  // 닉네임으로 검색 모달 제출: 채운 게임의 전적을 이름으로 조회해 채널에 올린다(연결 불필요).
  async function handleFind(interaction) {
    const lolText = interaction.fields.getTextInputValue('lol').trim();
    const valText = interaction.fields.getTextInputValue('valorant').trim();
    if (!lolText && !valText) return interaction.editReply({ content: '롤이나 발로란트 중 하나 이상 입력해 주세요.' });
    const jobs = [['롤', 'lol', lolText, lol], ['발로란트', 'valorant', valText, valorant]].filter(j => j[2]);
    const problems = [];
    const ids = jobs.map(([label, , text]) => {
      const id = parseRiotId(text);
      if (!id) problems.push(`${label}: 이름#태그 형식으로 적어 주세요. (예: Mino#KR1)`);
      return id;
    });
    if (problems.length) return interaction.editReply({ content: problems.join('\n') });
    for (const [n, [label, game, , service]] of jobs.entries()) {
      const res = await service.lookup(ids[n], 'all');
      if (!res.ok) { problems.push(`${label}: ${res.message}`); continue; }
      try {
        await interaction.channel.send(resultPayload(res, game, game === 'lol' && res.png ? queueRow(res.puuid, 'all') : null));
      } catch (err) {
        console.error('전적 이미지를 올리지 못함:', err);
        problems.push(`${label}: 이미지를 올리지 못했어요. 봇이 이 채널에 파일을 올릴 수 있는지 확인해 주세요.`);
      }
    }
    return interaction.editReply({ content: problems.length ? problems.join('\n') : '✅ 채널에 올렸어요.' });
  }

  // 계정 연결 모달 제출: 입력한 계정이 실제로 있는지 확인하고, 하나라도 틀리면 아무것도 저장하지 않는다.
  async function handleRecordModal(interaction) {
    const blocked = blockedMessage(interaction);
    if (blocked) return interaction.reply(eph(blocked));
    await interaction.deferReply({ flags: EPHEMERAL });
    if (interaction.customId === 'record:find_modal') return handleFind(interaction);
    const lolText = interaction.fields.getTextInputValue('lol').trim();
    const valText = interaction.fields.getTextInputValue('valorant').trim();
    if (!lolText && !valText) return interaction.editReply({ content: '롤이나 발로란트 중 하나 이상 입력해 주세요.' });
    const [lolRes, valRes] = await Promise.all([
      lolText ? checkOne('롤', lolText, verifyLol) : null,
      valText ? checkOne('발로란트', valText, verifyValorant) : null,
    ]);
    const problems = [lolRes?.error, valRes?.error].filter(Boolean);
    if (problems.length) return interaction.editReply({ content: `❌ 연결하지 않았어요.\n${problems.join('\n')}` });
    const linked = {};
    if (lolRes) linked.lol = { puuid: lolRes.account.puuid, name: lolRes.account.name, tag: lolRes.account.tag };
    if (valRes) linked.valorant = valRes.account;
    setLinked(interaction.user.id, linked);
    save();
    const lines = ['✅ 연결했어요.'];
    if (lolRes) lines.push(`롤: **${lolRes.account.name}#${lolRes.account.tag}**`);
    if (valRes) lines.push(`발로란트: **${valRes.account.name}#${valRes.account.tag}**`);
    return interaction.editReply({ content: lines.join('\n') });
  }

  return { startRecordCommand, handleRecordSelect, handleRecordButton, handleRecordModal };
}

// ── 실제 연결(처음 쓸 때 만든다) ───────────────────────────────────────────
const MATCHES_PATH = path.join(__dirname, '..', '..', 'DB', 'riot-matches.json');
const ICON_DIR = path.join(__dirname, '..', '..', 'assets', '전적');
let live = null;

function getLive() {
  if (live) return live;
  const riotKey = process.env.RIOT_API_KEY ?? '';
  const henrikKey = process.env.HENRIK_API_KEY ?? '';
  const riot = createRiotClient({ key: riotKey, limiter: createLimiter() });
  const store = createMatchStore({ file: MATCHES_PATH });
  const statics = createStatic({
    fetchJson: async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); },
    fetchBuffer: async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} ${r.status}`); return Buffer.from(await r.arrayBuffer()); },
    dir: ICON_DIR,
  });
  const lol = createLolService({ riot, store, statics });
  live = {
    store,
    handlers: createRecordHandlers({
      canUse: accounts.canUseRecordSearch, canUseHere: accounts.canUseRecordChannel, getLinked: accounts.getLinked, setLinked: accounts.setLinked, save: accounts.saveRecordAccounts,
      lol,
      valorant: createValorantService({ key: henrikKey, statics }),
      verifyLol: lol.verify,
      verifyValorant: async (name, tag) => { await fetchValorant({ name, tag, key: henrikKey }); return { name, tag }; },
    }),
  };
  return live;
}

function loadRecordSearch() {
  accounts.loadRecordAccounts();
  getLive().store.load();
}

function saveRecordSearch() {
  accounts.saveRecordAccounts();
  if (live) live.store.save();
}

module.exports = {
  createRecordHandlers, loadRecordSearch, saveRecordSearch,
  startRecordCommand: i => getLive().handlers.startRecordCommand(i),
  handleRecordButton: i => getLive().handlers.handleRecordButton(i),
  handleRecordSelect: i => getLive().handlers.handleRecordSelect(i),
  handleRecordModal: i => getLive().handlers.handleRecordModal(i),
};
