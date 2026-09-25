// The "Copy diagnostics" text, in exactly v0's format so reports from the two
// versions line up line for line. Pure: every host fact (user agent, screen,
// clock, long tasks) arrives in `env` from the platform, so this file never
// touches the browser. Runs on a click, so it is free to allocate.
import { S, layers } from '../../js/state.js';
import { bandName } from '../../js/util.js';
import { perfLines } from './perf.js';
import { choreSummary } from './chores.js';
import { guard, GUARD_TRIP } from '../../js/panel-guard.js';
import { displaySummary } from '../../js/display-watch.js';

export function buildDiagnostics(env) {
  const d = S.intervals.slice().sort((a, b) => a - b);
  const q = p => d.length ? d[Math.min(d.length - 1, Math.floor(d.length * p))] : 0;
  const med = q(0.5);
  const fpc = S.refreshHz && S.freq ? S.refreshHz / S.freq : 0;
  const audioOn = S.audioOnBoot !== false;

  const lines = [
    `Open Focus frame diagnostics`,
    `time            ${env.nowISO}`,
    `userAgent       ${env.userAgent}`,
    `renderer        WebGPU  (v1, one surface)`,
    `viewport        ${S.W} x ${S.H} css px @ DPR ${S.DPR}`,
    `screen          ${env.screenW} x ${env.screenH}`,
    // the engine's thread: the worker platform's env() says 'worker' (v1's
    // Engine thread control); the page's says nothing, which reads as v0's 'main'
    `frame source    ${env.frameSource || 'main'}`,
    ``,
    `requested freq  ${S.freq.toFixed(1)} Hz  (${bandName(S.freq)})`,
    `frame pattern   ${S.litLog.join('') || '(not running)'}`,
    `frame lock      ${S.frameLock ? 'ON, achieving ' + S.achievedFreq.toFixed(2) + ' Hz at ' + S.framesPerCycle + ' frames/cycle'
                      + (S.framesPerCycle % 2 ? ', spare frame ' + S.spareMode : '') : 'off'}`,
    `measured refresh${S.refreshHz ? ' ' + S.refreshHz.toFixed(2) + ' Hz' : ' -'}`,
    // v1 only (js/display-watch.js): the engine's clock, the page's own (worker
    // mode, where the two can disagree after a window moves between screens),
    // and the screen as last read, with how often it has changed
    `display clocks  ${displaySummary(S.refreshHz, env.frameSource === 'worker')}`,
    `frames/cycle    ${fpc ? fpc.toFixed(3) : '-'}  ${fpc && Number.isInteger(+fpc.toFixed(3)) ? '(divides evenly)' : '(does not divide evenly)'}`,
    // js/panel-guard.js: how far the lit frames lean onto one refresh polarity
    `panel imbalance ${guard.imbalance.toFixed(3)}  (pauses above ${GUARD_TRIP}; ${guard.trips} pause${guard.trips === 1 ? '' : 's'} this session${guard.simHz ? ', simulating ' + guard.simHz + ' Hz' : ''})`,
    ``,
    `frame intervals over last ${d.length} frames:`,
    `  median        ${med.toFixed(2)} ms`,
    `  p95           ${q(0.95).toFixed(2)} ms`,
    `  p99           ${q(0.99).toFixed(2)} ms`,
    `  worst         ${(d[d.length - 1] || 0).toFixed(2)} ms`,
    `  best          ${(d[0] || 0).toFixed(2)} ms`,
    `  spread        ${((d[d.length - 1] || 0) - (d[0] || 0)).toFixed(2)} ms`,
    `  dropped       ${S.dropCount}  (interval > 1.5x median)`,
    `main-thread long tasks (5s)  ${env.longTasks}`,
    // v1 only: dark-frame chore runs (core/chores.js), forced = run on a lit slot by the wait cap
    `dark-frame chores  ${choreSummary()}`,
    // perf mode (localStorage signal_perf = '1') adds its lines here, at the
    // end of the frame section; with it off this adds nothing, and the text
    // is v0's line for line
    ...perfLines(),
    ``,
    `active layers   ${Object.entries(layers).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`,
    `audio           ${audioOn ? S.carrierHz + ' Hz carrier' : 'off'}`,
    `audio pips      ${S.pipMs} ms at ${S.carrierHz} Hz`,
    `edge density    ${S.edgeCount}   trail ${S.trailMul}x   size ${S.edgeSize}x   speed ${S.edgeSpeedMul}x   dir ${S.edgeDir}`,
    `ring spread     ${S.ringSpeedMul}x   fade in ${Math.round(S.ringFade * 100)}%`,
    ``,
    `raw intervals (ms, chronological):`,
    S.intervals.map(x => x.toFixed(1)).join(' ')
  ];
  return lines.join('\n');
}
