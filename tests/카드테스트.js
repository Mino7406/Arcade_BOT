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
const card = require('../handlers/공통/카드');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; } catch (err) { fail++; console.log(`✗ ${name}\n   ${err.message}`); }
}

async function checkAsync(name, fn) {
  try { await fn(); pass++; } catch (err) { fail++; console.log(`✗ ${name}
   ${err.message}`); }
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
    const { buildPublicMessagePayload } = require('../handlers/매치/내전');
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

  // ── 옛 메시지·카드 메시지 읽기(봇이 꺼진 사이 올라간 것, 재시작 복구용) ──
  const asMsg = (p, extra = {}) => ({ components: p.components.map(c => (c.toJSON ? c.toJSON() : c)), embeds: [], ...extra });
  check('취소된 카드와 옛 임베드 둘 다 "🔴 취소됨"을 읽는다', () => {
    const common = require('../handlers/매치/공용');
    const gi = { name: '롤', emoji: '<:Lol:1510933684750913626>', color: 1 };
    const data = { game: 'lol', gameInfo: gi, title: '롤 내전', datetime: 'x', organizer: { id: '1', displayName: 'a' } };
    const cancelled = asMsg(card.payload(common.buildCancelledCard({ label: '내전', data, byOrganizer: true })));
    assert.ok(card.messageText(cancelled).includes('🔴 취소됨'));
    assert.ok(card.hasHeaderLine(cancelled, '롤 내전'), '제목 줄(## 제목)을 찾을 수 있어야 함');
    assert.ok(card.hasHeaderLine({ components: [{ content: '# 롤 내전' }], embeds: [] }, '롤 내전'), '예전 `# 제목` 카드도 찾아야 함');
    const legacy = { components: [], embeds: [{ title: null, description: '## 롤 내전\n📊 **상태**　　🔴 취소됨', fields: [] }] };
    assert.ok(card.messageText(legacy).includes('🔴 취소됨'));
  });
  check('렐름 검토: 카드·옛 임베드에서 닉네임과 신청 시각을 읽는다', () => {
    const mark = require('../forms/마크');
    const applicant = { id: '5', displayAvatarURL: () => 'https://x/a.png' };
    const msg = asMsg(mark.buildRealmReviewPayload({ applicant, displayName: '지수', nickname: 'Steve_7406', appliedAt: 1_700_000_000_000, status: 'pending' }));
    const r = mark.readRealmReview(msg);
    assert.strictEqual(r.nickname, 'Steve_7406');
    assert.strictEqual(r.appliedAtText, '<t:1700000000:f>');
    const legacy = { components: [], embeds: [{ fields: [{ name: '<:Name_Tag:1544325806803652608> 닉네임', value: 'Alex' }, { name: '<:Watch:1544331505101439066> 신청 일시', value: '<t:1700000000:f>' }] }] };
    assert.strictEqual(mark.readRealmReview(legacy).nickname, 'Alex');
  });
  check('게임모집 안내 패널을 카드와 옛 임베드 모두에서 알아본다', () => {
    const { isRecruitPanelMessage, RECRUIT_TITLE } = require('../handlers/관리/최신화');
    const panel = require('../handlers/관리/패널');
    const msg = { author: { id: 'bot' }, ...asMsg(panel.buildSetupPanelPayload({ client: { user: { displayAvatarURL: () => 'https://x/a.png', username: 'b' } }, guild: { id: '1' } })) };
    assert.strictEqual(isRecruitPanelMessage(msg, 'bot'), true);
    assert.strictEqual(isRecruitPanelMessage(msg, 'other'), false, '다른 봇 메시지는 제외');
    assert.strictEqual(isRecruitPanelMessage({ author: { id: 'bot' }, components: [], embeds: [{ title: RECRUIT_TITLE }] }, 'bot'), true);
  });
  check('큰 내전(참가자 60명)도 모든 화면이 한도 안', () => {
    const { buildPublicMessagePayload } = require('../handlers/매치/내전');
    const users = Array.from({ length: 60 }, (_, i) => ({ id: String(i), displayName: `참가자${i}` }));
    const gameInfo = { name: '롤', emoji: '<:Lol:1510933684750913626>', color: 1 };
    const data = { game: 'lol', gameInfo, title: 't', datetime: 'x', players: '60', description: '메모'.repeat(100), organizer: { id: '1', displayName: 'a' } };
    for (const teams of [null, { team1: users.slice(0, 30), team2: users.slice(30) }]) {
      const json = buildPublicMessagePayload({ data, participants: users, closed: true, teams }).components.map(c => c.toJSON());
      assert.ok(totalText(json) <= 4000, `${totalText(json)}자`);
    }
  });

  check('생성 모달 일시는 지금 시각으로 미리 채워지고, 알림이 그 시각을 인식한다', () => {
    const c = require('../handlers/매치/공용');
    const now = Date.now();
    const text = c.defaultDatetimeText(now);
    assert.ok(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/.test(text), text);
    const auto = c.deriveNotifyFromDatetime(text);
    assert.ok(auto && Math.abs(auto.notifyAt - (now - 10 * 60 * 1000)) < 60 * 1000, '지금 시각을 읽고 자동 알림은 10분 전');
    assert.strictEqual(auto.notifyOnClose, true, '지금 시각 그대로면 10분 전이 이미 지나 마감 때 발송');
    assert.strictEqual(auto.notify12h, false);
    const modal = c.buildModal('mojip', '모집', { lol: { name: '롤', emoji: '🎮', defaultPlayers: 5 } }, 'lol').toJSON();
    const dt = modal.components.map(r => r.components[0]).find(x => x.custom_id === 'datetime');
    assert.strictEqual(dt.value, text.replace(/\d{2}$/, dt.value.slice(-2)), '모달 일시 기본값');
    const kst = d => c.formatNotifyTime(d);
    const tomorrow = new Date(now + 24 * 3600 * 1000);
    const ko = `${new Date(tomorrow.getTime() + 9 * 3600e3).getUTCMonth() + 1}월 ${new Date(tomorrow.getTime() + 9 * 3600e3).getUTCDate()}일 오후 8시`;
    const k = c.deriveNotifyFromDatetime(ko);
    assert.ok(k && k.notify12h === true && kst(k.notifyAt).endsWith('19:50'), `${ko} → 자동 알림은 10분 전`);
    assert.strictEqual(c.deriveNotifyFromDatetime('내일 8시'), null, '못 읽는 글자는 null');
    const data = { datetime: text, notifyAuto: true, notifyAutoSrc: text, notifyAt: now };
    data.datetime = ko; c.syncAutoNotify(data);
    assert.ok(data.notifyAt && data.notifyAuto, '일시가 바뀌면 알림 시각도 따라감');
    data.datetime = '내일 8시'; c.syncAutoNotify(data);
    assert.strictEqual(data.notifyAt, null); assert.strictEqual(data.notifyAuto, false);
    // 일시가 그대로면(메모·인원만 수정) 알림은 건드리지 않는다 — 지난 일시라도 꺼지지 않음
    const kept = { datetime: '1/1 20:00', notifyAuto: true, notifyAutoSrc: '1/1 20:00', notifyAt: 123 };
    assert.strictEqual(c.syncAutoNotify(kept), null);
    assert.strictEqual(kept.notifyAt, 123);
    // 모달에 미리 채운 지금 시각은 몇 시간 뒤 알림을 켜도 내년으로 넘어가지 않고, 지난 채로 남아 마감 때 바로 나간다
    const created = Date.now() - 5 * 3600 * 1000;
    const stamp = c.defaultDatetimeText(created);
    const past = c.deriveNotifyFromDatetime(stamp, { base: created });
    assert.ok(past && Math.abs(past.notifyAt - (created - 10 * 60 * 1000)) < 60 * 1000 && past.notifyAt < Date.now(), '지난 일시도 알림 시각(10분 전)으로 유지');
    assert.strictEqual(c.deriveNotifyFromDatetime(stamp), null, 'base 없이는 5시간 지난 일시를 내년으로 봄(기존 동작)');
    // 안 고친 지금 시각 = "자동 발송"(마감 때 바로), 미래 시각을 직접 적으면 그 시각에 발송
    assert.strictEqual(past.notifyOnClose, true);
    assert.strictEqual(c.notifyWhenText({ notifyAt: past.notifyAt, notifyOnClose: true }), '마감 시 발송');
    const later = c.deriveNotifyFromDatetime('내일 저녁 8시');
    assert.ok(later && later.notifyOnClose === false, '미래 시각은 그 시각에 발송');
    assert.notStrictEqual(c.notifyWhenText({ notifyAt: later.notifyAt, notify12h: false, notifyOnClose: false }), '마감 시 발송');
    assert.ok(c.notifyWhenText({ notifyAt: later.notifyAt, notify12h: false, notifyOnClose: false, notifyAuto: true }).endsWith(' (자동)'), '봇이 잡은 시각엔 (자동)');
    // 카드 표시: 안 고친 지금 시각은 끝에 " ~"(그때부터 열려 있음), 직접 적은 미래 시각·createdAt 없는 옛 데이터는 그대로
    assert.strictEqual(c.datetimeDisplay({ datetime: stamp, createdAt: created }), `${stamp} ~`);
    assert.strictEqual(c.datetimeDisplay({ datetime: '내일 저녁 8시', createdAt: Date.now() }), '내일 저녁 8시');
    assert.strictEqual(c.datetimeDisplay({ datetime: stamp }), stamp);
    assert.strictEqual(c.datetimeDisplay({ datetime: '아무 글자', createdAt: created }), '아무 글자');
  });

  check('일시 글자 해석: 저녁·밤·내일은 읽고, 아침/저녁이 애매한 "8시"는 안 읽는다', () => {
    const c = require('../handlers/매치/공용');
    const hm = t => { const e = c.parseDatetimeText(t); return e && c.formatNotifyTime(e).split(' ')[1]; };
    assert.strictEqual(hm('내일 저녁 8시'), '20:00');
    assert.strictEqual(hm('오늘 밤 11시'), '23:00');
    assert.strictEqual(hm('저녁 8시 반'), '20:30');
    assert.strictEqual(hm('내일 오전 9시 30분'), '09:30');
    assert.strictEqual(hm('11/13 20시'), '20:00');
    for (const t of ['내일 8시', '오늘 8시', '모이면', '11월 13일 8시', '2/30 20:00', '8시', '12시', '20:']) assert.strictEqual(c.parseDatetimeText(t), null, t);
    // 날짜 없이 24시간제 시각만: 오늘 그 시각, 3시간 넘게 지났으면 내일
    const noon = Date.UTC(2026, 10, 13, 12, 0) - 9 * 3600e3; // KST 11/13 12:00
    const at = t => c.formatNotifyTime(c.parseDatetimeText(t, noon));
    assert.strictEqual(at('20:00'), '11/13 20:00');
    assert.strictEqual(at('20시'), '11/13 20:00');
    assert.strictEqual(at('13:30'), '11/13 13:30');
    assert.strictEqual(at('8:00'), '11/14 08:00', '3시간 넘게 지난 시각은 내일');
    assert.strictEqual(at('11:00'), '11/13 11:00', '조금 지난 시각은 오늘(마감 때 바로 발송)');
    const d = { datetime: '20:00', createdAt: noon, notifyAuto: true, notifyAutoSrc: '11/13 12:00', notifyAt: noon };
    assert.strictEqual(c.syncAutoNotify(d), 'changed', '수정창에 시각만 적어도 알림이 따라감');
  });
  check('일시를 고치면 켜 둔 알림이 새 일시 10분 전으로 따라감(직접 적은 알림도), 못 읽으면 자동은 끄고 직접은 유지', () => {
    const c = require('../handlers/매치/공용');
    const created = Date.now();
    const tmr = new Date(created + 24 * 3600e3 + 9 * 3600e3);
    const md = `${tmr.getUTCMonth() + 1}/${tmr.getUTCDate()}`;
    const hm = e => c.formatNotifyTime(e).split(' ')[1];
    // 1) 자동 알림 → 새 일시 10분 전
    const a = { datetime: `${md} 20:00`, createdAt: created };
    Object.assign(a, c.deriveNotifyFromDatetime(a.datetime, { base: created }), { notifyAuto: true, notifyAutoSrc: a.datetime });
    assert.strictEqual(hm(a.notifyAt), '19:50', '처음 켤 때도 10분 전');
    let prev = a.datetime; a.datetime = `${md} 21:30`;
    assert.strictEqual(c.syncAutoNotify(a, prev), 'changed');
    assert.strictEqual(hm(a.notifyAt), '21:20');
    assert.ok(c.notifySyncNote('changed', a).includes('21:20'));
    // 2) 직접 적은 알림 → 일시를 읽을 수 있으면 자동 알림(10분 전)으로 바뀜
    const m = { datetime: `${md} 20:00`, createdAt: created, notifyAt: c.parseDatetimeText(`${md} 19:00`, created), notifyAuto: false };
    prev = m.datetime; m.datetime = `${md} 22:00`;
    assert.strictEqual(c.syncAutoNotify(m, prev), 'changed');
    assert.strictEqual(hm(m.notifyAt), '21:50'); assert.strictEqual(m.notifyAuto, true);
    // 3) 못 읽는 일시: 직접 적은 알림은 그대로, 자동 알림은 꺼짐
    const keep = { datetime: `${md} 20:00`, createdAt: created, notifyAt: 777, notifyAuto: false };
    prev = keep.datetime; keep.datetime = '모이면';
    assert.strictEqual(c.syncAutoNotify(keep, prev), 'kept'); assert.strictEqual(keep.notifyAt, 777);
    prev = a.datetime; a.datetime = '모이면';
    assert.strictEqual(c.syncAutoNotify(a, prev), 'off'); assert.strictEqual(a.notifyAt, null);
    // 4) 알림이 꺼져 있거나 일시가 그대로면 건드리지 않음
    const off = { datetime: `${md} 20:00`, createdAt: created };
    prev = off.datetime; off.datetime = `${md} 21:00`;
    assert.strictEqual(c.syncAutoNotify(off, prev), null); assert.ok(!off.notifyAt, '꺼진 알림은 새로 켜지지 않음');
    assert.strictEqual(c.syncAutoNotify({ ...m, notifyAuto: false }, m.datetime), null, '일시 그대로면 그대로');
    // 5) 새 일시의 10분 전이 이미 지났으면 마감 때 바로 발송
    const soon = new Date(Date.now() + 5 * 60e3 + 9 * 3600e3);
    const near = { datetime: `${md} 20:00`, createdAt: created - 3600e3, notifyAt: 1, notifyAuto: true, notifyAutoSrc: `${md} 20:00` };
    prev = near.datetime; near.datetime = `${soon.getUTCMonth() + 1}/${soon.getUTCDate()} ${String(soon.getUTCHours()).padStart(2, '0')}:${String(soon.getUTCMinutes()).padStart(2, '0')}`;
    assert.strictEqual(c.syncAutoNotify(near, prev), 'changed'); assert.strictEqual(near.notifyOnClose, true, '10분 전이 지났으면 자동 발송(마감 시)');
    assert.ok(c.notifySyncNote('changed', near).includes('마감'));
  });
  check('알림 발송 규칙: 직접 정한 시각은 마감과 무관하게, 자동 발송은 마감 때', () => {
    const c = require('../handlers/매치/공용');
    const mk = (extra) => ({ data: { notifyAt: Date.now() - 1000, ...extra }, participants: [], closed: false, notifySent: false });
    const map = new Map();
    const byTime = mk({ notifyOnClose: false });
    map.set('a', byTime); c.armNotifyReminder(map, 'a', byTime, '모집');
    assert.strictEqual(byTime.notifySent, true, '직접 정한 시각이 지났으면 마감 전이어도 발송');
    const onClose = mk({ notifyOnClose: true });
    map.set('b', onClose); c.armNotifyReminder(map, 'b', onClose, '모집');
    assert.strictEqual(onClose.notifySent, false, '자동 발송은 마감 전에는 대기');
    onClose.closed = true; c.armNotifyReminder(map, 'b', onClose, '모집');
    assert.strictEqual(onClose.notifySent, true, '자동 발송은 마감되면 발송');
    const future = mk({ notifyOnClose: false, notifyAt: Date.now() + 60 * 60 * 1000 });
    map.set('c', future); c.armNotifyReminder(map, 'c', future, '모집');
    assert.strictEqual(future.notifySent, false, '아직 시각 전이면 대기');
    c.clearNotifyTimer(future);
  });
  await checkAsync('알림 예약 중이면 상태 옆에 🔔, 발송되면 사라짐(타이머 발송 시 카드 다시 그림)', async () => {
    const c = require('../handlers/매치/공용');
    require('../handlers/매치/모집'); // 모집 카드 빌더 등록
    const base = { game: 'custom', gameInfo: { name: '렐름', color: 0x5865f2 }, title: '테스트', players: '4', datetime: '11/13 20:00', organizer: { id: 'o', displayName: '주최' } };
    const txt = p => JSON.stringify(p.components.map(x => (x.toJSON ? x.toJSON() : x)));
    const m = { data: { ...base, notifyAt: Date.now() + 3600e3 }, participants: [], closed: false, notifySent: false };
    assert.ok(txt(c.buildMatchMessagePayload({ label: '모집', match: m, rows: [] })).includes('🟢 모집 중 🔔'), '예약 중: 모집 중 🔔');
    assert.ok(txt(c.buildManagePayload({ label: '모집', match: { ...m, closed: true }, rows: [] })).includes('🔒 마감됨 🔔'), '관리 메뉴도 마감됨 🔔');
    assert.ok(!txt(c.buildMatchMessagePayload({ label: '모집', match: { ...m, notifySent: true }, rows: [] })).includes('🔔'), '발송 후에는 🔔 없음');
    assert.ok(!txt(c.buildMatchMessagePayload({ label: '모집', match: { ...m, data: base }, rows: [] })).includes('🔔'), '알림 없으면 🔔 없음');
    // 시각이 지났는데 마감 전이어도 발송되고, 카드를 다시 그려 🔔를 지운다
    let edited = null;
    const due = { data: { ...base, notifyAt: Date.now() - 1000, notifyOnClose: false }, participants: [], closed: false, notifySent: false, message: { edit: async p => { edited = p; } } };
    const map = new Map([['d', due]]);
    c.armNotifyReminder(map, 'd', due, '모집');
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(due.notifySent, true, '시각이 지나면 마감 전이어도 발송');
    assert.ok(edited && txt(edited).includes('🟢 모집 중') && !txt(edited).includes('🔔'), '발송 후 카드에서 🔔 제거');
  });
  check('DM 알림 설정: 기본 ON, 끄면 OFF, 카드는 현재 상태 쪽 버튼만 비활성화', () => {
    const dm = require('../handlers/매치/DM설정');
    const find = (p, id) => { const out = []; (function walk(l) { for (const x of l || []) { if (x.custom_id === id) out.push(x); walk(x.components); } })(p.components.map(c => c.toJSON())); return out[0]; };
    assert.strictEqual(dm.isDmEnabled('u-test'), true, '기본값은 ON');
    let p = dm.buildDmSettingPayload('u-test');
    assert.strictEqual(find(p, 'dmpref:on').disabled, true);
    assert.strictEqual(find(p, 'dmpref:off').disabled, false);
    assert.strictEqual(find(p, 'dmpref:on').style, 3, 'ON은 초록(Success)');
    assert.strictEqual(find(p, 'dmpref:off').style, 2, 'OFF는 회색(Secondary)');
    dm.setDmEnabled('u-test', false);
    assert.strictEqual(dm.isDmEnabled('u-test'), false);
    p = dm.buildDmSettingPayload('u-test');
    assert.strictEqual(find(p, 'dmpref:on').disabled, false);
    assert.strictEqual(find(p, 'dmpref:off').disabled, true);
    dm.setDmEnabled('u-test', true);
    assert.strictEqual(dm.isDmEnabled('u-test'), true);
  });

  console.log(`\n카드 테스트 — 통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
