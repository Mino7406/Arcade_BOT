// 전적/index.js — /전적 명령의 상호작용: 나에게만 보이는 선택창([롤] [발로란트] [계정 연결]) → 채널에 공개되는 전적 이미지.
// 지금은 테스트 서버에서만 쓸 수 있다(config.js 의 RECORD_SEARCH_TEST_ONLY). 외부 서비스는 createRecordHandlers 로 주입해서 테스트한다.
//
// customId 규칙(100자 이하):
//   record:lol:<대상>   record:val:<대상>   — 대상: me | u:<디스코드 유저 id> | n:<이름#태그>
//   record:link         — 계정 연결 모달 열기      record:link_modal — 모달 제출
//   record:q:lol:<all|solo|flex>:<puuid> — 롤 이미지의 큐 탭
const path = require('path');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder, MessageFlags,
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
const QUEUE_TABS = [['all', '전체'], ['solo', '솔로랭크'], ['flex', '자유랭크']];
const eph = content => notice(content, { ephemeral: true }); // 나에게만 보이는 안내 카드(프로젝트의 v2 카드 형식)
const ACCENT = { lol: 0x3b82f6, valorant: 0xff4655 };

// 전적 이미지 한 장(또는 그림을 못 그릴 때 글자)을 카드 메시지로 만든다. row 는 카드 안에 들어갈 버튼 줄.
function resultPayload(res, game, row) {
  const rows = row ? [row] : [];
  if (!res.png) return payload(card({ color: ACCENT[game], blocks: [res.text], rows }));
  return { ...payload(card({ color: ACCENT[game], blocks: [{ image: 'attachment://record.png' }], rows })), files: [new AttachmentBuilder(res.png, { name: 'record.png' })] };
}

function createRecordHandlers({ canUse, getLinked, setLinked, save, lol, valorant, verifyLol, verifyValorant }) {
  const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  const queueRow = (puuid, current) => new ActionRowBuilder().addComponents(
    QUEUE_TABS.map(([q, label]) => button(`record:q:lol:${q}:${puuid}`, label, q === current ? ButtonStyle.Primary : ButtonStyle.Secondary)));

  // /전적 [멤버] [닉네임] → 나에게만 보이는 선택창
  async function startRecordCommand(interaction) {
    if (!canUse(interaction.guildId)) return interaction.reply(eph(NOT_READY));
    const member = interaction.options.getUser('멤버');
    const nick = interaction.options.getString('닉네임');
    let key = 'me', who = '내';
    if (nick) {
      const id = parseRiotId(nick);
      if (!id) return interaction.reply(eph('닉네임은 이름#태그 형식으로 적어 주세요. (예: Mino#KR1)'));
      key = `n:${id.name}#${id.tag}`;
      who = `**${id.name}#${id.tag}**의`;
    } else if (member) {
      key = `u:${member.id}`;
      who = `<@${member.id}>님의`;
    }
    const row = new ActionRowBuilder().addComponents(
      button(`record:lol:${key}`, '롤', ButtonStyle.Primary), button(`record:val:${key}`, '발로란트', ButtonStyle.Danger), button('record:link', '계정 연결'));
    return interaction.reply(menu({ header: '📊 전적 검색', color: 'info', blocks: [`${who} 전적을 볼 게임을 골라 주세요.`], rows: [row], ephemeral: true }));
  }

  // 대상 키 → 조회할 계정. 연결이 없으면 null.
  function resolveTarget(key, userId, game) {
    if (key.startsWith('n:')) {
      const id = parseRiotId(key.slice(2));
      return id ? { target: id, own: false } : { target: null, own: false };
    }
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
    if (!canUse(interaction.guildId)) return interaction.reply(eph(NOT_READY));
    const parts = interaction.customId.split(':');
    const action = parts[1];

    if (action === 'link') {
      const input = (id, label) => new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setPlaceholder('이름#태그 (예: Mino#KR1)').setRequired(false).setMaxLength(30));
      return interaction.showModal(new ModalBuilder().setCustomId('record:link_modal').setTitle('게임 계정 연결')
        .addComponents(input('lol', '롤 Riot ID (비워두면 연결 안 함)'), input('valorant', '발로란트 Riot ID (비워두면 연결 안 함)')));
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
        return interaction.reply(eph(own ? `아직 ${name} 계정이 연결되지 않았어요. [계정 연결]을 눌러 먼저 연결해 주세요.` : `그 멤버는 아직 ${name} 계정을 연결하지 않았어요. 닉네임을 직접 넣어서 조회해 보세요.`));
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

  // 계정 연결 모달 제출: 입력한 계정이 실제로 있는지 확인하고, 하나라도 틀리면 아무것도 저장하지 않는다.
  async function handleRecordModal(interaction) {
    if (!canUse(interaction.guildId)) return interaction.reply(eph(NOT_READY));
    await interaction.deferReply({ flags: EPHEMERAL });
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

  return { startRecordCommand, handleRecordButton, handleRecordModal };
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
      canUse: accounts.canUseRecordSearch, getLinked: accounts.getLinked, setLinked: accounts.setLinked, save: accounts.saveRecordAccounts,
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
  handleRecordModal: i => getLive().handlers.handleRecordModal(i),
};
