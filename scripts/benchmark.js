#!/usr/bin/env node
// Benchmark: pixel-terminal spawn vs minimal CLI — apples-to-apples timing comparison.
// Usage: node scripts/benchmark.js [--rounds N]

import { spawn } from 'child_process';

const PROMPT = 'What is 2+2? Reply with just the number.';
const ROUNDS = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--rounds') || '5', 10);

const CONDITIONS = {
  'Minimal CLI': [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', 'sonnet', '--effort', 'low', '--no-session-persistence',
  ],
  'Pixel-terminal': [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--model', 'sonnet', '--effort', 'low', '--no-session-persistence',
  ],
};

function spawnRun(name, args) {
  return new Promise((resolve, reject) => {
    const isStreamJson = args.includes('stream-json') && args.includes('--input-format');
    const start = Date.now();
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let buf = '';
    let ttft = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let rateLimits = 0;

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'content_block_delta' && ttft === null) {
            ttft = Date.now() - start;
          }
          if (event.type === 'rate_limit_event') rateLimits++;
          if (event.type === 'result') {
            const u = event.usage || {};
            inputTokens = u.input_tokens || 0;
            outputTokens = u.output_tokens || 0;
          }
        } catch (_) {}
      }
    });

    child.stderr.on('data', () => {}); // suppress

    child.on('close', (code) => {
      const total = Date.now() - start;
      resolve({ name, ttft: ttft || total, total, inputTokens, outputTokens, rateLimits, code });
    });

    child.on('error', reject);

    // Send prompt
    if (isStreamJson) {
      child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } }) + '\n');
    } else {
      child.stdin.write(PROMPT);
      child.stdin.end();
    }
  });
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function p95(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(Math.ceil(s.length * 0.95) - 1, s.length - 1)];
}

async function main() {
  console.log(`\nBenchmark: pixel-terminal vs CLI baseline`);
  console.log(`Prompt: "${PROMPT}"`);
  console.log(`Model: sonnet | Effort: low | Rounds: ${ROUNDS} (first discarded as warm-up)\n`);

  const results = {};
  for (const name of Object.keys(CONDITIONS)) results[name] = [];

  const names = Object.keys(CONDITIONS);

  for (let round = 0; round < ROUNDS; round++) {
    const isWarmup = round === 0;
    const label = isWarmup ? 'warm-up' : `round ${round}`;
    process.stdout.write(`  ${label}: `);

    // Interleaved: run each condition once per round
    for (const name of names) {
      process.stdout.write(`${name}... `);
      const result = await spawnRun(name, CONDITIONS[name]);
      if (!isWarmup) results[name].push(result);
    }
    console.log('done');
  }

  // Print results
  console.log(`\nBENCHMARK RESULTS — pixel-terminal vs CLI baseline`);
  console.log(`${'═'.repeat(60)}`);

  const header = ['', ...names, 'Delta'];
  const rows = [];

  const a = results[names[0]];
  const b = results[names[1]];

  const metrics = [
    { label: 'TTFT (median)', fn: r => median(r.map(x => x.ttft)), unit: 'ms' },
    { label: 'TTFT (p95)', fn: r => p95(r.map(x => x.ttft)), unit: 'ms' },
    { label: 'Total (median)', fn: r => median(r.map(x => x.total)), unit: 'ms' },
    { label: 'Total (p95)', fn: r => p95(r.map(x => x.total)), unit: 'ms' },
    { label: 'Input tokens', fn: r => median(r.map(x => x.inputTokens)), unit: '' },
    { label: 'Output tokens', fn: r => median(r.map(x => x.outputTokens)), unit: '' },
    { label: 'Rate limits', fn: r => r.reduce((s, x) => s + x.rateLimits, 0), unit: '' },
  ];

  for (const m of metrics) {
    const va = Math.round(m.fn(a));
    const vb = Math.round(m.fn(b));
    const delta = vb - va;
    const pct = va > 0 ? ((delta / va) * 100).toFixed(1) : '—';
    const deltaStr = m.unit === 'ms'
      ? `${delta >= 0 ? '+' : ''}${delta}ms (${pct}%)`
      : `${delta >= 0 ? '+' : ''}${delta}`;
    rows.push([m.label, `${va}${m.unit}`, `${vb}${m.unit}`, deltaStr]);
  }

  // Print table
  const colWidths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  const sep = colWidths.map(w => '─'.repeat(w + 2)).join('┼');

  console.log(header.map((h, i) => h.padEnd(colWidths[i])).join(' │ '));
  console.log(sep);
  for (const row of rows) {
    console.log(row.map((c, i) => c.padEnd(colWidths[i])).join(' │ '));
  }

  // Auto-conclusion
  const ttftDelta = Math.round(median(b.map(x => x.ttft)) - median(a.map(x => x.ttft)));
  const totalDelta = Math.round(median(b.map(x => x.total)) - median(a.map(x => x.total)));
  const ttftPct = Math.abs((ttftDelta / median(a.map(x => x.ttft))) * 100).toFixed(1);

  console.log(`\nConclusion:`);
  if (Math.abs(ttftDelta) < 200 && Math.abs(totalDelta) < 500) {
    console.log(`  No meaningful performance gap. Delta is ${ttftDelta}ms TTFT (${ttftPct}%) — within API variance.`);
    console.log(`  Any perceived slowness is UX (rate limit visibility), not architecture.`);
  } else if (ttftDelta > 200) {
    console.log(`  Pixel-terminal is ${ttftDelta}ms slower to first token. Investigate flag overhead.`);
  } else {
    console.log(`  Pixel-terminal is ${Math.abs(ttftDelta)}ms FASTER to first token. Unexpected — verify with more rounds.`);
  }

  // Raw data dump
  console.log(`\nRaw data:`);
  for (const name of names) {
    console.log(`  ${name}:`);
    for (const r of results[name]) {
      console.log(`    TTFT=${r.ttft}ms total=${r.total}ms in=${r.inputTokens} out=${r.outputTokens} rl=${r.rateLimits}`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
