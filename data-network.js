/*
  <data-network> — fixed abstract "distributed system" WebGL backdrop.

  An intricate volumetric cloud of glowing nodes wired by faint connections, with
  data pulses flowing along the edges. The canvas is fixed behind the page (the
  host sets z-index); it never dictates scroll height. Instead the host page's
  scroll progress slowly flies / rotates the camera THROUGH the network, so the
  2D dashboard scrolling over the top gets a calm parallax depth cue.

  Attributes:
    accent    — primary node glow, hex (default #00E5FF)
    secondary — connection lines, hex (default #008899)
    bg        — scene fog / clear colour, hex (default #060B11)
    density   — node count multiplier (default 1)

  Reads window scroll progress internally; no host hooks required.
*/
(function () {
  if (customElements.get('data-network')) return;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  class DataNetwork extends HTMLElement {
    connectedCallback() {
      if (this._booted) return;
      this._booted = true;
      this._alive = true;
      this._setup().catch((e) => console.error('data-network:', e));
    }
    disconnectedCallback() {
      this._alive = false;
      cancelAnimationFrame(this._raf);
      window.removeEventListener('scroll', this._onScroll);
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('mousemove', this._onMouse);
      if (this._renderer) this._renderer.dispose();
    }

    async _setup() {
      const accentHex = this.getAttribute('accent') || '#00E5FF';
      const secHex = this.getAttribute('secondary') || '#008899';
      const bgHex = this.getAttribute('bg') || '#060B11';
      const density = parseFloat(this.getAttribute('density') || '1');

      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
      this.style.cssText = (this.style.cssText || '') + ';display:block;position:fixed;inset:0;overflow:hidden';
      this.appendChild(canvas);

      const THREE = await import('./assets3d/three.module.js');
      if (!this._alive) return;

      const accent = new THREE.Color(accentHex);
      const secondary = new THREE.Color(secHex);
      const bgColor = new THREE.Color(bgHex);

      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      this._renderer = renderer;

      const scene = new THREE.Scene();
      scene.background = bgColor.clone();
      scene.fog = new THREE.FogExp2(bgColor.clone(), 0.013);

      const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 400);
      const rig = new THREE.Group();
      scene.add(rig);

      // ---------- build the node cloud ----------
      // Nodes are scattered through an elongated volume (long along z, the flight
      // axis). Each node connects to a few nearest neighbours -> edges. A subset of
      // edges carry a travelling "packet".
      const mobile = window.innerWidth <= 680;
      const N = Math.round((mobile ? 190 : 340) * density);
      const SPAN_XY = 48;   // half-extent across
      const SPAN_Z = 130;   // half-extent along flight axis
      const nodes = [];
      for (let i = 0; i < N; i++) {
        // bias a little toward a couple of shells so it reads as structured, not pure noise
        const r = Math.pow(Math.random(), 0.7);
        nodes.push(new THREE.Vector3(
          (Math.random() * 2 - 1) * SPAN_XY * r,
          (Math.random() * 2 - 1) * SPAN_XY * 0.7 * r,
          (Math.random() * 2 - 1) * SPAN_Z
        ));
      }

      // edges: connect each node to nearest neighbours within a radius (capped)
      const MAXD = 26, MAXD2 = MAXD * MAXD, MAX_PER = 3;
      const edges = [];
      for (let i = 0; i < N; i++) {
        const cand = [];
        for (let j = 0; j < N; j++) {
          if (i === j) continue;
          const d2 = nodes[i].distanceToSquared(nodes[j]);
          if (d2 < MAXD2) cand.push([d2, j]);
        }
        cand.sort((a, b) => a[0] - b[0]);
        for (let k = 0; k < Math.min(MAX_PER, cand.length); k++) {
          const j = cand[k][1];
          if (j > i) edges.push([i, j]);
        }
      }

      // ---- line segments ----
      const linePos = new Float32Array(edges.length * 6);
      edges.forEach((e, k) => {
        const a = nodes[e[0]], b = nodes[e[1]];
        linePos.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6);
      });
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
      const lineMat = new THREE.LineBasicMaterial({ color: secondary.clone(), transparent: true, opacity: 0.26, blending: THREE.AdditiveBlending, depthWrite: false });
      const lines = new THREE.LineSegments(lineGeo, lineMat);
      rig.add(lines);

      // ---- node sprites (soft glow + bright core, two layers) ----
      const nodePos = new Float32Array(N * 3);
      nodes.forEach((n, i) => nodePos.set([n.x, n.y, n.z], i * 3));
      const nodeGeo = new THREE.BufferGeometry();
      nodeGeo.setAttribute('position', new THREE.BufferAttribute(nodePos, 3));

      const glowTex = makeGlow(THREE, accentHex);
      const coreTex = makeGlow(THREE, '#EAFBFF');
      const glowMat = new THREE.PointsMaterial({ size: 6.4, map: glowTex, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
      const coreMat = new THREE.PointsMaterial({ size: 2.1, map: coreTex, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
      const glowPts = new THREE.Points(nodeGeo, glowMat);
      const corePts = new THREE.Points(nodeGeo, coreMat);
      rig.add(glowPts); rig.add(corePts);

      // ---- travelling packets along a subset of edges ----
      const PK = Math.min(edges.length, Math.round((mobile ? 26 : 46) * density));
      const packetEdges = [];
      for (let i = 0; i < PK; i++) packetEdges.push(edges[(Math.random() * edges.length) | 0]);
      const pkPos = new Float32Array(PK * 3);
      const pkT = new Float32Array(PK);
      const pkSpeed = new Float32Array(PK);
      for (let i = 0; i < PK; i++) { pkT[i] = Math.random(); pkSpeed[i] = 0.06 + Math.random() * 0.12; }
      const pkGeo = new THREE.BufferGeometry();
      pkGeo.setAttribute('position', new THREE.BufferAttribute(pkPos, 3));
      const pkMat = new THREE.PointsMaterial({ size: 3.4, map: coreTex, color: accent.clone(), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
      const packets = new THREE.Points(pkGeo, pkMat);
      rig.add(packets);

      // ---------- interaction state ----------
      let targetP = 0, p = 0, mx = 0, my = 0, smx = 0, smy = 0;
      const updateTarget = () => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        targetP = max > 0 ? clamp(window.scrollY / max, 0, 1) : 0;
      };
      const setSize = () => {
        const w = window.innerWidth, h = Math.max(1, window.innerHeight);
        camera.aspect = w / h; camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
        updateTarget();
      };
      this._onScroll = updateTarget;
      this._onResize = setSize;
      this._onMouse = (e) => { mx = (e.clientX / window.innerWidth - 0.5) * 2; my = (e.clientY / window.innerHeight - 0.5) * 2; };
      window.addEventListener('scroll', this._onScroll, { passive: true });
      window.addEventListener('resize', this._onResize);
      window.addEventListener('mousemove', this._onMouse, { passive: true });
      setSize(); updateTarget(); p = targetP;

      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const clock = new THREE.Clock();
      const camPos = new THREE.Vector3();
      const lookAt = new THREE.Vector3();

      const tick = () => {
        if (!this._alive) return;
        this._raf = requestAnimationFrame(tick);
        const dt = Math.min(clock.getDelta(), 0.05);
        const time = performance.now() * 0.001;
        p += (targetP - p) * (reduced ? 1 : 1 - Math.pow(0.0006, dt));
        smx += (mx - smx) * 0.04; smy += (my - smy) * 0.04;

        // fly the camera along z through the cloud as the page scrolls; the travel stays
        // inside the dense core (±0.55 span) so ambient structure is always present.
        const z = lerp(SPAN_Z * 0.55, -SPAN_Z * 0.55, p);
        camPos.set(
          Math.sin(p * Math.PI * 1.4) * 12 + smx * 6 + Math.sin(time * 0.15) * 2,
          Math.cos(p * Math.PI * 1.1) * 8 - smy * 5 + Math.cos(time * 0.12) * 1.5,
          z
        );
        camera.position.lerp(camPos, reduced ? 1 : 0.06);
        lookAt.set(smx * 4, -smy * 3, camera.position.z - 40);
        camera.lookAt(lookAt);

        // slow overall rotation of the whole network for life
        rig.rotation.y = time * 0.012 + p * 0.5;
        rig.rotation.x = Math.sin(time * 0.08) * 0.03;

        // node breathing
        glowMat.opacity = 0.72 + Math.sin(time * 0.9) * 0.12;

        // advance packets along their edges
        const arr = pkGeo.attributes.position.array;
        for (let i = 0; i < PK; i++) {
          pkT[i] += pkSpeed[i] * dt;
          if (pkT[i] > 1) { pkT[i] -= 1; packetEdges[i] = edges[(Math.random() * edges.length) | 0]; }
          const e = packetEdges[i];
          const a = nodes[e[0]], b = nodes[e[1]];
          const t = pkT[i];
          arr[i * 3] = a.x + (b.x - a.x) * t;
          arr[i * 3 + 1] = a.y + (b.y - a.y) * t;
          arr[i * 3 + 2] = a.z + (b.z - a.z) * t;
        }
        pkGeo.attributes.position.needsUpdate = true;

        renderer.render(scene, camera);
      };
      tick();
    }
  }

  // radial-gradient sprite for soft glowing points
  function makeGlow(THREE, hex) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, hex);
    g.addColorStop(0.25, hex);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(32, 32, 32, 0, Math.PI * 2); ctx.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  customElements.define('data-network', DataNetwork);
})();
