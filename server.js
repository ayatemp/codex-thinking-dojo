import { createServer } from 'node:http';
import { readFile, stat, unlink } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const root = resolve(process.cwd());
const publicDir = join(root, 'public');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const codexBin = process.env.CODEX_BIN || 'codex';
const codexModel = process.env.CODEX_MODEL || '';
const codexTimeoutMs = Number(process.env.CODEX_TIMEOUT_MS || 180000);
let codexExecHelpPromise;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const modes = {
  socratic: {
    title: '対話',
    instruction: [
      'あなたは「Codex思考道場」のソクラテス式コーチです。',
      '答えを直接与えすぎず、ユーザーの思考が深まる問いを返してください。',
      '1回の返答では問いを1〜2個に絞り、短く鋭く返してください。',
    ].join('\n'),
  },
  counter: {
    title: '反論トレーニング',
    instruction: [
      'あなたは「Codex思考道場」の議論コーチです。',
      'ユーザーの主張に対して、建設的かつ批判的に反論してください。',
      '根拠の弱さ、別視点、前提のずれを指摘し、最後に次の一手を促してください。',
    ].join('\n'),
  },
  counterAttack: {
    title: '反論トレーニング 攻撃側',
    instruction: [
      'あなたは議論トレーニングの主張者です。',
      '論争的だが論理的に擁護できる主張を1つ提示し、短く理由を添えてください。',
      '最後に「この主張の弱点を突いてください。」と促してください。',
    ].join('\n'),
  },
  decision: {
    title: '意思決定ログ',
    instruction: [
      'あなたは意思決定を構造化するコーチです。',
      '選択肢、判断基準、トレードオフ、不可逆性、次の小さな検証を整理してください。',
      'ユーザーが行動に移せるよう、最後に1つだけ具体的な問いを置いてください。',
    ].join('\n'),
  },
  output: {
    title: 'アウトプット力',
    instruction: [
      'あなたは要約・説明の採点者です。',
      '100点満点の点数、良かった点、改善点、模範要約を簡潔に返してください。',
      '採点は甘すぎず、次に伸ばす観点を明確にしてください。',
    ].join('\n'),
  },
  news: {
    title: 'ニュース分析',
    instruction: [
      'あなたは国際情勢・政治・経済の学習コーチです。',
      'ユーザーが貼ったニュースや論点を、何が起きたか、なぜ重要か、この先どうなるかに分けて説明してください。',
      '最後に理解確認の記述式クイズを1問だけ出してください。',
    ].join('\n'),
  },
};

const styleGuide = {
  gentle: '口調は穏やかに。ユーザーの考えを尊重しつつ、少しだけ深い問いを返してください。',
  sharp: '口調は鋭めに。曖昧さ、根拠不足、飛躍を遠慮なく指摘してください。',
  socratic: '問い中心で返してください。説明は最小限にし、ユーザー自身に考えさせてください。',
  zen: '短く、余白のある言葉で返してください。言い切りすぎず、考える間を残してください。',
};

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolveBody(body));
    req.on('error', reject);
  });
}

