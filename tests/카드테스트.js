// 컴포넌트 v2 카드 테스트 — 모든 화면이 디스코드 규칙을 지키는지 확인한다.
// 실행: node tests/카드테스트.js
//
// 확인하는 것(어기면 디스코드가 메시지를 거부한다):
//  - IsComponentsV2 플래그가 켜져 있고 content / embeds 가 비어 있다
//  - 최상위 컴포넌트 10개 이하, 컨테이너 안까지 센 전체 40개 이하
//  - 글자(TextDisplay 합계) 4000자 이하
//  - 컴포넌트 데이터가 discord.js 검증(toJSON)을 통과한다
//  - 버튼은 한 줄 5개 이하, 한 컨테이너 안 버튼 줄 5줄 이하

const assert = require('assert');
const { MessageFlags } = require('discord.js');
const { buildScreens } = require('./카드화면');
const card = require('../handlers/카드');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; } catch (err) { fail++; console.log(`✗ ${name}\n   ${err.message}`); }
}

function countComponents(list) {
  let n = 0;
  for (const c of list || []) {
    n += 1;
    n += countComponents(c.components);
    if (c.accessory) n += 1;
  }
  return n;
}

function totalText(list) {
  let n = 0;
  for (const c of list || []) {
    if (typeof c.content === 'string') n += c.content.length;
    n += totalText(c.components);
  }
  return n;
}

function rowsIn(list, acc = []) {
  for (const c of list || []) {
    if (c.type === 1) acc.push(c);
    rowsIn(c.components, acc);
  }
  return acc;
}

(async () => {
  const screens = await buildScreens();

  for (const s of screens) {
    const label = `[${s.group}] ${s.title}`;
    const p = s.payload;

    check(`${label} — v2 플래그·content/embeds 비움`, () => {
      assert.ok(p.flags & MessageFlags.IsComponentsV2, 'IsComponentsV2 플래그가 없음');
      assert.ok(!p.content, 'content 가 비어 있지 않음');
      assert.deepStrictEqual(p.embeds ?? [], [], 'embeds 가 비어 있지 않음');
    });
    check(`${label} — 컴포넌트 수`, () => {
      assert.ok(s.components.length <= 10, `최상위 ${s.components.length}개`);
      const total = countComponents(s.components);
      assert.ok(total <= 40, `전체 ${total}개`);
    });
    check(`${label} — 글자 4000자 이하`, () => {
      const t = totalText(s.components);
      assert.ok(t <= 4000, `${t}자`);
    });
    check(`${label} — 버튼 줄 규칙`, () => {
      for (const row of rowsIn(s.components)) assert.ok(row.components.length <= 5, `한 줄에 ${row.components.length}개`);
    });
  }

  // 길이가 긴 참가자 목록도 잘려서 한도 안에 들어와야 한다.
  check('참가자 100명 목록도 4000자 이하', () => {
    const { buildPublicMessagePayload } = require('../handlers/내전');
    const users = Array.from({ length: 100 }, (_, i) => ({ id: String(i), displayName: `참가자이름이긴유저${i}` }));
    const gameInfo = { name: '리그 오브 레전드', emoji: '<:Lol:1510933684750913626>', color: 0xC89B3C };
    const data = { game: 'lol', gameInfo, title: '큰 내전', datetime: '내일', players: '100', description: '', organizer: { id: '1', displayName: '민호' } };
    const p = buildPublicMessagePayload({ data, participants: users, closed: false, teams: { team1: users.slice(0, 50), team2: users.slice(50) } });
    const comps = p.components.map(c => c.toJSON());
    assert.ok(totalText(comps) <= 4000, `${totalText(comps)}자`);
  });

  // 카드 도구
  check('notice 톤 자동 선택', () => {
    assert.strictEqual(card.toneOf('⚠️ 주의'), 'warn');
    assert.strictEqual(card.toneOf('❌ 실패'), 'err');
    assert.strictEqual(card.toneOf('✅ 완료'), 'ok');
    assert.strictEqual(card.toneOf('⏰ 시간 초과'), 'muted');
    assert.strictEqual(card.toneOf('그냥 글'), 'info');
  });
  check('payload 는 기본으로 멘션 알림을 막는다', () => {
    assert.deepStrictEqual(card.payload(card.card({ blocks: ['<@1> 안녕'] })).allowedMentions, { parse: [] });
  });
  check('payload 는 keepAttachments 가 아니면 첨부를 비운다', () => {
    assert.deepStrictEqual(card.payload(card.card({ blocks: ['a'] })).attachments, []);
    assert.strictEqual('attachments' in card.payload(card.card({ blocks: ['a'] }), { keepAttachments: true }), false);
  });
  check('withTopRows 는 카드는 두고 맨 위 버튼 줄만 바꾼다', () => {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
    const row = () => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('x').setLabel('x').setStyle(ButtonStyle.Primary)).toJSON();
    const container = card.card({ blocks: ['본문'] }).toJSON();
    const msg = { components: [{ type: ComponentType.Container, toJSON: () => container }, { type: ComponentType.ActionRow, toJSON: row }] };
    const out = card.withTopRows(msg, []);
    assert.strictEqual(out.components.length, 1);
    assert.strictEqual(out.components[0].type, 17);
    assert.ok(out.flags & MessageFlags.IsComponentsV2);
  });
  check('hasCustomId 는 컨테이너 안까지 찾는다', () => {
    const msg = { components: [{ components: [{ components: [{ customId: 'ranking:share:1' }] }] }] };
    assert.strictEqual(card.hasCustomId(msg.components, 'ranking:share:'), true);
    assert.strictEqual(card.hasCustomId(msg.components, 'nope:'), false);
    assert.strictEqual(card.hasCustomId([{ components: [{ accessory: { customId: 'ranking:share:2' } }] }], 'ranking:share:'), true, '섹션 오른쪽 버튼도 찾아야 함');
  });

  console.log(`\n카드 테스트 — 통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
