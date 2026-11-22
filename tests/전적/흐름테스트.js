// /전적 명령·버튼·모달 흐름 테스트: node tests/전적/흐름테스트.js
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { MessageFlags } = require('discord.js');
const { createRecordHandlers } = require(path.join(root, 'handlers', '전적', 'index.js'));
const { RiotError } = require(path.join(root, 'handlers', '전적', '리오트.js'));
const { TEST_GUILD_IDS } = require(path.join(root, 'config.js'));
const command = require(path.join(root, 'commands', '전적', '전적.js'));

const TEST_GUILD = TEST_GUILD_IDS[0];
const EPHEMERAL = MessageFlags.Ephemeral;
const json = c => (c.toJSON ? c.toJSON() : c);
const textOf = p => JSON.stringify((p.components ?? []).map(json)) + (p.content ?? '');
const isEph = p => (p.flags & EPHEMERAL) !== 0;
// 카드(컨테이너) 안에 있는 버튼들의 customId
const idsOf = p => {
  const ids = [];
  const walk = x => { if (x?.custom_id) ids.push(x.custom_id); (x?.components ?? []).forEach(walk); };
  (p.components ?? []).map(json).forEach(walk);
  return ids;
};

function setup({ linked = {}, lolResult, valResult, verifyLol, verifyVal } = {}) {
  const lookups = { lol: [], val: [] };
  const saved = { links: [], saves: 0 };
  const handlers = createRecordHandlers({
    canUse: g => g === TEST_GUILD || g === 'PUB',
    canUseHere: (g, c) => g === TEST_GUILD || ['MAIN', 'TTS', 'TEMPVC'].includes(c),
    getLinked: id => linked[id] ?? null,
    setLinked: (id, v) => { saved.links.push([id, v]); },
    save: () => { saved.saves++; },
    lol: { lookup: async (t, q) => { lookups.lol.push([t, q]); return lolResult ?? { ok: true, png: Buffer.from('png'), text: 't', puuid: t.puuid ?? 'PUUID-X', label: 'A bc#KR1' }; } },
    valorant: { lookup: async t => { lookups.val.push(t); return valResult ?? { ok: true, png: Buffer.from('png'), text: 't', label: 'V#KR1' }; } },
    verifyLol: verifyLol ?? (async (name, tag) => ({ puuid: 'PUUID-' + name, name, tag })),
    verifyValorant: verifyVal ?? (async (name, tag) => ({ name, tag, region: 'kr' })),
  });
  return { handlers, lookups, saved };
}

function fakeInteraction(over = {}) {
  const calls = [];
  const i = {
    calls, guildId: TEST_GUILD, user: { id: 'U1' }, customId: '',
    fields: { getTextInputValue: id => (over.fieldValues ?? {})[id] ?? '' },
    channel: { send: async p => { calls.push(['send', p]); } },
    reply: async p => { calls.push(['reply', p]); },
    deferReply: async p => { calls.push(['deferReply', p]); },
    deferUpdate: async () => { calls.push(['deferUpdate']); },
    editReply: async p => { calls.push(['editReply', p]); },
    update: async p => { calls.push(['update', p]); },
    deleteReply: async () => { calls.push(['deleteReply']); },
    followUp: async p => { calls.push(['followUp', p]); },
    showModal: async m => { calls.push(['showModal', m]); },
    ...over,
  };
  return i;
}
const first = (i, name) => i.calls.find(c => c[0] === name);

