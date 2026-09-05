// Shared deterministic terrain and spice placement. No rendering or client state.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.GameWorld = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const CONFIG = { worldSize: 1500, playerStart: { x: -380, z: -380 } };
  function mulberry32(seed) {
    return () => {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randomRange(min, max, rng) { return min + (max - min) * rng(); }
  function isInStartZone(x, z) { return Math.hypot(x + 380, z + 380) <= 12; }
  function createTerrain(seed, rng = mulberry32(seed)) {
    const duneLayers = [[30,.016],[26,.010],[20,.013],[9,.038],[7,.042],[1.8,.13]].map(([amp, mag]) => {
      const angle = rng() * Math.PI * 2;
      return {amp, xf: Math.cos(angle)*mag, zf: Math.sin(angle)*mag, phase: rng()*Math.PI*2};
    });
function createRockPatches() {
	      const patches = [];
	      const halfWorld = (CONFIG.worldSize * 0.5) - 90;

	      function canPlacePatch(x, z, radius, gap = 12) {
	        if (Math.abs(x) > halfWorld || Math.abs(z) > halfWorld) return false;
	        for (const patch of patches) {
	          const dx = x - patch.x;
	          const dz = z - patch.z;
	          const minDist = patch.radius + radius + gap;
	          if ((dx * dx) + (dz * dz) < minDist * minDist) return false;
	        }
	        return true;
	      }

	      function pushPatch(x, z, radius, plateauRadius, rise, major, approachAngle, gap = 12) {
	        if (!canPlacePatch(x, z, radius, gap)) return false;
	        patches.push({
	          x,
	          z,
	          radius,
	          plateauRadius,
	          rise,
	          major,
	          approachAngle,
	          seed: Math.floor(rng() * 0x7fffffff),
	        });
	        return true;
	      }

	      pushPatch(
	        CONFIG.playerStart.x,
	        CONFIG.playerStart.z,
	        39,
	        21,
	        12,
	        true,
	        rng() * Math.PI * 2,
	        0
	      );

	      // Sparse mid-distance ring: only a couple reachable safe spots after leaving spawn.
	      let nearStartPlaced = 0;
	      for (let attempt = 0; attempt < 180 && nearStartPlaced < 2; attempt += 1) {
	        const slot = attempt % 8;
	        const angle = ((slot / 8) * Math.PI * 2) + randomRange(-0.2, 0.2, rng);
	        const dist = randomRange(80, 160, rng);
	        const x = Math.cos(angle) * dist;
	        const z = Math.sin(angle) * dist;
	        if (isInStartZone(x, z)) continue;
	        if (
	          pushPatch(
	            x,
	            z,
	            randomRange(10.5, 16.5, rng),
	            randomRange(4.2, 7.8, rng),
	            randomRange(3.4, 5.8, rng),
	            false,
	            angle + Math.PI + randomRange(-0.55, 0.55, rng),
	            16
	          )
	        ) {
	          nearStartPlaced += 1;
	        }
	      }

	      // Far landmarks: visible on the horizon and rare.
	      let landmarkPlaced = 0;
	      for (let attempt = 0; attempt < 140 && landmarkPlaced < 2; attempt += 1) {
	        const angle = rng() * Math.PI * 2;
	        const dist = randomRange(420, halfWorld - 16, rng);
	        const x = Math.cos(angle) * dist;
	        const z = Math.sin(angle) * dist;
	        if (
	          pushPatch(
	            x,
	            z,
	            randomRange(27, 38, rng),
	            randomRange(12, 18, rng),
	            randomRange(8.4, 12.8, rng),
	            true,
	            angle + Math.PI + randomRange(-0.4, 0.4, rng),
	            18
	          )
	        ) {
	          landmarkPlaced += 1;
	        }
	      }

	      // Sparse outposts: long dangerous sand stretches between safe positions.
	      let outpostPlaced = 0;
	      for (let attempt = 0; attempt < 260 && outpostPlaced < 5; attempt += 1) {
	        const angle = rng() * Math.PI * 2;
	        const dist = randomRange(320, halfWorld - 24, rng);
	        const x = Math.cos(angle) * dist;
	        const z = Math.sin(angle) * dist;
	        const major = rng() < 0.16;
	        const radius = major
	          ? randomRange(18, 28, rng)
	          : randomRange(10.5, 17.5, rng);
	        const plateauRadius = major
	          ? randomRange(8, 12.5, rng)
	          : randomRange(4.2, 7.4, rng);
	        const rise = major
	          ? randomRange(6, 8.8, rng)
	          : randomRange(3.2, 5.4, rng);
	        if (
	          pushPatch(
	            x,
	            z,
	            radius,
	            plateauRadius,
	            rise,
	            major,
	            angle + Math.PI + randomRange(-0.55, 0.55, rng),
	            major ? 18 : 14
	          )
	        ) {
	          outpostPlaced += 1;
	        }
	      }

	      return patches;
	    }
    return { duneLayers, rockPatches: createRockPatches() };
  }
  function duneHeight(terrain, x, z) {
    return terrain.duneLayers.reduce((h, l) => h + Math.max(0, Math.sin(x*l.xf + z*l.zf + l.phase))*l.amp, 0);
  }
  function groundHeight(terrain, x, z) {
    let h = duneHeight(terrain, x, z);
    for (const p of terrain.rockPatches) {
      const d = Math.hypot(x-p.x,z-p.z);
      if (d > p.radius) continue;
      const t = d <= p.plateauRadius ? 1 : 1-(d-p.plateauRadius)/(p.radius-p.plateauRadius);
      h = Math.max(h, duneHeight(terrain,p.x,p.z) + p.rise*t);
    }
    return h;
  }
  function spicePosition(seed, id, cycle, type, nodes, terrain = createTerrain(seed)) {
    const valid = (x,z) => {
      if (terrain.rockPatches.some(p => Math.hypot(x-p.x,z-p.z) < p.radius + (type === 'plume' ? 140 : 46))) return false;
      return !nodes.some(n => n.id !== id && n.active && Number.isFinite(n.x) && Math.hypot(x-n.x,z-n.z) < 95);
    };
    if (id === 0) {
      for (const d of [92,104,116]) for (const a of [-.16,.16,-.3,.3,-.42,.42,0]) {
        const x=-380+Math.cos(a*Math.PI)*d, z=-380+Math.sin(a*Math.PI)*d;
        if (valid(x,z)) return {x,z};
      }
    }
    const rng = mulberry32((seed ^ Math.imul(id+1,0x9e3779b9) ^ Math.imul(cycle,0x517cc1b7)) >>> 0);
    for (let i=0;i<10000;i++) {
      const x=randomRange(-680,680,rng),z=randomRange(-680,680,rng);
      if (valid(x,z)) return {x,z};
    }
    throw new Error('Cannot place spice node');
  }
  function initialNodes(seed, terrain = createTerrain(seed)) {
    const nodes=[];
    for (let id=0;id<8;id++) {
      const type=id===7?'plume':'small';
      nodes.push({id,type,active:true,...spicePosition(seed,id,0,type,nodes,terrain)});
    }
    return nodes;
  }
  return {mulberry32, createTerrain, duneHeight, groundHeight, spicePosition, initialNodes};
});
