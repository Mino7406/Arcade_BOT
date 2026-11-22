// 요청대기열.js — Riot API 한도(1초 20회·2분 100회)를 넘지 않게 호출 순서와 간격을 맞춘다.
// 여유를 두고 기본은 1초 18회·2분 90회. 호출은 들어온 순서대로 나간다.
function createLimiter({ perSecond = 18, perWindow = 90, windowMs = 120000, maxQueue = 120, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let times = []; // 최근에 나간 호출 시각
  let pausedUntil = 0;
  let chain = Promise.resolve();
  let waiting = 0; // 아직 자리를 못 받고 기다리는 호출 수

  async function acquire() {
    for (;;) {
      const t = now();
      times = times.filter(x => x > t - windowMs);
      let wait = Math.max(0, pausedUntil - t);
      if (times.length >= perWindow) wait = Math.max(wait, times[times.length - perWindow] + windowMs - t);
      const recent = times.filter(x => x > t - 1000);
      if (recent.length >= perSecond) wait = Math.max(wait, recent[recent.length - perSecond] + 1000 - t);
      if (wait <= 0) break;
      await sleep(wait);
    }
    times.push(now());
  }

  // 자리(slot)는 순서대로 받고, fn 은 자리를 받은 뒤 바로 실행한다. fn 이 실패해도 뒤 호출은 막히지 않는다.
  // 줄이 maxQueue 를 넘으면 기다리게 하지 않고 바로 queueFull 오류로 거절한다(호출부가 "잠시 후 다시" 안내).
  function schedule(fn) {
    if (waiting >= maxQueue) return Promise.reject(Object.assign(new Error('요청 대기열이 가득 참'), { queueFull: true }));
    waiting++;
    const slot = chain.then(() => acquire().finally(() => { waiting--; }));
    chain = slot.catch(() => {});
    return slot.then(fn);
  }

  function penalize(ms) {
    pausedUntil = Math.max(pausedUntil, now() + ms);
  }

  return { schedule, penalize };
}

module.exports = { createLimiter };