(async () => {
  // 명령 정의
  assert.strictEqual(command.data.name, '전적');
  assert.deepStrictEqual(command.data.toJSON().options ?? [], [], '옵션 없이 카드 안 버튼·메뉴로 해결');

  // (a) 테스트 서버가 아니면 선택창 없이 "준비 중"(나에게만), 서비스는 불리지 않는다
  let { handlers, lookups } = setup();
  let i = fakeInteraction({ guildId: 'OTHER' });
  await handlers.startRecordCommand(i);
  let [, p] = first(i, 'reply');
  assert.ok(textOf(p).includes('준비 중'));
  assert.ok(isEph(p));
  assert.ok(!idsOf(p).length, '선택 버튼 없음');
  for (const customId of ['record:lol:me', 'record:link', 'record:q:lol:all:PUUID-1']) {
    i = fakeInteraction({ guildId: 'OTHER', customId });
    await handlers.handleRecordButton(i);
    assert.ok(textOf(first(i, 'reply')[1]).includes('준비 중'), `${customId} 도 막힘`);
  }
  i = fakeInteraction({ guildId: 'OTHER', customId: 'record:link_modal' });
  await handlers.handleRecordModal(i);
  assert.ok(textOf(first(i, 'reply')[1]).includes('준비 중') || first(i, 'deferReply'), '모달도 막힘');
  assert.strictEqual(lookups.lol.length, 0);

  // 공개 서버에서는 메인·TTS·임시 음성채널 채팅에서만: 다른 채널이면 안내만(선택 카드·조회·모달 없음)
  ({ handlers, lookups } = setup());
  for (const [label, run] of [
    ['명령', i2 => handlers.startRecordCommand(i2)],
    ['버튼', i2 => handlers.handleRecordButton(i2)],
    ['메뉴', i2 => handlers.handleRecordSelect(i2)],
    ['모달', i2 => handlers.handleRecordModal(i2)],
  ]) {
    i = fakeInteraction({ guildId: 'PUB', channelId: 'ELSEWHERE', customId: 'record:lol:me', values: ['U9'] });
    await run(i);
    assert.ok(textOf(first(i, 'reply')[1]).includes('임시 음성채널'), `${label}: 허용 채널 안내`);
    assert.ok(isEph(first(i, 'reply')[1]), `${label}: 안내는 나에게만`);
    assert.ok(!first(i, 'deferUpdate') && !first(i, 'deferReply') && !first(i, 'showModal'), `${label}: 아무 동작도 안 함`);
  }
  assert.strictEqual(lookups.lol.length, 0);
  for (const ch of ['MAIN', 'TTS', 'TEMPVC']) {
    i = fakeInteraction({ guildId: 'PUB', channelId: ch });
    await handlers.startRecordCommand(i);
    assert.deepStrictEqual(idsOf(first(i, 'reply')[1]).slice(0, 3), ['record:lol:me', 'record:val:me', 'record:link'], `${ch} 에서는 선택 카드`);
  }

  // (b) 선택 카드: 내 전적 / 다른 사람 전적 구역, 나에게만 보임
  const startCard = async () => { const x = fakeInteraction(); await handlers.startRecordCommand(x); return first(x, 'reply')[1]; };
  p = await startCard();
  assert.ok(isEph(p), '선택창은 나에게만');
  assert.deepStrictEqual(idsOf(p), ['record:lol:me', 'record:val:me', 'record:link', 'record:pick', 'record:lol:none', 'record:val:none', 'record:find']);
  const text = textOf(p);
  assert.ok(text.includes('내 전적') && text.includes('다른 사람 전적'), '두 구역 제목');
  const comps = [];
  const collect = x => { comps.push(x); (x?.components ?? []).forEach(collect); };
  p.components.map(json).forEach(collect);
  const by = id => comps.find(c => c.custom_id === id);
  assert.strictEqual(by('record:lol:me').emoji.id, '1510933684750913626', '롤 로고 이모지');
  assert.strictEqual(by('record:val:me').emoji.id, '1510933698349109268', '발로란트 로고 이모지');
  assert.strictEqual(by('record:lol:none').disabled, true, '멤버를 고르기 전에는 회색');
  assert.strictEqual(by('record:val:none').disabled, true);
  assert.ok(!by('record:lol:me').disabled);
  // customId 는 100자를 넘지 않는다(가장 긴 큐 탭)
  assert.ok(`record:q:lol:solo:${'x'.repeat(78)}`.length <= 100);

  // 멤버 고르기 → 같은 카드가 업데이트돼 그 멤버용 버튼이 켜진다
  i = fakeInteraction({ customId: 'record:pick', values: ['U9'] });
  await handlers.handleRecordSelect(i);
  const [, upd] = first(i, 'update');
  assert.deepStrictEqual(idsOf(upd), ['record:lol:me', 'record:val:me', 'record:link', 'record:pick', 'record:lol:u:U9', 'record:val:u:U9', 'record:find']);
  const comps2 = []; (function walk(x) { comps2.push(x); (x?.components ?? []).forEach(walk); })({ components: upd.components.map(json) });
  assert.ok(!comps2.find(c => c.custom_id === 'record:lol:u:U9').disabled, '고른 뒤엔 켜짐');
  assert.deepStrictEqual(comps2.find(c => c.custom_id === 'record:pick').default_values, [{ id: 'U9', type: 'user' }], '고른 멤버가 메뉴에 표시됨');
  i = fakeInteraction({ guildId: 'OTHER', customId: 'record:pick', values: ['U9'] });
  await handlers.handleRecordSelect(i);
  assert.ok(textOf(first(i, 'reply')[1]).includes('준비 중'), '선택 메뉴도 막힘');

  // (d) 연결 없이 [롤] → 연결 안내(채널 메시지 없음). 내 계정 / 다른 멤버 문구가 다르다
  ({ handlers, lookups } = setup());
  i = fakeInteraction({ customId: 'record:lol:me' });
  await handlers.handleRecordButton(i);
  assert.ok(textOf(first(i, 'reply')[1]).includes('연결'));
  assert.ok(isEph(first(i, 'reply')[1]));
  assert.ok(!first(i, 'send'));
  const mineMsg = textOf(first(i, 'reply')[1]);
  i = fakeInteraction({ customId: 'record:lol:u:U9' });
  await handlers.handleRecordButton(i);
  assert.notStrictEqual(textOf(first(i, 'reply')[1]), mineMsg, '다른 멤버일 때 문구가 다르다');

  // 연결 있으면: 채널에 이미지 한 장 + 큐 버튼 3개
  const linked = { U1: { lol: { puuid: 'PUUID-1', name: 'Mino', tag: 'KR1' }, valorant: { name: 'Mino', tag: 'KR1', region: 'kr' } } };
  ({ handlers, lookups } = setup({ linked }));
  i = fakeInteraction({ customId: 'record:lol:me' });
  await handlers.handleRecordButton(i);
  assert.ok(first(i, 'deferUpdate'));
  const [, sent] = first(i, 'send');
  assert.strictEqual(sent.files.length, 1);
  assert.deepStrictEqual(idsOf(sent), ['record:q:lol:all:PUUID-1', 'record:q:lol:solo:PUUID-1', 'record:q:lol:flex:PUUID-1']);
  assert.deepStrictEqual(lookups.lol[0][0], { name: 'Mino', tag: 'KR1', puuid: 'PUUID-1' });
  assert.strictEqual(lookups.lol[0][1], 'all');
  // 조회 실패는 나에게만 보이는 문구, 채널엔 아무것도 안 올린다
  ({ handlers } = setup({ linked, lolResult: { ok: false, message: '그 닉네임의 계정을 찾을 수 없어요.' } }));
  i = fakeInteraction({ customId: 'record:lol:me' });
  await handlers.handleRecordButton(i);
  assert.ok(!first(i, 'send'));
  assert.ok(textOf(first(i, 'followUp')[1]).includes('찾을 수 없'));
  assert.ok(isEph(first(i, 'followUp')[1]));
  // 그림이 null 이면 글자로
  ({ handlers } = setup({ linked, lolResult: { ok: true, png: null, text: '글자 전적', puuid: 'P', label: 'A' } }));
  i = fakeInteraction({ customId: 'record:lol:me' });
  await handlers.handleRecordButton(i);
  assert.ok(textOf(first(i, 'send')[1]).includes('글자 전적'));
  // 발로란트 버튼
  ({ handlers, lookups } = setup({ linked }));
  i = fakeInteraction({ customId: 'record:val:me' });
  await handlers.handleRecordButton(i);
  assert.deepStrictEqual(lookups.val[0], { name: 'Mino', tag: 'KR1' });
  assert.strictEqual(first(i, 'send')[1].files.length, 1);

  // (e) 큐 탭: 같은 메시지를 새 이미지로 바꾼다
  i = fakeInteraction({ customId: 'record:q:lol:solo:PUUID-1' });
  await handlers.handleRecordButton(i);
  assert.ok(first(i, 'deferUpdate'));
  const [, edited] = first(i, 'editReply');
  assert.strictEqual(edited.files.length, 1);
  assert.strictEqual(lookups.lol.at(-1)[1], 'solo');
  assert.strictEqual(lookups.lol.at(-1)[0].puuid, 'PUUID-1');

  // [닉네임으로 검색] → 모달(입력칸 2개, 둘 다 선택)
  i = fakeInteraction({ customId: 'record:find' });
  await handlers.handleRecordButton(i);
  const fmodal = first(i, 'showModal')[1].toJSON();
  assert.strictEqual(fmodal.custom_id, 'record:find_modal');
  assert.deepStrictEqual(fmodal.components.map(r => r.components[0].custom_id), ['lol', 'valorant']);
  assert.ok(fmodal.components.every(r => r.components[0].required === false));
  // 제출: 채운 게임만 puuid 없이 이름으로 조회해 채널에 올린다
  ({ handlers, lookups } = setup({ linked }));
  i = fakeInteraction({ customId: 'record:find_modal', fieldValues: { lol: 'Mino#KR1' } });
  await handlers.handleRecordModal(i);
  assert.deepStrictEqual(lookups.lol[0][0], { name: 'Mino', tag: 'KR1' });
  assert.strictEqual(lookups.val.length, 0);
  assert.strictEqual(first(i, 'send')[1].files.length, 1);
  // 둘 다 채우면 둘 다, 형식이 틀리거나 둘 다 비면 안내(조회 없음)
  i = fakeInteraction({ customId: 'record:find_modal', fieldValues: { lol: 'Mino#KR1', valorant: 'Mino#KR1' } });
  await handlers.handleRecordModal(i);
  assert.strictEqual(lookups.lol.length, 2); assert.strictEqual(lookups.val.length, 1);
  assert.strictEqual(i.calls.filter(c => c[0] === 'send').length, 2);
  const before = lookups.lol.length;
  i = fakeInteraction({ customId: 'record:find_modal', fieldValues: {} });
  await handlers.handleRecordModal(i);
  assert.ok(first(i, 'editReply')[1].content.includes('하나 이상'));
  i = fakeInteraction({ customId: 'record:find_modal', fieldValues: { lol: 'nohash' } });
  await handlers.handleRecordModal(i);
  assert.ok(first(i, 'editReply')[1].content.includes('이름#태그'));
  assert.strictEqual(lookups.lol.length, before);
  // 조회 실패는 나에게만 보이는 문구
  ({ handlers } = setup({ lolResult: { ok: false, message: '그 닉네임의 계정을 찾을 수 없어요.' } }));
  i = fakeInteraction({ customId: 'record:find_modal', fieldValues: { lol: 'Mino#KR1' } });
  await handlers.handleRecordModal(i);
  assert.ok(!first(i, 'send'));
  assert.ok(first(i, 'editReply')[1].content.includes('찾을 수 없'));

  // [계정 연결] → 모달(입력칸 2개, 둘 다 선택)
  i = fakeInteraction({ customId: 'record:link' });
  await handlers.handleRecordButton(i);
  const modal = first(i, 'showModal')[1].toJSON();
  assert.strictEqual(modal.custom_id, 'record:link_modal');
  const inputs = modal.components.map(r => r.components[0]);
  assert.strictEqual(inputs.length, 2);
  assert.ok(inputs.every(x => x.required === false));
  assert.deepStrictEqual(inputs.map(x => x.custom_id), ['lol', 'valorant']);

  // 모달 제출: 롤만 유효 → 저장
  let ctx = setup();
  i = fakeInteraction({ customId: 'record:link_modal', fieldValues: { lol: 'Mino#KR1' } });
  await ctx.handlers.handleRecordModal(i);
  assert.deepStrictEqual(ctx.saved.links, [['U1', { lol: { puuid: 'PUUID-Mino', name: 'Mino', tag: 'KR1' } }]]);
  assert.ok(ctx.saved.saves >= 1);
  assert.ok(first(i, 'deferReply')[0] && (first(i, 'editReply')[1].content ?? '').includes('연결'));
  // 롤 유효 + 발로란트 없는 계정 → 아무것도 저장 안 함, 발로란트 쪽 문구
  ctx = setup({ verifyVal: async () => { throw new RiotError('not_found', 404); } });
  i = fakeInteraction({ customId: 'record:link_modal', fieldValues: { lol: 'Mino#KR1', valorant: 'Ghost abc#KR1' } });
  await ctx.handlers.handleRecordModal(i);
  assert.deepStrictEqual(ctx.saved.links, []);
  const failText = first(i, 'editReply')[1].content;
  assert.ok(failText.includes('발로란트') && failText.includes('찾을 수 없'), failText);
  // 둘 다 빔 / 형식 오류
  ctx = setup();
  i = fakeInteraction({ customId: 'record:link_modal', fieldValues: {} });
  await ctx.handlers.handleRecordModal(i);
  assert.ok(first(i, 'editReply')[1].content.includes('하나 이상'));
  i = fakeInteraction({ customId: 'record:link_modal', fieldValues: { lol: 'nohash' } });
  await ctx.handlers.handleRecordModal(i);
  assert.ok(first(i, 'editReply')[1].content.includes('이름#태그'));
  assert.deepStrictEqual(ctx.saved.links, []);
  console.log('/전적 흐름 테스트 통과');
})();
