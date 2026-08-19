/* Thirty minutes of realistic writing: bursts of keystrokes broken by the
   pauses a person actually takes — end of sentence, choosing a word, reading
   back. Those pauses are what trigger the shell's autosave, and the autosave
   is what used to drive a history write.

   The shell: `dirty` reschedules autosave for 1.0s later; when it lands it
   calls App.autoSaved(). Modelled exactly. */
var which = process.argv[2];
var H = require(which === 'before' ? './v-old.js' : './v-new.js');

H.reset();
H.state.docDir = '/notes'; H.state.fileName = 'draft.md';
var text = '# Draft\n\n';
for (var w = 0; w < 600; w++) text += 'word' + w + ' ';
H.state.text = text;
H.advance(1000); H.histSnapshot(true); H.advance(25000);
H.sent.length = 0;                       /* measure the session, not the setup */

var rnd = (function (s) { return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })(42);
var SESSION = 1800000, elapsed = 0;
var autosaveDue = null, sweepDue = 20000;

function step(ms) {
  /* advance in slices so the 20s sweep and the 1s autosave land in order */
  while (ms > 0) {
    var slice = Math.min(ms, 250);
    H.advance(slice); ms -= slice; elapsed += slice;
    sweepDue -= slice;
    if (sweepDue <= 0) { sweepDue += 20000; H.sweep(); }
    if (autosaveDue !== null) {
      autosaveDue -= slice;
      if (autosaveDue <= 0) {
        autosaveDue = null;
        /* App.autoSaved() */
        if (which === 'before') H.histSnapshot(true);   /* forced, the old way */
        else H.histSnapshot();                          /* unforced, the new way */
      }
    }
  }
}

while (elapsed < SESSION) {
  /* a burst: 4-20 keystrokes at ~200ms */
  var n = 4 + Math.floor(rnd() * 16);
  for (var i = 0; i < n; i++) {
    text += 'w';
    H.state.text = text;
    H.edit();                         /* markDirty(true) on every input */
    autosaveDue = 1000;               /* scheduleAutosave: cancel + reschedule */
    step(200);
  }
  /* a pause: 1-9 seconds, long enough for autosave to land */
  step(1000 + Math.floor(rnd() * 8000));
}
step(40000);                          /* they go and make tea */

var msgs = H.sent.filter(function (s) { return s.type === 'histWrite' || s.type === 'pref'; });
var bytes = msgs.reduce(function (n, s) {
  return n + ((s.payload && (s.payload.json || s.payload.value)) || '').length;
}, 0);
console.log((which === 'before' ? 'BEFORE' : 'AFTER ') +
            ' | ' + String(msgs.length).padStart(4) + ' writes' +
            ' | ' + String((bytes / 1048576).toFixed(1)).padStart(5) + ' MB serialised and pushed' +
            ' | store ' + H.histBytes() + ' bytes' +
            ' | via ' + (which === 'before' ? 'UserDefaults' : 'sidecar file'));
