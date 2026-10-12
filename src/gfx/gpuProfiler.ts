import type * as THREE from 'three';

type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
export interface GpuStageSample { stage: string; ms: number; at: number }

/** Opt-in asynchronous stage timing. The owner disables whole-frame elapsed queries while enabled. */
export class GpuProfiler {
  enabled = false;
  readonly samples: GpuStageSample[] = [];
  private gl: WebGL2RenderingContext;
  private ext: TimerExtension | null;
  private pending: { query: WebGLQuery; stage: string }[] = [];
  private measuring = false;
  private contextAvailable = true;

  constructor(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get available() { return this.ext !== null; }

  contextLost() {
    this.enabled = false;
    this.contextAvailable = false;
    this.pending.length = 0; // WebGLQuery handles belong to the lost context; do not call GL cleanup.
    this.measuring = false;
    this.samples.length = 0;
  }

  contextRestored(renderer: THREE.WebGLRenderer) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending.length = 0;
    this.measuring = false;
    this.contextAvailable = true;
    this.enabled = false;
    this.samples.length = 0;
  }

  measure<T>(stage: string, work: () => T): T {
    this.poll();
    if (!this.enabled || !this.ext || this.measuring || this.pending.length >= 8) return work();
    const query = this.gl.createQuery();
    if (!query) return work();
    this.measuring = true;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    try { return work(); }
    finally {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.measuring = false;
      this.pending.push({ query, stage });
    }
  }

  poll() {
    if (!this.ext || !this.pending.length) return;
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const item = this.pending[0];
      if (!disjoint && !this.gl.getQueryParameter(item.query, this.gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) {
        const ms = this.gl.getQueryParameter(item.query, this.gl.QUERY_RESULT) / 1e6;
        if (Number.isFinite(ms) && ms > 0) this.samples.push({ stage: item.stage, ms, at: performance.now() });
      }
      this.gl.deleteQuery(item.query);
      this.pending.shift();
    }
    if (this.samples.length > 600) this.samples.splice(0, this.samples.length - 600);
  }

  reset() {
    if (this.measuring) return;
    if (this.contextAvailable) for (const item of this.pending) this.gl.deleteQuery(item.query);
    this.pending.length = 0;
    this.samples.length = 0;
  }
  dispose() {
    if (this.contextAvailable) for (const item of this.pending) this.gl.deleteQuery(item.query);
    this.pending.length = 0;
  }
}
