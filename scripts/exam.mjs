#!/usr/bin/env node
// exam.mjs — drive an online exam page through CDP: harvest questions, apply answers, verify, submit.
// Zero deps (Node 22: WebSocket + node:http). All page work happens via Runtime.evaluate.
//
//   node exam.mjs status                        what page are we attached to
//   node exam.mjs probe                         does this page match a known profile
//   node exam.mjs harvest --out questions.json  read every question (jump + poll each one)
//   node exam.mjs apply --map answers.json      click options per {n: [index...]}
//   node exam.mjs verify --map answers.json     re-check what is actually selected
//   node exam.mjs submit                        click the submit button and confirm
//
// Options: --port <n> (default $CDP_PORT or 9223), --profile <name>, --from <n>, --to <n>
import fs from 'node:fs';
import http from 'node:http';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
};
const PORT = Number(flag('port', process.env.CDP_PORT || 9223));
const BASE = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- site profiles
// A profile maps a page's DOM onto a stable contract. Add another object to
// support another exam site; nothing else in this file changes.
const PROFILES = {
  wenjuan: {
    match: /wenjuan\.com/,
    numberLinks: 'a[pageid^="page_"]',
    numAttr: 'pageid',
    numPrefix: 'page_',
    questionNum: '.question_num',
    stemRoot: '.wjques',
    inputs: 'input[type=radio],input[type=checkbox]',
    optionLabel: 'label.option_label',
    submitText: ['我要交卷', '重新交卷'],
    confirmText: ['确认交卷', '确定', '确认'],
  },
  generic: {
    match: /.*/,
    numberLinks: '[data-question-no],[data-page]',
    numAttr: 'data-question-no',
    numPrefix: '',
    questionNum: '.question_num,.q-num',
    stemRoot: '.wjques,.question,.q-body',
    inputs: 'input[type=radio],input[type=checkbox]',
    optionLabel: 'label',
    submitText: ['我要交卷', '提交', '交卷'],
    confirmText: ['确认', '确定'],
  },
};

function profileFor(url, name) {
  if (name && PROFILES[name]) return { name, ...PROFILES[name] };
  for (const [key, p] of Object.entries(PROFILES)) {
    if (key !== 'generic' && p.match.test(url)) return { name: key, ...p };
  }
  return { name: 'generic', ...PROFILES.generic };
}

