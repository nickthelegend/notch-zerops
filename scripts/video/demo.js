/**
 * The demo driver, injected into the running Notch window.
 *
 * Everything here is a REAL interaction with the real app: real elements, real events, real
 * network calls to the real Zerops API, real results. Nothing is staged. If a step fails the
 * take shows it failing, and the fix is to fix the app.
 *
 * THE POINTER IS DRAWN, NOT THE HARDWARE CURSOR. A hardware cursor moves in jumps, and any
 * notification on the machine can steal it mid-take. An SVG pointer eased with
 * requestAnimationFrame moves like a hand, and — because the click is dispatched at the
 * element the pointer has arrived at — it always lands on what it is pointing to. The click
 * ring matters for the same reason: the pointer is already still when the press happens, so
 * without a ring a click reads as nothing happening at all.
 *
 * ONE CLOCK. Each beat is held for at least the duration of its own narration audio, measured
 * from the generated files, plus a breath. The driver logs `DEMO_LINE <ms> <id>` the instant a
 * beat opens, and the edit is cut from that log — never by eye.
 */
(() => {
  const CFG = window.__DEMO_CFG;                       // { durations: {id: seconds}, token, repo, project }
  const BREATH = 450;
  const log = (...a) => console.log(...a);

  /* ------------------------------------------------------------ pointer */

  const NS = 'http://www.w3.org/2000/svg';
  const layer = document.createElement('div');
  layer.id = '__demo_layer';
  Object.assign(layer.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none',
  });
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.overflow = 'visible';

  const ring = document.createElementNS(NS, 'circle');
  ring.setAttribute('r', '0');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', '#67e8f9');
  ring.setAttribute('stroke-width', '2');
  ring.setAttribute('opacity', '0');

  // A pointer with a dark outline, so it stays readable over both the near-black canvas and
  // the near-white primary buttons.
  const ptr = document.createElementNS(NS, 'path');
  ptr.setAttribute('d', 'M0,0 L0,17 L4.2,13.2 L6.8,19.2 L9.6,18 L7,12.1 L12.4,12 Z');
  ptr.setAttribute('fill', '#ffffff');
  ptr.setAttribute('stroke', 'rgba(0,0,0,.55)');
  ptr.setAttribute('stroke-width', '1.1');
  ptr.setAttribute('stroke-linejoin', 'round');

  svg.append(ring, ptr);
  layer.append(svg);
  document.body.append(layer);

  const P = { x: innerWidth * 0.5, y: innerHeight * 0.72 };
  const draw = () => {
    ptr.setAttribute('transform', `translate(${P.x},${P.y})`);
    ring.setAttribute('cx', P.x);
    ring.setAttribute('cy', P.y);
  };
  draw();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  function glide(x, y, ms = 620) {
    return new Promise((done) => {
      const sx = P.x; const sy = P.y;
      const dx = x - sx; const dy = y - sy;
      if (Math.hypot(dx, dy) < 1) { done(); return; }
      const t0 = performance.now();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        P.x = x; P.y = y; draw();
        done();
      };
      /*
       * A hard deadline as well as the frame loop.
       *
       * rAF does not fire while the window is occluded, and a take hung here for fifteen
       * minutes waiting for a frame that was never coming — no timeout, no error, just an
       * animation that never ended. `backgroundThrottling: false` fixes the cause; this makes
       * the driver survive it anyway, because a demo script must fail loudly or not at all.
       */
      const guard = setTimeout(finish, ms + 1500);
      const step = (now) => {
        if (finished) return;
        const t = Math.min(1, (now - t0) / ms);
        const e = easeInOut(t);
        P.x = sx + dx * e; P.y = sy + dy * e;
        draw();
        if (t < 1) requestAnimationFrame(step);
        else { clearTimeout(guard); finish(); }
      };
      requestAnimationFrame(step);
    });
  }

  function ping() {
    const t0 = performance.now();
    const DUR = 460;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / DUR);
      ring.setAttribute('r', String(4 + 26 * t));
      ring.setAttribute('opacity', String(0.85 * (1 - t)));
      if (t < 1) requestAnimationFrame(step); else ring.setAttribute('opacity', '0');
    };
    requestAnimationFrame(step);
  }

  /* ----------------------------------------------------------- elements */

  /** Notch renders its buttons as Views, so they are found by text. Deepest node wins. */
  const byText = (text, sel = 'div,span') =>
    [...document.querySelectorAll(sel)]
      .filter((e) => e.textContent.trim() === text && e.children.length === 0).pop() ?? null;

  const byTextRe = (re, sel = 'div,span') =>
    [...document.querySelectorAll(sel)]
      .filter((e) => re.test(e.textContent.trim()) && e.children.length === 0).pop() ?? null;

  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };

  /** The full press sequence: react-native-web listens for pointer events, not just click. */
  function fire(el, x, y) {
    const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true, button: 0 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true, button: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...base, button: 0 }));
  }

  async function click(el, { settle = 380 } = {}) {
    if (el === null) throw new Error('click: element not found');
    const c = centre(el);
    await glide(c.x, c.y);
    await sleep(110);
    ping();
    await sleep(90);
    fire(el, c.x, c.y);
    await sleep(settle);
  }

  const clickText = (t, o) => click(byText(t), o);

  /** One character at a time, with jitter — perfectly even typing reads as a robot. */
  async function typeInto(el, text, cps = 24) {
    const c = centre(el);
    await glide(c.x, c.y);
    ping();
    fire(el, c.x, c.y);
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    let acc = '';
    for (const ch of text) {
      acc += ch;
      setter.call(el, acc);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep((1000 / cps) * (0.7 + Math.random() * 0.6));
    }
    await sleep(160);
  }

  /** Poll for real app state. Throws a NAMED error so a failed take says which step hung. */
  async function until(label, pred, timeoutMs = 90000) {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      let ok = false;
      try { ok = await pred(); } catch { ok = false; }
      if (ok) return;
      await sleep(250);
    }
    throw new Error(`TIMEOUT waiting for: ${label}`);
  }

  const text = () => document.body.innerText;

  /* -------------------------------------------------------------- clock */

  const T0 = performance.now();
  const marks = [];
  let beatStart = 0;
  let beatId = null;

  function line(id) {
    beatId = id;
    beatStart = performance.now();
    const at = Math.round(beatStart - T0);
    marks.push({ id, atMs: at });
    log(`DEMO_LINE ${at} ${id}`);
  }

  async function hold() {
    const need = (CFG.durations[beatId] ?? 0) * 1000 + BREATH;
    const left = need - (performance.now() - beatStart);
    if (left > 0) await sleep(left);
  }

  /** A stretch the machine spends thinking. Marked, but given no narration. */
  function silent(id) {
    beatId = id;
    beatStart = performance.now();
    const at = Math.round(beatStart - T0);
    marks.push({ id, atMs: at, silent: true });
    log(`DEMO_LINE ${at} ${id}`);
  }

  /* --------------------------------------------------------------- take */

  async function run() {
    // 01 — the gate.
    line('01-intro');
    await glide(innerWidth * 0.5, innerHeight * 0.55, 1400);
    await hold();

    // 02 — the token.
    line('02-token');
    await typeInto(document.querySelector('input'), CFG.token, 30);
    await clickText('Connect', { settle: 200 });
    await until('the dashboard', () => /New project/.test(text()), 60000);
    await hold();

    // 03 — a real, empty project.
    line('03-create');
    await clickText('New project', { settle: 600 });
    await until('the create form', () => /CREATE AN EMPTY PROJECT/.test(text()));
    await typeInto([...document.querySelectorAll('input')]
      .find((i) => (i.placeholder || '').includes('project name')), CFG.project);
    await clickText('Create', { settle: 400 });
    await until('the new project', () => text().includes(CFG.project), 120000);
    await hold();

    // 04 — point at the repository.
    line('04-picker');
    await typeInto([...document.querySelectorAll('input')]
      .find((i) => (i.placeholder || '').includes('/path')), CFG.repo, 42);
    await hold();

    // 05 — scan, and the gaps land on the board.
    line('05-scan');
    await clickText('Scan repo', { settle: 200 });
    await until('the scan', () => /Drift \(\d+\)/.test(text()), 120000);
    await glide(innerWidth * 0.30, innerHeight * 0.45, 1200);
    await glide(innerWidth * 0.52, innerHeight * 0.60, 1500);
    await hold();

    // 06 — the evidence.
    line('06-evidence');
    await click(byTextRe(/^Drift \(\d+\)$/), { settle: 500 });
    const pane = document.scrollingElement ?? document.documentElement;
    pane.scrollTop = 0;
    await glide(innerWidth * 0.4, innerHeight * 0.6, 900);
    for (let i = 0; i < 4; i += 1) { pane.scrollTop += 170; await sleep(500); }
    await hold();

    // 07 — config drift: the quiet failure.
    line('07-config');
    pane.scrollTop = 0;
    await sleep(500);
    await glide(innerWidth * 0.4, innerHeight * 0.38, 1000);
    await hold();

    // 08 — the agents already on this machine.
    line('08-agent');
    await glide(innerWidth * 0.88, innerHeight * 0.12, 1100);
    await glide(innerWidth * 0.93, innerHeight * 0.12, 900);
    await glide(innerWidth * 0.86, innerHeight * 0.30, 1200);
    await hold();

    // 09 — ask one to draft the fix. Real agent, real repo.
    line('09-draft');
    await clickText('Draft a fix', { settle: 400 });
    await hold();

    // 10 — what it drafted, in the preview a human confirms.
    line('10-plan');
    await until('the drafted plan', () => /THIS WILL CREATE/.test(text()), 240000);
    const pre = [...document.querySelectorAll('div')]
      .find((e) => e.textContent.startsWith('services:') && e.children.length === 0);
    let sc = pre;
    while (sc && sc.scrollHeight <= sc.clientHeight + 4) sc = sc.parentElement;
    if (sc) { const to = sc.scrollHeight; for (let i = 1; i <= 20; i += 1) { sc.scrollTop = (to * i) / 20; await sleep(80); } }
    await glide(innerWidth * 0.4, innerHeight * 0.25, 1100);
    await hold();

    // 11 — write it.
    line('11-provision');
    await clickText('Confirm and create', { settle: 200 });
    await hold();

    // 12 — the result.
    silent('11-wait');
    await until('Zerops to accept the import', () => /Zerops accepted the import/.test(text()), 300000);
    await sleep(700);
    line('12-after');
    await hold();

    // 13 — the view Zerops does not have.
    line('13-envs');
    await clickText('Environments', { settle: 500 });
    await sleep(400);
    const other = byTextRe(/^vs /);
    if (other) await click(other, { settle: 600 });
    await until('the comparison', () => /DIFFERENCES/.test(text()), 120000);
    await hold();

    // 14 — how it compares, and what it refuses to compare.
    line('14-envs2');
    for (let i = 0; i < 4; i += 1) { pane.scrollTop += 190; await sleep(520); }
    await hold();

    // 17 — the persisted history. (15 and 16 are the terminal take.)
    line('17-timeline');
    pane.scrollTop = 0;
    await sleep(300);
    await click(byTextRe(/^Timeline \(\d+\)$/), { settle: 500 });
    await glide(innerWidth * 0.4, innerHeight * 0.45, 900);
    for (let i = 0; i < 3; i += 1) { pane.scrollTop += 150; await sleep(600); }
    await hold();

    // 18 — close on the board.
    line('18-close');
    pane.scrollTop = 0;
    await clickText('Architecture', { settle: 500 });
    await glide(innerWidth * 0.42, innerHeight * 0.5, 1600);
    await hold();

    log('DEMO_DONE ' + JSON.stringify({ ms: Math.round(performance.now() - T0), marks }));
    return { ms: Math.round(performance.now() - T0), marks };
  }

  window.__demo = { run, marks: () => marks };
  log('DEMO_READY');
})();
