import { duration } from './Session.js';

export const DROP_THRESHOLD = 3;
const MINIMUM_EVENT_DURATION = 10;
const BASELINE_WINDOW = 120;

const average = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

export function report(session) {
  const interval = session.sampleInterval;
  const spo2 = session.samples.map((s) => s.spo2).filter((v) => v != null);
  const pulse = session.samples.map((s) => s.pulse).filter((v) => v != null);
  const validDuration = spo2.length * interval;
  const below90 = spo2.filter((v) => v < 90).length * interval;
  const events = countDesaturations(session.samples.map((s) => s.spo2), interval);
  return {
    recordedDuration: duration(session),
    validDuration,
    averageSpO2: average(spo2),
    lowestSpO2: spo2.length ? Math.min(...spo2) : null,
    timeBelow90: below90,
    percentBelow90: validDuration > 0 ? (below90 / validDuration) * 100 : null,
    desaturationEvents: events,
    odi: validDuration > 0 ? events / (validDuration / 3600) : null,
    averagePulse: average(pulse),
    lowestPulse: pulse.length ? Math.min(...pulse) : null,
    highestPulse: pulse.length ? Math.max(...pulse) : null,
  };
}
export function countDesaturations(spo2, interval, threshold = DROP_THRESHOLD) {
  if (!(interval > 0)) return 0;
  const windowSamples = Math.max(1, Math.round(BASELINE_WINDOW / interval));
  const minimumRun = Math.max(1, Math.ceil(MINIMUM_EVENT_DURATION / interval));
  const window = [];
  let head = 0, sum = 0, run = 0, events = 0;
  const endRun = () => {
    if (run >= minimumRun) events++;
    run = 0;
  };
  spo2.forEach((value, i) => {
    while (head < window.length && window[head][0] < i - windowSamples) {
      sum -= window[head][1];
      head++;
    }
    if (value == null) return;
    const count = window.length - head;
    if (count > 0 && value <= sum / count - threshold) {
      run++;
      return;
    }
    endRun();
    window.push([i, value]);
    sum += value;
  });
  endRun();
  return events;
}