function buildPrompt(payload) {
  const modeKey = payload.mode === 'counter' && payload.counterRole === 'attack'
    ? 'counterAttack'
    : payload.mode;
  const mode = modes[modeKey] || modes.socratic;
  const profile = payload.profile || {};
  const messages = Array.isArray(payload.messages) ? payload.messages.slice(-12) : [];
  const style = styleGuide[profile.style] || styleGuide.gentle;
  const profileLines = [
    profile.name ? `名前: ${profile.name}` : '',
    profile.job ? `職業: ${profile.job}` : '',
    profile.worries ? `よく考えたいテーマ: ${profile.worries}` : '',
  ].filter(Boolean).join('\n');

  const transcript = messages.map(m => {
    const role = m.role === 'assistant' ? 'コーチ' : 'ユーザー';
    return `${role}: ${String(m.content || '').slice(0, 4000)}`;
  }).join('\n\n');

  return [
    'あなたはWebアプリ「Codex思考道場」の会話エンジンです。',
    'コード編集、ファイル操作、ツール実行は一切しません。会話の返答だけを作ってください。',
    '最終出力には、ユーザーに表示する日本語の返答本文だけを書いてください。',
    'Markdownは使ってよいですが、見出しは必要なときだけにしてください。',
    '返答は原則300字以内。ニュース分析や採点では必要に応じて500字まで可。',
    '',
    `【モード】${mode.title}`,
    mode.instruction,
    '',
    `【コーチスタイル】${style}`,
    profileLines ? `\n【ユーザープロフィール】\n${profileLines}` : '',
    transcript ? `\n【ここまでの会話】\n${transcript}` : '',
    '',
    '上の会話の続きとして、次のコーチ返答だけを出力してください。',
  ].filter(Boolean).join('\n');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      stdio: options.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', ...(options.env || {}) },
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${Math.round((options.timeoutMs || codexTimeoutMs) / 1000)}s`));
    }, options.timeoutMs || codexTimeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    if (options.input) child.stdin.end(options.input);
  });
}

async function getCodexExecHelp() {
  if (!codexExecHelpPromise) {
    codexExecHelpPromise = runCommand(codexBin, ['exec', '--help'], { timeoutMs: 15000 })
      .then(({ code, stdout, stderr }) => {
        if (code !== 0) throw new Error(stderr.trim() || 'Could not read codex exec --help');
        return `${stdout}\n${stderr}`;
      });
  }
  return codexExecHelpPromise;
}

function supportsOption(help, option) {
  return help.includes(option);
}

function pushFlag(args, help, flag) {
  if (supportsOption(help, flag)) args.push(flag);
}

function pushOption(args, help, flag, value) {
  if (supportsOption(help, flag)) args.push(flag, value);
}

function buildCodexArgs(help, outFile) {
  const args = ['exec'];

  pushFlag(args, help, '--skip-git-repo-check');
  pushFlag(args, help, '--ephemeral');
  pushFlag(args, help, '--ignore-rules');
  pushOption(args, help, '--sandbox', 'read-only');
  pushOption(args, help, '--ask-for-approval', 'never');
  pushOption(args, help, '--color', 'never');
  pushOption(args, help, '--output-last-message', outFile);

  if (codexModel) args.push('-m', codexModel);
  if (supportsOption(help, '-C, --cd') || supportsOption(help, '--cd')) args.push('-C', root);
  args.push('-');

  return args;
}

async function runCodex(prompt) {
  if (process.env.CODEX_MOCK === '1') {
    return 'CODEX_MOCK=1 のため、ここでは仮の返答です。あなたの考えの前提を1つだけ疑うなら、どこから見直しますか？';
  }

  const help = await getCodexExecHelp();
  const outFile = join(tmpdir(), `codex-thinking-dojo-${randomUUID()}.txt`);
  const args = buildCodexArgs(help, outFile);
  const { code, stdout, stderr } = await runCommand(codexBin, args, {
    cwd: root,
    input: prompt,
    timeoutMs: codexTimeoutMs,
  });

  if (code !== 0) {
    const details = stderr.trim() || stdout.trim() || `Codex exited with code ${code}`;
    throw new Error(details);
  }

  try {
    const text = supportsOption(help, '--output-last-message')
      ? (await readFile(outFile, 'utf8')).trim()
      : stdout.trim();
    return text || '返答が空でした。もう一度送ってください。';
  } finally {
    unlink(outFile).catch(() => {});
  }
}

async function handleApi(req, res) {
  if (req.method === 'GET' && req.url === '/api/health') {
    let supportedOptions = [];
    try {
      const help = await getCodexExecHelp();
      supportedOptions = [
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-rules',
        '--sandbox',
        '--ask-for-approval',
        '--color',
        '--output-last-message',
        '--cd',
      ].filter(option => supportsOption(help, option));
    } catch {}
    return json(res, 200, {
      ok: true,
      codexBin,
      model: codexModel || '(Codex CLI default)',
      mock: process.env.CODEX_MOCK === '1',
      supportedOptions,
    });
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const body = JSON.parse(await readBody(req));
      const prompt = buildPrompt(body);
      const reply = await runCodex(prompt);
      return json(res, 200, { reply });
    } catch (err) {
      return json(res, 500, { error: err.message || String(err) });
    }
  }

  return false;
}

async function serveStatic(req, res) {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const cleanPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = resolve(publicDir, `.${cleanPath}`);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error('not a file');
    const content = await readFile(filePath);
    res.writeHead(200, { 'content-type': mime[extname(filePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

createServer(async (req, res) => {
  if ((req.url || '').startsWith('/api/')) {
    const handled = await handleApi(req, res);
    if (handled !== false) return;
  }
  await serveStatic(req, res);
}).listen(port, host, () => {
  console.log(`Codex Thinking Dojo: http://${host}:${port}`);
  console.log(`Codex binary: ${codexBin}`);
  console.log(`Model: ${codexModel || '(Codex CLI default)'}`);
});
