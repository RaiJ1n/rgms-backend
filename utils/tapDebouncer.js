// utils/tapDebouncer.js
//
// Sliding-window "same physical tap" detector, used by the serial bridge.
// Pure (the caller supplies the clock), so it can be tested with exact timings.
//
//   observe(key, nowMs) -> { isNewTap, gap }
//
// `gap` is the time since the PREVIOUS signal for that key (null the first
// time). A signal is a repeat of the current tap when gap < windowMs. Every
// signal - kept or ignored - moves the window forward, so a card that rests on
// the reader and keeps re-sending stays ONE tap however long it is held; a new
// tap needs the reader to have been quiet for windowMs (card lifted, then
// presented again). Different keys (different cards) never affect each other.
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
