#!/usr/bin/env node
// answer.mjs — turn harvested questions into an answer map using an OpenAI-compatible LLM API.
// This is the only part of the skill that needs a key: the browser half (exam.mjs) never calls out.
//
//   node answer.mjs --set-key sk-xxxx                 store key + endpoint + model in ../config.json
//   node answer.mjs --check                           show resolved config (key masked) without calling
//   node answer.mjs --questions q.json --out a.json    answer every question
//   node answer.mjs --questions q.json --dry-run       print the exact prompt, make no request
//
// Key resolution: --api-key > $EXAM_API_KEY > $DEEPSEEK_API_KEY > $OPENAI_API_KEY > ../config.json
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const flag = (f, d) => {
  const i = argv.indexOf('--' + f);
  return i >= 0 ? argv[i + 1] : d;
};

// Written next to the work, not inside the skill directory: a sandboxed agent may be
// allowed to write its workspace but not the skill root (that write fails with EPERM).
const CONFIG = process.env.EXAM_CONFIG || flag('config') || path.join(process.cwd(), 'exam-config.json');

const DEFAULT_BASE = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-chat';

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

function resolveConfig() {
  const file = readConfig();
  const apiKey = flag('api-key') || process.env.EXAM_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || file.apiKey || '';
  return {
    apiKey,
    baseUrl: (flag('base-url') || process.env.EXAM_BASE_URL || file.baseUrl || DEFAULT_BASE).replace(/\/+$/, ''),
    model: flag('model') || process.env.EXAM_MODEL || file.model || DEFAULT_MODEL,
    batch: Number(flag('batch') || file.batch || 8),
    temperature: Number(flag('temperature') || file.temperature || 0),
  };
}

const mask = (k) => (k ? k.slice(0, 4) + '****' + k.slice(-4) : '(none)');

// ---------------------------------------------------------------- prompt
const SYSTEM = [
  'You are an exam answering engine.',
  'Answer in the language of the questions. Use domain knowledge, not the option order.',
  'For 单选题/判断题 return exactly one index. For 多选题 return every correct index.',
  'Output STRICT JSON only: {"<question number>": [<option indexes>], ...}',
  'No prose, no markdown fence, no comments. Indexes are 0-based positions in the option list.',
].join(' ');

function buildUser(questions) {
  return questions.map((q) => {
    const opts = q.opts.map((o) => `${o.i}=${o.text}`).join('\n');
    return `#${q.n} [${q.type}] ${q.stem}\n${opts}`;
  }).join('\n\n') + '\n\nReturn JSON for exactly these ' + questions.length + ' question numbers.';
}

// ---------------------------------------------------------------- transport
async function chat(cfg, messages) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, temperature: cfg.temperature, messages, stream: false }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('empty completion: ' + text.slice(0, 200));
  return content;
}

function parseMap(raw, questions) {
  // Models like to wrap JSON in ```json fences even when told not to.
  const cleaned = raw.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1').replace(/```[a-z]*/gi, '');
  let obj;
  try { obj = JSON.parse(cleaned); } catch { throw new Error('model did not return JSON: ' + raw.slice(0, 200)); }
  const out = {};
  for (const q of questions) {
    const v = obj[String(q.n)] ?? obj[q.n];
    if (v === undefined) continue;
    const arr = (Array.isArray(v) ? v : [v]).map(Number).filter((i) => Number.isInteger(i));
    const max = q.opts.length - 1;
    let idx = [...new Set(arr)].filter((i) => i >= 0 && i <= max).sort((a, b) => a - b);
    const multi = /多选/.test(q.type);
    if (!multi && idx.length > 1) idx = [idx[0]];
    if (idx.length) out[q.n] = idx;
  }
  return out;
}

// ---------------------------------------------------------------- main
async function main() {
  if (has('set-key')) {
    const key = flag('set-key');
    if (!key || key.startsWith('--')) throw new Error('usage: --set-key <apiKey>');
    const cfg = { ...readConfig(), apiKey: key, baseUrl: flag('base-url', DEFAULT_BASE).replace(/\/+$/, ''), model: flag('model', DEFAULT_MODEL) };
    writeConfig(cfg);
    console.log(`saved to ${CONFIG}\n  baseUrl: ${cfg.baseUrl}\n  model:   ${cfg.model}\n  apiKey:  ${mask(key)}`);
    return;
  }

  const cfg = resolveConfig();

  if (has('check') || (!flag('questions'))) {
    console.log(JSON.stringify({
      config: CONFIG,
      apiKey: mask(cfg.apiKey),
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      batch: cfg.batch,
      ready: !!cfg.apiKey,
      hint: cfg.apiKey ? 'ready' : 'run: node answer.mjs --set-key <your key>',
    }, null, 2));
    if (!flag('questions')) return;
  }

  const qFile = flag('questions', 'questions.json');
  const parsed = JSON.parse(fs.readFileSync(qFile, 'utf8').replace(/^\uFEFF/, ''));
  const questions = Array.isArray(parsed) ? parsed : parsed.questions;
  if (!questions || !questions.length) throw new Error('no questions in ' + qFile);
  const outFile = flag('out', 'answers.json');

  if (has('dry-run')) {
    console.log(SYSTEM + '\n\n--- user ---\n' + buildUser(questions.slice(0, 3)) + '\n\n[truncated to 3 of ' + questions.length + ']');
    return;
  }

  if (!cfg.apiKey) throw new Error(`no API key. Set one first:\n  node answer.mjs --set-key <your key>\nor export EXAM_API_KEY=...`);

  const answers = {};
  // Batches are independent HTTP calls: running a few at once is the difference between
  // 85 questions taking one minute and taking four.
  const CONC = Math.max(1, Number(flag('concurrency', process.env.EXAM_CONCURRENCY || 4)));
  const askBatch = async (batch) => {
    try {
      const raw = await chat(cfg, [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUser(batch) },
      ]);
      Object.assign(answers, parseMap(raw, batch));
    } catch (e) {
      process.stderr.write(`\nbatch ${batch[0] && batch[0].n}-${batch[batch.length - 1] && batch[batch.length - 1].n} failed: ${e.message}\n`);
    }
    process.stderr.write(`\ranswered ${Object.keys(answers).length}/${questions.length}  `);
  };

  let pending = [...questions];
  for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
    const batchSize = attempt === 0 ? cfg.batch : 3;
    const batches = [];
    for (let i = 0; i < pending.length; i += batchSize) batches.push(pending.slice(i, i + batchSize));
    let cursor = 0;
    const worker = async () => {
      while (cursor < batches.length) await askBatch(batches[cursor++]);
    };
    await Promise.all(Array.from({ length: Math.min(CONC, batches.length) }, worker));
    pending = questions.filter((q) => !answers[q.n]);
    if (pending.length && attempt < 2) process.stderr.write(`\nretrying ${pending.length} missing as smaller batches\n`);
  }

  const missing = questions.filter((q) => !answers[q.n]).map((q) => q.n);
  fs.writeFileSync(outFile, JSON.stringify(answers, null, 2));
  console.log('\n' + JSON.stringify({ answered: Object.keys(answers).length, total: questions.length, missing, out: outFile }, null, 2));
  if (missing.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exitCode = 1;
});
