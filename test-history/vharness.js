/* Virtual clock: Date.now, setTimeout and clearTimeout all run off CLOCK, so a
   debounce fires exactly when the simulated wall clock says it should. */
var CLOCK = { now: 1700000000000 };
var Date = { now: function () { return CLOCK.now; } };
var TIMERS = [], TID = 1;
function setTimeout(fn, ms) { var id = TID++; TIMERS.push({ id: id, at: CLOCK.now + ms, fn: fn }); return id; }
function clearTimeout(id) { TIMERS = TIMERS.filter(function (t) { return t.id !== id; }); }
function advance(ms) {
  var end = CLOCK.now + ms;
  for (;;) {
    var due = TIMERS.filter(function (t) { return t.at <= end; }).sort(function (a, b) { return a.at - b.at; })[0];
    if (!due) break;
    TIMERS = TIMERS.filter(function (t) { return t.id !== due.id; });
    CLOCK.now = due.at;
    due.fn();
  }
  CLOCK.now = end;
}
var state = { text: '', docDir: '', fileName: 'Untitled.md' };
var sent = [];
function send(type, payload) { sent.push({ type: type, payload: payload }); }
function setText(t) { state.text = t; }
function undoMark() {}
var window = { addEventListener: function () {} };
var setInterval = function () {};

HISTMODULE

module.exports = {
  CLOCK: CLOCK, advance: advance, state: state, sent: sent,
  histSnapshot: histSnapshot, histBytes: HISTBYTES,
  flush: FLUSHFN,
  reset: function () { hist = { docs: {} }; histLast = 0; TIMERS = []; sent.length = 0; }
};