// ---------------------------------------------------------------- cdp plumbing
class Session {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      const slot = msg.id && this.pending.get(msg.id);
      if (!slot) {
        // Events carry no id. A modal confirm() freezes the renderer until answered,
        // so the dialog hook must exist before any click that can raise one.
        if (msg.method && this.onEvent) this.onEvent(msg);
        return;
      }
      this.pending.delete(msg.id);
      msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      // Exam pages render slowly; a short timeout silently truncates long batches.
      // unref so a pending watchdog never keeps the CLI alive after the work is done.
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout ${method}`));
      }, 180000);
      if (t.unref) t.unref();
    });
  }
}

// node:http rather than fetch: an HTTP_PROXY in the environment otherwise swallows
// requests to 127.0.0.1 and surfaces as a bare "fetch failed".
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('cdp http timeout')));
    req.on('error', (e) => reject(new Error(`${e.message} (is a browser listening on ${PORT}?)`)));
  });
}

async function connect() {
  const pages = JSON.parse(await httpGet(`${BASE}/json/list`)).filter((t) => t.type === 'page');
  if (!pages.length) throw new Error('no page target — open the exam in a browser started with --remote-debugging-port');
  const page = pages.find((p) => /wenjuan\.com|exam|test|quiz/i.test(p.url))
    || pages.find((p) => /^https?:|^file:/.test(p.url))
    || pages[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('cannot attach to ' + page.url)), { once: true });
  });
  const session = new Session(ws);
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  // Auto-accept every JS dialog: the confirm() on 交卷 would otherwise hang the page.
  session.onEvent = (m) => {
    if (m.method === 'Page.javascriptDialogOpening') {
      session.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  };
  return { session, page, ws };
}

async function evaluate(session, expression) {
  const r = await session.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

// ---------------------------------------------------------------- in-page snippets
// Wait for the number badge to actually show question n before reading anything:
// reading too early silently returns the PREVIOUS question's DOM.
const H = `
const sleep = ms => new Promise(r => setTimeout(r, ms));
const numOf = () => { const el = document.querySelector(P.questionNum); if (!el) return null; const m = (el.innerText || '').match(/^[^0-9]*([0-9]+)/); return m ? m[1] : null; };
const inputs = () => Array.from(document.querySelectorAll(P.inputs));
const jump = async (n) => {
  const a = document.querySelector('[' + P.numAttr + '="' + P.numPrefix + n + '"]') || document.querySelectorAll(P.numberLinks)[n - 1];
  if (!a) return false;
  a.click();
  for (let i = 0; i < 40; i++) { await sleep(60); if (numOf() === String(n)) return true; }
  return false;
};
`;

const ENUMERATE = `
const links = Array.from(document.querySelectorAll(P.numberLinks));
const nums = links.map(function (a) {
  const v = a.getAttribute(P.numAttr) || a.innerText;
  const m = String(v).match(/([0-9]+)/);
  return m ? Number(m[1]) : null;
}).filter(Boolean);
return { count: links.length, nums: nums, href: location.href, title: document.title };
`;

const HARVEST_ONE = `async (n) => {
${H}
  if (!(await jump(n))) return { n: n, error: 'jump-failed' };
  const root = document.querySelector(P.stemRoot);
  if (!root) return { n: n, error: 'no-question' };
  const numEl = document.querySelector(P.questionNum);
  const numText = ((numEl && numEl.innerText) || '').trim();
  const m = numText.match(/^[^0-9]*([0-9]+)\\s*(.*)$/);
  const type = m ? (m[2] || '').trim() : '';
  const clone = root.cloneNode(true);
  clone.querySelectorAll('label').forEach(function (e) { e.remove(); });
  clone.querySelectorAll('script,style').forEach(function (e) { e.remove(); });
  const stem = (clone.innerText || '').replace(/\\s+/g, ' ').trim();
  // Option text comes from the labels in DOM order and pairs with inputs by index:
  // wenjuan multi-select labels carry no htmlFor and their inputs all share one id.
  const labels = Array.from(root.querySelectorAll(P.optionLabel));
  const all = inputs();
  const opts = labels.map(function (l, i) {
    const t = (l.innerText || '').replace(/\\s+/g, ' ').trim();
    const inp = l.querySelector('input') || (l.htmlFor ? document.getElementById(l.htmlFor) : null) || all[i];
    return { i: i, text: t, kind: inp ? inp.type : '?' };
  });
  return { n: n, type: type, stem: stem, opts: opts };
}`;

const APPLY_BATCH = `async (args) => {
${H}
  const map = args.map, from = args.from, to = args.to;
  const bad = [];
  for (let n = from; n <= to; n++) {
    const want = map[String(n)];
    if (!want) { bad.push(n + ':no-answer'); continue; }
    if (!(await jump(n))) { bad.push(n + ':jump-failed'); continue; }
    const xs = inputs();
    for (let i = 0; i < xs.length; i++) {
      const should = want.indexOf(i) >= 0;
      if (xs[i].checked !== should) { xs[i].click(); await sleep(45); }
    }
    const got = xs.map(function (x, i) { return x.checked ? i : -1; }).filter(function (i) { return i >= 0; }).sort(function (a, b) { return a - b; });
    const exp = want.slice().sort(function (a, b) { return a - b; });
    if (got.join(',') !== exp.join(',')) bad.push(n + ':' + exp + '>' + got);
  }
  return { from: from, to: to, bad: bad };
}`;

const VERIFY_ONE = `async (n) => {
${H}
  if (!(await jump(n))) return { n: n, error: 'jump-failed' };
  return { n: n, checked: inputs().map(function (x, i) { return x.checked ? i : -1; }).filter(function (i) { return i >= 0; }) };
}`;

const SUBMIT = `async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const byText = (t) => Array.from(document.querySelectorAll('div,button,a,span'))
    .filter(e => (e.innerText || '').trim() === t && e.offsetParent !== null)
    .sort((a, b) => a.innerText.length - b.innerText.length)[0];
  const btn = P.submitText.map(byText).find(Boolean);
  if (!btn) return { ok: false, reason: 'submit-button-not-found', text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 200) };
  btn.click();
  await sleep(2500);
  const confirm = P.confirmText.map(byText).find(Boolean);
  if (confirm) { await sleep(300); confirm.click(); await sleep(3500); }
  const text = document.body.innerText.replace(/\\s+/g, ' ');
  // '正在保存' / '重新交卷' both mean the server has not accepted the paper yet.
  return { ok: !/正在保存|重新交卷/.test(text), confirmed: !!confirm, text: text.slice(0, 300) };
}`;

// ---------------------------------------------------------------- command harness
// One evaluate per question: a single giant batch would trip the CDP timeout,
// and each jump needs its own render wait anyway.
function buildExpression(snippet, profileJson, args) {
  const head = `return (${snippet})(${JSON.stringify(args)});`;
  const body = snippet.indexOf('=>') >= 0 ? head : snippet;
  return `(async () => { const P = ${profileJson}; ${body} })()`;
}

async function withPage(fn) {
  const { session, page, ws } = await connect();
  try {
    const prof = profileFor(page.url, flag('profile'));
    const P = JSON.stringify({
      numAttr: prof.numAttr, numPrefix: prof.numPrefix, numberLinks: prof.numberLinks,
      questionNum: prof.questionNum, stemRoot: prof.stemRoot, inputs: prof.inputs,
      optionLabel: prof.optionLabel, submitText: prof.submitText, confirmText: prof.confirmText,
    });
    const run = async (snippet, args = null) => {
      const expr = buildExpression(snippet, P, args);
      if (process.env.EXAM_DEBUG) process.stderr.write(expr.slice(0, 400) + '\n');
      return evaluate(session, expr);
    };
    return await fn({ session, page, prof, run });
  } finally {
    ws.close();
  }
}

function readJson(file) {
  // PowerShell's Set-Content -Encoding UTF8 writes a BOM; JSON.parse chokes on it.
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

// Answer maps come in two shapes:
//   JSON  {"12": [0, 2]}
//   lines "12: 0,2"  (what a chat agent writes after reading q.txt; '=' and '|' also work)
// Both are normalized to { "<n>": [sorted 0-based indexes] }.
function readMap(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let map = null;
  try { map = JSON.parse(raw); } catch { /* fall through to the line form */ }
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    map = {};
    for (const line of raw.split(/\r?\n/)) {
      if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
      const m = line.match(/^\s*(\d+)\s*[:=|]\s*(.*)$/);
      if (!m) continue;
      map[m[1]] = (m[2].match(/\d+/g) || []).map(Number);
    }
    if (!Object.keys(map).length) throw new Error(`cannot parse answer map: ${file}`);
  }
  const out = {};
  for (const k of Object.keys(map)) {
    const v = map[k];
    out[String(k).trim()] = (Array.isArray(v) ? v : [v])
      .map(Number)
      .filter((x) => !isNaN(x))
      .sort((a, b) => a - b);
  }
  return out;
}

function range(en, map) {
  const known = en.nums.concat(map ? Object.keys(map).map(Number) : []);
  const lo = flag('from') ? Number(flag('from')) : Math.min.apply(null, known);
  const hi = flag('to') ? Number(flag('to')) : Math.max.apply(null, known);
  return [lo, hi];
}

async function main() {
  switch (cmd) {
    case 'status':
      return withPage(async ({ run, prof }) => {
        const info = await run(`const o = { url: location.href, title: document.title, text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400) }; return o;`);
        console.log(JSON.stringify({ profile: prof.name, ...info }, null, 2));
      });

    case 'probe':
      return withPage(async ({ run, prof }) => {
        const out = await run(`return { href: location.href, numberLinks: document.querySelectorAll(P.numberLinks).length, inputs: document.querySelectorAll(P.inputs).length, labels: document.querySelectorAll(P.optionLabel).length };`);
        console.log(JSON.stringify({ profile: prof.name, ...out }, null, 2));
      });

    case 'harvest':
      return withPage(async ({ run }) => {
        const en = await run(ENUMERATE);
        const [lo, hi] = range(en);
        const out = [];
        for (let n = lo; n <= hi; n++) {
          const q = await run(HARVEST_ONE, n);
          if (q && !q.error) out.push(q);
          else process.stderr.write(`! ${n} ${q && q.error}\n`);
          process.stderr.write(`\r${out.length}/${hi - lo + 1}  `);
        }
        const file = flag('out', 'questions.json');
        fs.writeFileSync(file, JSON.stringify({ meta: { ...en, harvestedAt: new Date().toISOString() }, questions: out }, null, 2));
        // Compact form: one line per question plus a line of options — cheap to read back.
        const compact = out.map((q) => `${q.n}|${q.type}|${q.stem}\n` + q.opts.map((o) => `${o.i}=${o.text}`).join('  ')).join('\n');
        fs.writeFileSync(file.replace(/\.json$/, '') + '.txt', compact);
        console.error(`\nwrote ${file} (${out.length} questions)`);
        console.log(JSON.stringify({ questions: out.length, file }));
      });

    case 'apply': {
      const mapFile = flag('map', 'answers.json');
      const map = readMap(mapFile);
      return withPage(async ({ run }) => {
        const en = await run(ENUMERATE);
        const [lo, hi] = range(en, map);
        const bad = [];
        for (let start = lo; start <= hi; start += 10) {
          const end = Math.min(start + 9, hi);
          const r = await run(APPLY_BATCH, { map, from: start, to: end });
          bad.push.apply(bad, r.bad);
          process.stderr.write(`\r${end}/${hi}  ${bad.length} bad  `);
        }
        console.error('');
        console.log(JSON.stringify({ applied: hi - lo + 1 - bad.length, bad }, null, 2));
      });
    }

    case 'verify': {
      const map = readMap(flag('map', 'answers.json'));
      return withPage(async ({ run }) => {
        const en = await run(ENUMERATE);
        const [lo, hi] = range(en, map);
        const wrong = [];
        for (let n = lo; n <= hi; n++) {
          const r = await run(VERIFY_ONE, n);
          const want = (map[String(n)] || []).slice().sort((a, b) => a - b).join(',');
          const got = (r.checked || []).join(',');
          if (want !== got) wrong.push({ n, want, got });
        }
        console.log(JSON.stringify({ checked: hi - lo + 1, wrong }, null, 2));
      });
    }

    case 'submit':
      return withPage(async ({ run }) => {
        console.log(JSON.stringify(await run(SUBMIT), null, 2));
      });

    // Blank answer sheet for the "answer it yourself in the chat" path: no key, no network.
    case 'template': {
      const src = readJson(flag('questions', 'questions.json'));
      const list = Array.isArray(src) ? src : src.questions || [];
      const file = flag('out', 'answers.txt');
      const body = '# 题号: 选项下标（0 基；多选用逗号，如 12: 0,2）\n' +
        list.map((q) => `${q.n}: `).join('\n') + '\n';
      fs.writeFileSync(file, body);
      console.error(`wrote ${file} (${list.length} questions)`);
      console.log(JSON.stringify({ questions: list.length, file }));
      return;
    }

    // Parse a hand-written answer sheet without touching the browser.
    case 'checkmap': {
      const map = readMap(flag('map', 'answers.txt'));
      const n = Object.keys(map).length;
      const empty = Object.keys(map).filter((k) => !map[k].length);
      console.log(JSON.stringify({ questions: n, empty, map }, null, 2));
      if (empty.length) process.exitCode = 1;
      return;
    }

    default:
      console.error('usage: exam.mjs status|probe|harvest --out q.json|template --questions q.json --out answers.txt|checkmap --map answers.txt|apply --map answers.json|verify --map answers.json|submit [--port 9223] [--profile wenjuan]');
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exitCode = 1;
});

