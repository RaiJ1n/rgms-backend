// utils/tapDebouncer.js
// Pure (the caller supplies the clock), so it can be tested with exact timings. observe(key, nowMs) ->
class TapDebouncer {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.last = new Map();
  }

  observe(key, nowMs) {
    const prev = this.last.get(key);
    const gap = prev === undefined ? null : nowMs - prev;
    this.last.set(key, nowMs);
    if (this.last.size > 64) {
      for (const [k, v] of this.last) if (nowMs - v > 60000) this.last.delete(k);
    }
    const isRepeat = this.windowMs > 0 && gap !== null && gap < this.windowMs;
    return { isNewTap: !isRepeat, gap };
  }
}

module.exports = { TapDebouncer };
