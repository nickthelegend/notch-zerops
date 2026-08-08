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
    /*
     * The setter has to come from the element's OWN prototype.
     *
     * React tracks the last value it wrote and ignores an input event whose value it thinks it
     * already knows, so the native setter has to be called directly rather than assigning
     * `el.value`. Using HTMLInputElement's setter on a <textarea> throws "Illegal invocation" —
     * which is exactly how the Design tab killed a take.
     */
    const proto = el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
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

  /* ------------------------------------------------------- extra helpers */

  /** The scrolling pane of whichever tab is open. RNW ScrollViews are just overflow divs. */
  const pane = () =>
    [...document.querySelectorAll('div')]
      .filter((e) => e.scrollHeight > e.clientHeight + 40 && e.clientHeight > 260)
      .sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? document.scrollingElement;

  async function scroll(px, steps = 4) {
    const p = pane();
    for (let i = 0; i < steps; i += 1) { p.scrollTop += px / steps; await sleep(420); }
  }

  const sel = (q) => document.querySelector(q);

  /** Tabs carry counts, so they are matched loosely. */
  const tab = (name) =>
    byTextRe(new RegExp('^' + name + '( \\(\\d+\\))?$')) ?? byText(name);

  const openTab = async (name) => { await click(tab(name), { settle: 700 }); };

  /** react-native-web renders Switch as a checkbox; a real click on it flips the state. */
  async function toggle(nth = 0) {
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
    const el = boxes[nth];
    if (el === undefined) throw new Error('toggle: no switch found');
    const c = centre(el);
    await glide(c.x, c.y);
    ping();
    el.click();
    await sleep(400);
  }

  /** Drag a node on the React Flow canvas, with the drawn cursor following. */
  async function dragNode(matchText, dx, dy) {
    const n = [...document.querySelectorAll('.react-flow__node')]
      .find((e) => e.textContent.includes(matchText));
    if (n === undefined) throw new Error('dragNode: no node containing ' + matchText);
    const r = n.getBoundingClientRect();
    const x0 = Math.round(r.x + r.width / 2);
    const y0 = Math.round(r.y + 24);           // grab the card's head, not a handle
    await glide(x0, y0);
    const base = { bubbles: true, cancelable: true, view: window, pointerId: 1, isPrimary: true, button: 0 };
    n.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x0, clientY: y0 }));
    n.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x0, clientY: y0, button: 0, view: window }));
    const steps = 22;
    for (let i = 1; i <= steps; i += 1) {
      const x = x0 + (dx * i) / steps;
      const y = y0 + (dy * i) / steps;
      P.x = x; P.y = y; draw();
      document.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, clientY: y }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y, view: window }));
      await sleep(18);
    }
    document.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x0 + dx, clientY: y0 + dy }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x0 + dx, clientY: y0 + dy, view: window }));
    await sleep(450);
  }

  /** Pan the canvas by dragging empty pane in hand mode. */
  async function panCanvas(dx, dy) {
    const p = document.querySelector('.react-flow__pane');
    if (p === null) return;
    const x0 = Math.round(innerWidth * 0.30);
    const y0 = Math.round(innerHeight * 0.80);
    await glide(x0, y0);
    const base = { bubbles: true, cancelable: true, view: window, pointerId: 1, isPrimary: true, button: 0 };
    p.dispatchEvent(new PointerEvent('pointerdown', { ...base, clientX: x0, clientY: y0 }));
    p.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x0, clientY: y0, button: 0, view: window }));
    for (let i = 1; i <= 18; i += 1) {
      const x = x0 + (dx * i) / 18, y = y0 + (dy * i) / 18;
      P.x = x; P.y = y; draw();
      document.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: x, clientY: y }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y, view: window }));
      await sleep(20);
    }
    document.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: x0 + dx, clientY: y0 + dy }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x0 + dx, clientY: y0 + dy, view: window }));
    await sleep(400);
  }

  /* --------------------------------------------------------------- take */

  async function run() {
    /* ---- 04 · the gate -------------------------------------------- */
    line('04-token');
    await sleep(700);
    await typeInto(sel("input[placeholder='paste it here']"), CFG.token, 34);
    await clickText('Connect');
    await until('the dashboard', () => /New project/.test(text()), 90000);
    await hold();

    /* ---- 05 · the board ------------------------------------------- */
    line('05-board');
    await click(byTextRe(/^test · \w+$/), { settle: 900 });
    await until('the canvas', () => document.querySelectorAll('.react-flow__node').length > 0, 60000);
    await dragNode('ubuntu', 150, -90);
    await click(sel('[title="Pan"]'), { settle: 260 });
    await panCanvas(150, -60);
    await click(sel('[title="Zoom in"]'), { settle: 400 });
    await click(sel('[title="Fit to view"]'), { settle: 700 });
    await click(sel('[title="Select"]'), { settle: 260 });
    await hold();

    /* ---- 07 · add a service by hand -------------------------------- */
    line('07-add');
    await click(sel('[title="Add a service"]'), { settle: 500 });
    await until('the palette', () => sel("input[placeholder='Search services…']") !== null);
    await typeInto(sel("input[placeholder='Search services…']"), 'post', 12);
    await sleep(700);
    await click(byText('PostgreSQL'), { settle: 900 });
    await until('the ghost', () => /added by you/.test(text()), 20000);
    await glide(innerWidth * 0.55, innerHeight * 0.62, 900);
    await hold();

    /* ---- 08 · point it at a repository ----------------------------- */
    line('08-scan');
    await typeInto(sel("input[placeholder='/path/to/your/repo']"), CFG.repo, 40);
    await clickText('Scan repo');
    await until('the scan', () => /Drift \(\d+\)/.test(text()), 180000);
    await sleep(900);
    await click(sel('[title="Fit to view"]'), { settle: 900 });
    await hold();

    /* ---- 06 · blast radius ----------------------------------------- */
    line('06-blast');
    const rt = [...document.querySelectorAll('.react-flow__node')]
      .find((e) => /ubuntu|nodejs/.test(e.textContent));
    if (rt) await click(rt, { settle: 1100 });
    await glide(innerWidth * 0.5, innerHeight * 0.55, 1200);
    await hold();
    const paneEl = document.querySelector('.react-flow__pane');
    if (paneEl) await click(paneEl, { settle: 500 });

    /* ---- 09 · evidence ---------------------------------------------- */
    line('09-evidence');
    await openTab('Drift');
    await scroll(520, 5);
    await hold();

    /* ---- 10 · config drift ------------------------------------------ */
    line('10-config');
    await scroll(620, 5);
    await hold();
    pane().scrollTop = 0;

    /* ---- 11 · committed secrets -------------------------------------- */
    line('11-secrets');
    await typeInto(sel("input[placeholder='/path/to/your/repo']"), CFG.leaky, 46);
    await clickText('Scan repo');
    await until('the sweep', () => /Secrets \((?!0\))\d+\)/.test(text()), 180000);
    await openTab('Secrets');
    await sleep(600);
    await scroll(420, 4);
    await hold();
    pane().scrollTop = 0;

    /* ---- 12 · the architect ------------------------------------------ */
    line('12-design');
    await click(byTextRe(/^acme-notes-live · \w+$/), { settle: 1200 });
    await openTab('Design');
    await typeInto(document.querySelector('textarea'),
      "I'm building a chat app with search and analytics", 22);
    await hold();
    await clickText('Design it', { settle: 400 });

    silent('S1-thinking');
    await until('the agent to answer', () => /CONSIDERED AND TURNED DOWN|CHOSE/.test(text()), 300000);
    await sleep(600);

    /* ---- 13 · the rejections ------------------------------------------ */
    line('13-rejected');
    await scroll(700, 6);
    await hold();
    await scroll(620, 5);
    pane().scrollTop = 0;

    /* ---- 14 · autopilot, disarmed ------------------------------------- */
    line('14-auto-intro');
    await openTab('Autopilot');
    await sleep(500);
    await glide(innerWidth * 0.22, innerHeight * 0.40, 900);
    await hold();

    /* ---- 15 · the measurement ----------------------------------------- */
    line('15-auto-run');
    await clickText('Run a cycle', { settle: 400 });
    await hold();
    silent('S2-watching');
    await until('the panel to report', () => /WHAT THE PANEL SAID/.test(text()), 420000);
    await sleep(800);

    /* ---- 16 · the argument --------------------------------------------- */
    line('16-auto-panel');
    await scroll(560, 5);
    await hold();

    /* ---- 17 · armed ----------------------------------------------------- */
    line('17-auto-apply');
    pane().scrollTop = 0;
    await sleep(400);
    await toggle(0);                       // arm it
    await sleep(700);
    await clickText('Run a cycle and apply', { settle: 400 });
    await hold();
    silent('S3-applying');
    await until('the second decision', () => /WHAT WAS DECIDED/.test(text()), 480000);
    await sleep(900);
    await scroll(900, 7);
    await sleep(1400);

    /* ---- 18 · the receipts ------------------------------------------------ */
    line('18-actions');
    pane().scrollTop = 0;
    await openTab('Actions');
    await sleep(900);
    await scroll(520, 5);
    await hold();

    /* ---- 19 · environments ------------------------------------------------- */
    line('19-envs');
    pane().scrollTop = 0;
    await openTab('Environments');
    await sleep(500);
    const other = byTextRe(/^vs \S+/);
    if (other) await click(other, { settle: 900 });
    await until('the comparison', () => /DIFFERENCES/.test(text()), 120000).catch(() => {});
    await scroll(380, 4);
    await hold();

    /* ---- 20 · what it will not claim ---------------------------------------- */
    line('20-honest');
    pane().scrollTop = 0;
    await openTab('Actions');
    await sleep(500);
    await toggle(0);                        // "only what changed something"
    await sleep(900);
    await glide(innerWidth * 0.45, innerHeight * 0.42, 1100);
    await hold();

    log('DEMO_DONE ' + JSON.stringify({ ms: Math.round(performance.now() - T0), marks }));
    return { ms: Math.round(performance.now() - T0), marks };
  }

  window.__demo = { run, marks: () => marks };
  log("DEMO_READY");
})();
