/* Minimal stand-ins for the bits of app.js the history module touches. */
var CLOCK = { now: 1700000000000 };
var Date = { now: function () { return CLOCK.now; } };
var state = { text: '', docDir: '', fileName: 'Untitled.md' };
var sent = [];
var BROKEN = false;
function send(type, payload) { if (BROKEN) return false; sent.push({ type: type, payload: payload }); return true; }
function setText(t) { state.text = t; }
function docText() { return state.text; }
function undoMark() {}
var window = { addEventListener: function () {} };
var setInterval = function () {};

HISTMODULE

module.exports = {
  CLOCK: CLOCK,
  state: state, sent: sent,
  histSnapshot: histSnapshot, histTrim: histTrim, histBytes: histBytes,
  histAt: histAt, histDelta: histDelta, histApply: histApply,
  histStats: histStats, histLoad: histLoad, histDump: histDump,
  histFlush: histFlush, breakBridge: function (b) { BROKEN = b; }, dirty: function () { return histDirty; }, histCommit: histCommit, capped: function () { return histCapped; }, histOldest: histOldest, histFind: histFind,
  docs: function () { return hist.docs; },
  key: function () { return histKey(); },
  limits: function () { return { BYTES: HIST_BYTES, DOCS: HIST_DOCS, MAX: HIST_MAX }; },
  setLimits: function (b, d, m) { if (b) HIST_BYTES = b; if (d) HIST_DOCS = d; if (m) HIST_MAX = m; },
  reset: function () { sent.length = 0; BROKEN = false; hist = { docs: {} }; histSizes = {}; histLast = 0; histSizes = {}; histDirty = false; histActivity = 0; histCapped = null; histDirty = false; }
};
