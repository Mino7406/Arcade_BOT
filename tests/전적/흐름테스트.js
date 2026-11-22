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
const idsOf = payload => payload.components.flatMap(r => r.toJSON().components.map(c => c.custom_id));

function setup({ linked = {}, lolResult, valResult, verifyLol, verifyVal } = {}) {
  const lookups = { lol: [], val: [] };
  const saved = { links: [], saves: 0 };
  const handlers = createRecordHandlers({
    canUse: g => g === TEST_GUILD,
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
    options: { getUser: () => null, getString: () => null },
    fields: { getTextInputValue: id => (over.fieldValues ?? {})[id] ?? '' },
    channel: { send: async p => { calls.push(['send', p]); } },
    reply: async p => { calls.push(['reply', p]); },
    deferReply: async p => { calls.push(['deferReply', p]); },
    deferUpdate: async () => { calls.push(['deferUpdate']); },
    editReply: async p => { calls.push(['editReply', p]); },
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
  const opts = command.data.toJSON().options.map(o => [o.name, o.required ?? false]);
  assert.deepStrictEqual(opts, [['멤버', false], ['닉네임', false]]);

  // (a) 테스트 서버가 아니면 선택창 없이 "준비 중"(나에게만), 서비스는 불리지 않는다
  let { handlers, lookups } = setup();
  let i = fakeInteraction({ guildId: 'OTHER' });
  await handlers.startRecordCommand(i);
  let [, p] = first(i, 'reply');
  assert.ok(p.content.includes('준비 중'));
  assert.strictEqual(p.flags, EPHEMERAL);
  assert.ok(!p.components);
  for (const customId of ['record:lol:me', 'record:link', 'record:q:lol:all:PUUID-1']) {
    i = fakeInteraction({ guildId: 'OTHER', customId });
    await handlers.handleRecordButton(i);
    assert.ok(first(i, 'reply')[1].content.includes('준비 중'), `${customId} 도 막힘`);
  }
  i = fakeInteraction({ guildId: 'OTHER', customId: 'record:link_modal' });
  await handlers.handleRecordModal(i);
  assert.ok(first(i, 'reply')[1].content.includes('준비 중') || first(i, 'deferReply'), '모달도 막힘');
  assert.strictEqual(lookups.lol.length, 0);

  // (b) 옵션 → 대상 키, 선택창은 나에게만, 버튼 3개
  const startWith = async (user, nick) => {
    const x = fakeInteraction({ options: { getUser: () => user, getString: () => nick } });
    await handlers.startRecordCommand(x);
    return first(x, 'reply')[1];
  };
  p = await startWith(null, null);
  assert.strictEqual(p.flags, EPHEMERAL);
  assert.deepStrictEqual(idsOf(p), ['record:lol:me', 'record:val:me', 'record:link']);
  assert.deepStrictEqual(idsOf(await startWith({ id: 'U9' }, null)), ['record:lol:u:U9', 'record:val:u:U9', 'record:link']);
  assert.deepStrictEqual(idsOf(await startWith(null, 'Mino#KR1')), ['record:lol:n:Mino#KR1', 'record:val:n:Mino#KR1', 'record:link']);
  p = await startWith(null, 'bad');
  assert.ok(p.content.includes('이름#태그') && !p.components, '닉네임 형식 오류 안내');
  // (f) customId 는 100자를 넘지 않는다(가장 긴 닉네임, 가장 긴 큐 탭)
  const longId = idsOf(await startWith(null, 'abcdefghijklmnop#ABCDE'))[0];
  assert.ok(longId.length <= 100, `긴 닉네임 customId ${longId.length}자`);
  assert.ok(`record:q:lol:solo:${'x'.repeat(78)}`.length <= 100);

  // (d) 연결 없이 [롤] → 연결 안내(채널 메시지 없음). 내 계정 / 다른 멤버 문구가 다르다
  ({ handlers, lookups } = setup());
  i = fakeInteraction({ customId: 'record:lol:me' });
  await handlers.handleRecordButton(i);
  assert.ok(first(i, 'reply')[1].content.includes('연결'));
  assert.strictEqual(first(i, 'reply')[1].flags, EPHEMERAL);
  assert.ok(!first(i, 'send'));
  const mineMsg = first(i, 'reply')[1].content;
  i = fakeInteraction({ customId: 'record:lol:u:U9' });
  await handlers.handleRecordButton(i);
  assert.notStrictEqual(first(i, 'reply')[1].content, mineMsg, '다른 멤버일 때 문구가 다르다');

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
  // 닉네임 대상은 puuid 없이 이름으로 조회
  i = fakeInteraction({ customId: 'record:lol:n:Mino#KR1' });
  await handlers.handleRecordButton(i);
  assert.deepStrictEqual(lookups.lol[1][0], { name: 'Mino', tag: 'KR1' });
  // 조회 실패는 나에게만 보이는 문구, 채널엔 아무것도 안 올린다
  ({ handlers } = setup({ linked, lolResult: { ok: false, message: '그 닉네임의 계정을 찾을 수 없어요.' } }));
  i = fakeInteraction({ customId: 'record:lol:me' });
  await handlers.handleRecordButton(i);
  assert.ok(!first(i, 'send'));
  assert.ok(first(i, 'followUp')[1].content.includes('찾을 수 없'));
  assert.strictEqual(first(i, 'followUp')[1].flags, EPHEMERAL);
  // 그림이 null 이면 글자로
  ({ handlers } = setup({ linked, lolResult: { ok: true, png: null, text: '글자 전적', puuid: 'P', label: 'A' } }));
  i = fakeInteraction({ customId: 'record:lol:me' });
  await handlers.handleRecordButton(i);
  assert.ok(first(i, 'send')[1].content.includes('글자 전적'));
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
