// Summarize the review page's exported raw samples without inferring GPU time from FPS.
import fs from 'node:fs';
const files = process.argv.slice(2);
if (!files.length) throw new Error('Supply one or more shadow review JSON files');
function stats(values) {
  const a = values.slice().sort((a, b) => a - b);
  const at = q => a[Math.min(a.length - 1, Math.floor(q * a.length))] ?? null;
  return { count: a.length, median: at(.5), p95: at(.95), p99: at(.99) };
}
const rows = [];
for (const file of files) {
  for (const m of JSON.parse(fs.readFileSync(file, 'utf8')).measurements) {
    const n = m.frames[0]?.shadows.length ?? 0;
    const complete = m.frames.every(f => f.shadows.length === n) && m.gpu.length === m.frames.length * n;
    const gpu = [];
    if (m.mode === 'shadow' && n && complete) {
      for (let i = 0; i < m.gpu.length; i += n) gpu.push(m.gpu.slice(i, i + n).reduce((sum, s) => sum + s.ms, 0));
    }
    rows.push({ file, mode: m.mode, policy: m.state.policy ?? (m.state.revision === 'baseline' ? 'baseline' : 'shared'),
      view: m.view, hour: m.hour, live: m.live, cap: m.state.cap ?? 60,
      intervalsMs: stats(m.frames.map(f => f.intervalMs)),
      shadowUpdates: stats(m.frames.map(f => f.shadows.length)),
      shadowDraws: stats(m.frames.map(f => f.shadows.reduce((sum, s) => sum + s.calls, 0))),
      shadowTriangles: stats(m.frames.map(f => f.shadows.reduce((sum, s) => sum + s.triangles, 0))),
      shadowCpuMs: stats(m.frames.map(f => f.shadows.reduce((sum, s) => sum + s.cpuMs, 0))),
      shadowGpuMs: stats(gpu), wholeFrameGpuMs: stats(m.mode === 'frame' ? m.gpu.map(s => s.ms) : []),
      pairedShadowQueriesComplete: m.mode === 'shadow' ? complete : null, state: m.state });
  }
}
console.log(JSON.stringify(rows, null, 2));
