import * as THREE from 'three';
import type { Game } from '../game';
import { ThalassaModel } from './thalassaModel';
import { PADDLE_VARIANTS, type PaddleVariantId } from './paddleVariants';

/** Opt-in development instrumentation, never mounted in normal voyages. */
export function installPaddlePanel(game: Game) {
  const model = game.model as ThalassaModel, drive = model.paddleDrive!;
  const panel = document.createElement('section'); panel.id = 'paddle-lab';
  panel.innerHTML = `<style>
#paddle-lab{pointer-events:auto;position:fixed;right:18px;top:18px;width:340px;box-sizing:border-box;max-height:calc(100vh - 36px);overflow-y:auto;background:rgba(20,29,29,.94);color:#ede6d3;padding:18px;font:12px/1.6 ui-monospace,monospace;border:1px solid #647069;z-index:40}
#paddle-lab.folded{width:230px}#paddle-lab.folded>:not(style):not(h2):not([data-fold]){display:none}#paddle-lab [data-fold]{float:right;padding:0 5px}#paddle-lab h2{font:20px Georgia,serif;margin:0 0 5px}#paddle-lab small{color:#b2beb5;display:block}#paddle-lab button,#paddle-lab select{font:inherit;background:#34463f;color:#f4ead0;border:1px solid #718177;padding:5px 8px;cursor:pointer}#paddle-lab button[aria-pressed="true"]{background:#d4b675;color:#1a2420;border-color:#d4b675}#paddle-design-name{font:22px Georgia,serif;display:block;margin:10px 0 5px}#paddle-design-feel{color:#d4b675;margin-top:5px}#paddle-lab label{display:flex;justify-content:space-between;align-items:center;margin-top:10px}#paddle-lab input{width:145px;accent-color:#d4b675}#paddle-lab .buttons{display:flex;gap:5px;margin:12px 0;flex-wrap:wrap}#paddle-lab pre{font:11px/1.7 ui-monospace,monospace;margin:12px 0;white-space:pre-wrap}#paddle-lab details{margin-top:8px;border-top:1px solid #53655c;padding-top:8px}#paddle-lab summary{cursor:pointer}@media(max-width:750px){#paddle-lab{width:235px;right:8px;top:8px;padding:12px;font-size:10px}}
</style><button data-fold aria-label="Toggle paddle tools">−</button><h2>Thalassa · Twin paddles</h2><small>Experimental ancient machinery / four studies</small>
<div class="buttons" role="group" aria-label="Paddle design">${Object.entries(PADDLE_VARIANTS).map(([id, v], i) => `<button data-variant="${id}" aria-pressed="${id === model.paddleVariant}">${['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'][i]} ${v.name}</button>`).join('')}</div>
<strong id="paddle-design-name"></strong><small id="paddle-design-description"></small><small id="paddle-design-feel"></small>
<div class="buttons"><button data-compare>Restart · paddles only</button></div>
<small>Refit stops shafts. Restart furls sails &amp; drives ahead from the same position; waves continue.</small>
<details><summary>Engineering schedule</summary><pre id="paddle-spec"></pre><small>Timber 650 kg/m³ · bronze 8,700 kg/m³. Component volumes set mass. Wheel inertia integrated; sweeps/chain use equivalent drive inertia. Hidden transmission allowance: wheel 8 t, long drives 12 t. Speculative machinery, unvalidated stresses.</small></details>
<label>Active watch <select aria-label="Active watch"><option value="6">80 people · 6 kW</option><option value="12" selected>160 people · 12 kW</option><option value="24">320 people · 24 kW</option></select></label>
<small>75 W/person · same source budget across designs</small>
<div class="buttons"><button data-view="quarter">Quarter view</button><button data-view="side">Side view</button><button data-view="detail">Mechanism view</button></div><div class="buttons"><button data-mode="ahead">Ahead</button><button data-mode="port">Pivot port</button><button data-mode="starboard">Pivot stbd</button><button data-mode="coast">Coast</button><button data-mode="helm">W/S + A/D</button></div>
<label>Port <input aria-label="Port paddle command" type="range" min="-1" max="1" step=".05" value="0"></label>
<label>Starboard <input aria-label="Starboard paddle command" type="range" min="-1" max="1" step=".05" value="0"></label>
<small>Opposite banks turn the ship. Neutral freewheels.</small><pre id="paddle-readout"></pre>
<details><summary>Power, waves &amp; export</summary><pre id="paddle-energy"></pre><small>Source watts are mechanical effort before gears. Three-hour watch assumption; relief crews required. Water loads and gearing are estimates.</small><div class="buttons"><button data-export>Export CSV</button><button data-furl>Furl sails</button><button data-reset>Reset trial</button></div></details>`;
  document.getElementById('ui')!.appendChild(panel);
  const state = document.createElement('script'); state.type = 'application/json'; state.id = 'paddle-review-state';
  document.getElementById('ui')!.appendChild(state);
  panel.querySelector<HTMLButtonElement>('[data-fold]')!.onclick = () => panel.classList.toggle('folded');
  panel.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.onclick = () => {
    game.player.mode = 'chase';
    game.player.orbitLock = true;
    game.player.chaseYaw = button.dataset.view === 'quarter' ? -0.85 : button.dataset.view === 'detail' && model.paddleVariant === 'basileus' ? -.72 : -1.57;
    game.player.chasePitch = button.dataset.view === 'detail' ? 0.10 : 0.19;
    game.player.chaseDist = button.dataset.view === 'detail' ? 48 : button.dataset.view === 'side' ? 85 : 100;
  });
  panel.querySelector('select')!.addEventListener('change', event => drive.setWatchPower(game.ship, Number((event.target as HTMLSelectElement).value)));
  const sliders = [...panel.querySelectorAll<HTMLInputElement>('input')];
  sliders.forEach((s, i) => s.addEventListener('input', () => { drive.manual = true; drive.commands[i] = Number(s.value); }));
  panel.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.onclick = () => {
    drive.manual = button.dataset.mode !== 'helm';
    const mode = button.dataset.mode;
    drive.commands = mode === 'ahead' ? [1, 1] : mode === 'port' ? [-1, 1] : mode === 'starboard' ? [1, -1] : [0, 0];
    if (mode === 'helm') { game.crew.setOrder(1); game.player.orbitLock = false; }
  });
  panel.querySelector<HTMLButtonElement>('[data-furl]')!.onclick = () => game.ship.sailTarget = 0;
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(game.ship.quat);
  const start = { x: game.ship.pos.x, z: game.ship.pos.z, heading: Math.atan2(forward.x, -forward.z) };
  const rows: Record<string, number | string>[] = [];
  const updateDesign = () => {
    const id = model.paddleVariant!, v = PADDLE_VARIANTS[id], g = drive.geometry;
    panel.querySelector('#paddle-design-name')!.textContent = `${v.name} / ${v.subtitle}`;
    panel.querySelector('#paddle-design-description')!.textContent = v.description;
    panel.querySelector('#paddle-design-feel')!.textContent = v.feel;
    panel.querySelectorAll<HTMLButtonElement>('[data-variant]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.variant === id)));
    const ratio = { helios: 1.5, polypous: 1.5, basileus: 1, scarab: .3 }[id];
    const diameter = g.axleDiameter!, e = model.paddleEngineering!;
    const shaftStress = 16 * g.maxTorque / (Math.PI * diameter ** 3) / 1e6;
    const bearingLoad = e.rotorMass * 9.81 / 2;
    const bend = 32 * (2 * e.rotorMass * 9.81 * (g.width + .9) / 4) / (Math.PI * diameter ** 3) / 1e6;
    const geometryText = g.mechanism === 'oars' ? `8 rowers/side · 56 m station span\nRigid oars · ${g.outboard} m outboard / ${g.inboard} m inboard\nBlade ${g.bladeHeight} × ${g.width} m\nWorking area ${(g.bladeHeight*g.width*g.areaFactor!).toFixed(2)} m²/oar\nFeathered recovery · bronze rowlocks` : g.mechanism === 'sweeps'
      ? `8 sweeps/side · 56 m station span\n2 × 5 m articulated links per sweep\nStroke ${(2*g.radius).toFixed(1)} m · lift 5.2 m\nBlade ${g.width} × ${g.bladeHeight} m`
      : g.mechanism === 'chain'
      ? `Track ${(2*g.trackHalfLength!+2*g.radius).toFixed(1)} m long/side\n${g.blades} boards/side · ${g.width} × ${g.bladeHeight} m\nWorking depth ${(g.radius-g.y).toFixed(1)} m before sinkage\nDrums Ø ${(2*g.radius).toFixed(1)} m`
      : `Blade centres Ø ${(2*g.radius).toFixed(1)} m · width ${g.width} m\n${g.blades} boards × ${g.bladeHeight} m radial span\nSwept Ø ${(2*g.radius+g.bladeHeight).toFixed(2)} m\nCalm-water dip ${(g.radius+g.bladeHeight/2-g.y).toFixed(2)} m before sinkage`;
    panel.querySelector('#paddle-spec')!.textContent = `${geometryText}\nMachinery ${(g.machineryMass/1000).toFixed(1)} t + active crew\nEquivalent drive inertia ${(g.inertia/1000).toFixed(0)} t·m²/side\nCapstan → cycle ${ratio}:1\nTransmission ${(g.gearEfficiency*100).toFixed(0)}%\nDrive torque limit ${(g.maxTorque/1000).toFixed(1)} kN·m/side\nCycle limit ${(g.maxOmega*60/(2*Math.PI)).toFixed(2)} rpm` + (id === 'helios' ? `\nØ ${(diameter*1000).toFixed(0)} mm axle · torsion ${shaftStress.toFixed(2)} MPa\n2× weight bending screen ${bend.toFixed(1)} MPa\nStatic bearing ${(bearingLoad/1000).toFixed(0)} kN` : `\nEquivalent inertia includes moving timber.\nLink/chain elasticity & stresses unvalidated.`);

  };
  panel.querySelectorAll<HTMLButtonElement>('[data-variant]').forEach(button => button.onclick = () => {
    model.setPaddleVariant(button.dataset.variant as PaddleVariantId); rows.length = 0; updateDesign();
    const url = new URL(location.href); url.searchParams.set('paddle', model.paddleVariant!); history.replaceState(null, '', url);
  });
  updateDesign();
  panel.querySelector<HTMLButtonElement>('[data-compare]')!.onclick = () => {
    game.ship.place(start.x, start.z, start.heading); game.ship.sailTarget = 0;
    game.crew.holdWater = false; game.ship.helm = 0; drive.manual = true; drive.commands = [1, 1]; rows.length = 0;
  };
  panel.querySelector<HTMLButtonElement>('[data-reset]')!.onclick = () => {
    game.ship.place(start.x, start.z, start.heading); game.ship.sailTarget = 0; game.crew.setOrder(1);
    game.ship.helm = 0; drive.manual = true; drive.commands = [0, 0]; rows.length = 0;
  };
  panel.querySelector<HTMLButtonElement>('[data-export]')!.onclick = () => {
    if (!rows.length) return;
    const keys = Object.keys(rows[0]), csv = [keys.join(','), ...rows.map(r => keys.map(k => r[k]).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'thalassa-paddles.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const readout = panel.querySelector('#paddle-readout')!, energy = panel.querySelector('#paddle-energy')!;
  setInterval(() => {
    const [p, s] = drive.wheels, sum = (key: 'sourceW' | 'shaftW' | 'storedW' | 'frictionW' | 'numericalW') => p[key] + s[key];
    sliders.forEach((slider, i) => { if (document.activeElement !== slider) slider.value = String(drive.commands[i]); });
    readout.textContent = `                 PORT     STBD\nCycle RPM    ${p.rpm.toFixed(2).padStart(8)} ${s.rpm.toFixed(2).padStart(8)}\nThrust kN    ${(p.thrust / 1000).toFixed(2).padStart(8)} ${(s.thrust / 1000).toFixed(2).padStart(8)}\nShaft kW     ${(p.shaftW / 1000).toFixed(2).padStart(8)} ${(s.shaftW / 1000).toFixed(2).padStart(8)}\n\nSpeed ${(game.ship.speed * 1.943844).toFixed(2)} kn · yaw ${(game.ship.angVel.y * -180 / Math.PI).toFixed(3)} °/s\nPaddle yaw ${(drive.wrench.torque.y / -1000).toFixed(1)} kN·m\nInput ${(sum('sourceW') / 1000).toFixed(2)} / ${drive.sourceKW.toFixed(1)} kW · ${drive.manual ? 'Independent shafts' : 'Helm mixer'}`;
    energy.textContent = `Immersed ${(p.wetArea + s.wetArea).toFixed(2)} m²\nRotor storage Δ ${(sum('storedW') / 1000).toFixed(2)} kW\nBearing loss ${(sum('frictionW') / 1000).toFixed(2)} kW\nWater dissipation ${(drive.dissipationW / 1000).toFixed(2)} kW\nWave work ${(drive.waveW / 1000).toFixed(2)} kW\nHull work ${(drive.hullW / 1000).toFixed(2)} kW\nIntegration residual ${sum('numericalW').toFixed(2)} W\nDrive CPU ${drive.cpuMs.toFixed(3)} ms/step`;
    rows.push({ variant: model.paddleVariant!, time_s: game.ship.time, source_limit_W: drive.sourceKW * 1000, source_W: sum('sourceW'), shaft_W: sum('shaftW'),
      port_command: drive.commands[0], stbd_command: drive.commands[1], port_rpm: p.rpm, stbd_rpm: s.rpm,
      port_thrust_N: p.thrust, stbd_thrust_N: s.thrust, yaw_moment_Nm: -drive.wrench.torque.y,
      speed_kn: game.ship.speed * 1.943844, heading_rad: game.ship.heading, yaw_rad_s: -game.ship.angVel.y,
      hull_W: drive.hullW, waves_W: drive.waveW, water_loss_W: drive.dissipationW, friction_W: sum('frictionW'),
      rotor_storage_W: sum('storedW'), integration_W: sum('numericalW'), wind_m_s: game.wind.meanSpeed,
      sails: game.ship.sailSet, heel_rad: game.ship.heel, machinery_kg: drive.geometry.machineryMass, active_crew_kg: drive.sourceKW * 1000 / 75 * 80, mass_kg: game.ship.mass, cpu_ms: drive.cpuMs });
    if (rows.length > 14400) rows.shift();
    state.textContent = JSON.stringify({ ...rows[rows.length - 1], reaction_W: drive.reactionW,
      lastPassDrawCalls: game.pipeline.renderer.info.render.calls, lastPassTriangles: game.pipeline.renderer.info.render.triangles,
      gpuMs: game.pipeline.gpuMs, finite: [...game.ship.pos, ...game.ship.vel, ...game.ship.angVel].every(Number.isFinite),
      grounding: game.ship.grounding, rows: rows.length, mode: drive.manual ? 'independent' : 'helm',
      rotorAngle: drive.wheels.map(w => w.angle), coordinates: game.ship.pos.toArray(),
      terrainHeight: game.terrain.heightAt(game.ship.pos.x, game.ship.pos.z) });
  }, 250);
  Object.assign(window, { paddleLab: { drive, rows, get geometry() { return drive.geometry; } } });
}
