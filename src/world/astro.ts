import * as THREE from 'three';

/**
 * Astronomical clock. Time is in hours of local solar time; the date advances with each day.
 * Latitude of the Cyclades, date near midsummer. Directions returned in world space
 * (x = east, y = up, z = south; north = -z).
 */
export class AstroClock {
  latitude = (37.4 * Math.PI) / 180;
  dayOfYear = 172; // ~21 June
  hours = 7.4;
  /** real seconds per game hour. 60 => a 24 minute day */
  secondsPerHour = 60;
  timeScale = 1;
  dayCount = 0;

  sunDir = new THREE.Vector3();
  moonDir = new THREE.Vector3();
  /** moon phase 0..1 (0 = new, 0.5 = full) */
  moonPhase = 0.43;
  /** local sidereal rotation angle for stars (radians) */
  siderealAngle = 0;

  update(dt: number) {
    this.hours += (dt * this.timeScale) / this.secondsPerHour;
    while (this.hours >= 24) {
      this.hours -= 24;
      this.dayOfYear = (this.dayOfYear + 1) % 365;
      this.dayCount++;
      this.moonPhase = (this.moonPhase + 1 / 29.53) % 1;
    }
    this.compute();
  }

  compute() {
    const decl = ((23.44 * Math.PI) / 180) * Math.sin(((2 * Math.PI) / 365) * (this.dayOfYear - 81));
    const H = ((this.hours - 12) / 24) * Math.PI * 2; // hour angle
    this.celestialToWorld(decl, H, this.sunDir);
    // Moon: ~12.2 deg/day behind the sun in RA; phase angle maps to elongation.
    const elong = this.moonPhase * Math.PI * 2;
    const moonDecl = decl * Math.cos(elong) + 0.09 * Math.sin(elong * 1.3);
    this.celestialToWorld(moonDecl, H - elong, this.moonDir);
    this.siderealAngle = H + ((this.dayOfYear / 365) * Math.PI * 2);
  }

  /** declination + hour angle -> world direction (alt/az for our latitude) */
  private celestialToWorld(decl: number, H: number, out: THREE.Vector3) {
    const lat = this.latitude;
    const sinAlt = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H);
    const alt = Math.asin(sinAlt);
    const cosAz = (Math.sin(decl) - Math.sin(alt) * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat));
    let az = Math.acos(Math.min(1, Math.max(-1, cosAz))); // from north
    if (Math.sin(H) > 0) az = Math.PI * 2 - az;
    out.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
    return out;
  }

  get timeString() {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
