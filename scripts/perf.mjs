// Profiles a big layout in headless Chromium: ~250 pieces tiled from the
// templates, several trains running, on a dressed scene. Reports frame
// times, the JS time spent per frame, and what the renderer drew.
//
//   npm run perf              (desktop, then a 4x CPU-throttled phone)
//   npm run perf -- --label before
//
// Needs the dev server's module URLs, so it starts Vite itself. Needs
// Playwright, which isn't a dependency: `npm i -D playwright`.

import { createServer } from 'vite';

const { chromium } = await import('playwright').catch(() => {
  console.error('npm run perf needs Playwright: npm i -D playwright');
  process.exit(1);
});

const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : '';
const SECONDS = Number(process.env.PERF_SECONDS ?? 6);

const server = await createServer({ logLevel: 'error', server: { port: 5199 } });
await server.listen();
const url = 'http://localhost:5199/';

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function run(name, { viewport, throttle, mobile }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.editor && window.trains);

  // Build the layout and trains through the app's own modules.
  const setup = await page.evaluate(async () => {
    const { TEMPLATES } = await import('/src/templates/templates.ts');
    const { transformPieces } = await import('/src/layout/layout.ts');
    const pieces = [];
    let n = 0;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const t = TEMPLATES[(row * 4 + col) % TEMPLATES.length].build();
        const uids = new Set(t.pieces.map((p) => p.uid));
        const moved = transformPieces(t, uids, { x: (col - 1.5) * 2200, y: (row - 1.5) * 1700, angle: 0 });
        for (const p of moved.pieces) pieces.push({ ...p, uid: `p${n++}` });
      }
    }
    window.editor.load({ pieces });
    window.setEnvironment('town');
    window.fitView();
    // Let the trains layer pick the layout up, then put a train on several loops.
    await new Promise((r) => setTimeout(r, 300));
    const sim = window.trains.sim;
    const edges = sim.network.edges;
    let trains = 0;
    for (let i = 0; i < edges.length && trains < 6; i += Math.floor(edges.length / 6)) {
      const e = edges[i];
      const consist = ['steam-engine', 'tender', 'coach', 'wagon', 'coach'].map((stockId) => ({ stockId, reversed: false }));
      const t = sim.addTrain(consist, { edgeKey: e.key, s: e.length / 2, reversed: false });
      if (typeof t !== 'string') {
        sim.setThrottle(t.id, 1);
        trains++;
      }
    }
    window.trains.setPaused?.(false);
    return { pieces: window.editor.layout.pieces.length, trains };
  });

  const cdp = await context.newCDPSession(page);
  if (throttle) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.waitForTimeout(1500);

  // Wrap the animation loop's work so we can time the JS part of each frame.
  const stats = await page.evaluate(async (seconds) => {
    const frames = [];
    let last = performance.now();
    const until = last + seconds * 1000;
    await new Promise((resolve) => {
      const step = (t) => {
        frames.push(t - last);
        last = t;
        if (t < until) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    return { frames };
  }, SECONDS);

  // A breakdown of the per-frame work, timed directly.
  const breakdown = await page.evaluate(async () => {
    const { editor, trains } = window;
    const { checkLayout } = await import('/src/planning/check.ts');
    const time = (f, n = 30) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) f(i);
      return (performance.now() - t0) / n;
    };
    const now = performance.now();
    return {
      trainsTickMs: time((i) => trains.tick(now + i * 16)),
      editorTickMs: time((i) => editor.tick(now + i * 16)),
      // An edit: nudge one piece, as a drag would, through the editor's change path.
      editMs: time((i) => {
        const l = editor.layout;
        editor.load({ ...l, pieces: l.pieces.map((p, j) => (j === 0 ? { ...p, pose: { ...p.pose, x: p.pose.x + (i % 2 ? -1 : 1) } } : p)) });
      }, 6),
      // The layout check after that edit, which the panel runs to keep its button current.
      checkMs: time((i) => {
        const l = editor.layout;
        checkLayout({ ...l, pieces: l.pieces.map((p, j) => (j === 0 ? { ...p, pose: { ...p.pose, x: p.pose.x + (i % 2 ? -1 : 1) } } : p)) });
      }, 6),
    };
  });

  const info = await page.evaluate(() => {
    // Draw calls and triangles of one frame, shadow pass included.
    const r = window.renderer;
    r.info.autoReset = false;
    r.info.reset();
    let root = window.editor.pieceObjects;
    while (root.parent) root = root.parent;
    r.render(root, window.orbit.object);
    r.info.autoReset = true;
    // Meshes per top-level group, to see where they come from.
    const groups = {};
    const layoutRoot = window.editor.pieceObjects.parent;
    for (const child of root.children) {
      if (child === layoutRoot) child.name ||= 'layout';
      else if (child.children.length === 4 && !child.name) child.name = 'trains';
      let n = 0;
      child.traverseVisible((o) => { if (o.isMesh) n++; });
      if (n) groups[child.name || child.type] = (groups[child.name || child.type] ?? 0) + n;
    }
    return { drawCalls: r.info.render.calls, triangles: r.info.render.triangles, groups: JSON.stringify(groups) };
  });

  const f = stats.frames.slice(Math.min(2, stats.frames.length - 1)).sort((a, b) => a - b);
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  const p = (q) => f[Math.min(f.length - 1, Math.floor(q * f.length))];
  const out = {
    profile: name,
    ...setup,
    frames: f.length,
    fps: +(1000 / mean).toFixed(1),
    meanMs: +mean.toFixed(1),
    p95Ms: +p(0.95).toFixed(1),
    ...Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, +v.toFixed(2)])),
    ...info,
  };
  await context.close();
  return out;
}

const results = [];
results.push(await run('desktop', { viewport: { width: 1280, height: 800 } }));
results.push(await run('phone (4x CPU throttle)', { viewport: { width: 390, height: 844 }, throttle: 4, mobile: true }));
await browser.close();
await server.close();
if (label) console.log(`# ${label}`);
console.table(results);
console.log(JSON.stringify(results));
