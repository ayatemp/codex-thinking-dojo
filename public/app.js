const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const modeMeta = {
  socratic: { title: '対話', sub: '問いで思考を深める', first: '今日は何について考えますか？悩み、違和感、最近の出来事、どれでも大丈夫です。' },
  counter: { title: '反論トレーニング', sub: 'Codexがあえて反論します', first: 'あなたの主張を入力してください。Codexが前提や根拠を突きます。' },
  decision: { title: '意思決定ログ', sub: '選択を構造化する', first: 'いま迷っている選択を書いてください。小さな決断でもOKです。' },
  output: { title: 'アウトプット力', sub: '要約・説明を採点する', first: '下の題材を読んで、自分の言葉で要約してください。\n\n題材: AI時代には、情報を覚える力だけでなく、問いを立てる力、説明する力、検証する力が重要になる。便利なツールが増えるほど、何を任せ、何を自分で考えるかを選ぶ判断力が問われる。' },
  news: { title: 'ニュース分析', sub: '貼ったニュースを分析してクイズ化', first: '分析したいニュース本文やURL、気になる国際情勢の論点を貼ってください。Codexが構造化して、理解確認クイズを出します。' },
};

const abilityMeta = [
  { key: 'concrete', label: '具体化', hint: '例・数字・状況を入れて話せているか' },
  { key: 'structure', label: '構造化', hint: '選択肢や論点を分けて整理できているか' },
  { key: 'critical', label: '批判思考', hint: '根拠・反例・前提を疑えているか' },
  { key: 'decision', label: '意思決定', hint: '基準と次の行動に落とせているか' },
  { key: 'expression', label: '表現力', hint: '要約・説明が伝わる密度になっているか' },
];

const defaultAbilityScores = Object.fromEntries(abilityMeta.map(item => [item.key, 35]));

const state = {
  mode: 'socratic',
  messages: [],
  loading: false,
  counterRole: 'defense',
};

const storage = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); },
};

function today() {
  return formatDate(new Date());
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(date, offset) {
  const next = new Date(date);
  next.setDate(next.getDate() + offset);
  return next;
}

function getProfile() {
  return storage.get('profile', { name: '', job: '', worries: '', style: 'gentle' });
}

function getDaily() {
  const d = storage.get('daily', { date: today(), score: 0 });
  return d.date === today() ? d : { date: today(), score: 0 };
}

function addPoints(n) {
  const daily = getDaily();
  daily.score = Math.min(100, daily.score + n);
  storage.set('daily', daily);
  if (daily.score >= 100) {
    const streak = storage.get('streak', { current: 0, lastDate: '' });
    if (streak.lastDate !== today()) {
      streak.current += 1;
      streak.lastDate = today();
      storage.set('streak', streak);
      toast('今日の鍛錬を達成しました');
    }
  }
  renderHome();
}

function renderHome() {
  const daily = getDaily();
  $('#daily-label').textContent = `${daily.score} / 100 pt`;
  $('#daily-meter').style.width = `${daily.score}%`;
  const streak = storage.get('streak', { current: 0 });
  $('#streak').textContent = `${streak.current || 0}日`;

  const sessions = storage.get('sessions', []).slice(-8).reverse();
  $('#history').innerHTML = sessions.length
    ? sessions.map(s => `<div class="history-item"><strong>${escapeHtml(s.modeTitle)}</strong><span>${escapeHtml(s.date)}</span></div>`).join('')
    : 'まだセッションはありません。最初の1往復を始めましょう。';

  renderHeatmap();
  renderAbility();
}

function gotoScreen(name) {
  $$('.screen').forEach(el => el.classList.remove('active'));
  $(`#screen-${name}`).classList.add('active');
  $$('.nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.screen === name));
  $('.nav').style.display = name === 'chat' ? 'none' : 'flex';
  if (name === 'home') renderHome();
  if (name === 'profile') loadProfile();
}

function startMode(mode) {
  state.mode = mode;
  state.messages = [];
  state.loading = false;
  state.counterRole = 'defense';
  const meta = modeMeta[mode];
  $('#chat-title').textContent = meta.title;
  $('#chat-sub').textContent = meta.sub;
  $('#messages').innerHTML = '';
  $('#role-btn').classList.toggle('hidden', mode !== 'counter');
  $('#role-btn').textContent = '守';
  $('#input').placeholder = mode === 'news' ? 'ニュース本文や論点を貼る...' : '入力してください...';
  appendMessage('note', meta.first);
  gotoScreen('chat');
  setTimeout(() => $('#input').focus(), 50);
}

function appendMessage(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  $('#messages').appendChild(el);
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  return el;
}

async function sendMessage(text) {
  if (state.loading || !text.trim()) return;
  const userText = text.trim();
  $('#input').value = '';
  autoresize($('#input'));
  appendMessage('user', userText);
  state.messages.push({ role: 'user', content: userText });

  state.loading = true;
  $('#send').disabled = true;
  const loading = appendMessage('assistant loading', 'Codexが考えています...');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: state.mode,
        messages: state.messages,
        profile: getProfile(),
        counterRole: state.counterRole,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    loading.className = 'msg assistant';
    loading.textContent = data.reply;
    state.messages.push({ role: 'assistant', content: data.reply });
    recordPractice(state.mode, userText);
    updateAbilityFromExchange(state.mode, userText);
    addPoints(12);
  } catch (err) {
    loading.className = 'msg note';
    loading.textContent = `エラー: ${err.message}`;
  } finally {
    state.loading = false;
    $('#send').disabled = false;
    $('#input').focus();
    saveSessionDraft();
  }
}

function getTrainingLog() {
  return storage.get('trainingLog', {});
}

function getTrainingLogForDisplay() {
  const log = getTrainingLog();
  const view = JSON.parse(JSON.stringify(log));
  for (const session of storage.get('sessions', [])) {
    if (!session.date || view[session.date]) continue;
    view[session.date] = {
      count: Math.max(1, Number(session.exchanges) || 1),
      modes: session.mode ? { [session.mode]: 1 } : {},
      chars: 0,
    };
  }
  const daily = getDaily();
  if (daily.score > 0 && !view[daily.date]) {
    view[daily.date] = {
      count: Math.max(1, Math.round(daily.score / 12)),
      modes: {},
      chars: 0,
    };
  }
  return view;
}

function recordPractice(mode, userText) {
  const log = getTrainingLog();
  const key = today();
  const entry = log[key] || { count: 0, modes: {}, chars: 0 };
  entry.count += 1;
  entry.chars += userText.length;
  entry.modes[mode] = (entry.modes[mode] || 0) + 1;
  log[key] = entry;
  storage.set('trainingLog', log);
}

function getLastThirtyDays() {
  const now = new Date();
  return Array.from({ length: 30 }, (_, i) => addDays(now, i - 29));
}

function heatLevel(count) {
  if (!count) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

function renderHeatmap() {
  const log = getTrainingLogForDisplay();
  const days = getLastThirtyDays();
  const todayKey = today();
  const total = days.reduce((sum, d) => sum + (log[formatDate(d)]?.count || 0), 0);
  const blanks = days[0].getDay();
  $('#month-total').textContent = `${total}回`;
  const blankCells = Array.from({ length: blanks }, () => '<span class="heat-cell empty" aria-hidden="true"></span>').join('');
  const dayCells = days.map(d => {
    const key = formatDate(d);
    const count = log[key]?.count || 0;
    const level = heatLevel(count);
    const label = `${key}: ${count}回`;
    return `<span class="heat-cell level-${level}${key === todayKey ? ' today' : ''}" title="${label}" aria-label="${label}"></span>`;
  }).join('');
  $('#heatmap').innerHTML = blankCells + dayCells;
}

function getAbilityState() {
  return storage.get('abilityState', {
    count: 0,
    scores: { ...defaultAbilityScores },
    updatedAt: '',
  });
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function countMatches(text, patterns) {
  return patterns.reduce((sum, pattern) => sum + (text.match(pattern) || []).length, 0);
}

function scoreText(mode, text) {
  const len = text.length;
  const hasNumber = /\d|一|二|三|四|五|六|七|八|九|十/.test(text);
  const concreteSignals = countMatches(text, [/例えば/g, /具体/g, /ケース/g, /状況/g, /実際/g, /とき/g]);
  const structureSignals = countMatches(text, [/まず/g, /次に/g, /一方/g, /理由/g, /選択肢/g, /基準/g, /メリット/g, /デメリット/g, /[:：]/g, /\n/g]);
  const criticalSignals = countMatches(text, [/なぜ/g, /本当に/g, /根拠/g, /反例/g, /前提/g, /リスク/g, /懸念/g, /ただ/g, /しかし/g]);
  const decisionSignals = countMatches(text, [/する/g, /やる/g, /決め/g, /選/g, /次/g, /優先/g, /試す/g, /検証/g, /期限/g]);
  const expressionSignals = countMatches(text, [/つまり/g, /要するに/g, /結論/g, /説明/g, /まとめ/g, /伝え/g]);

  const base = {
    concrete: 28 + Math.min(34, len / 7) + concreteSignals * 9 + (hasNumber ? 8 : 0),
    structure: 30 + Math.min(28, len / 9) + structureSignals * 8,
    critical: 30 + Math.min(24, len / 12) + criticalSignals * 9,
    decision: 28 + Math.min(24, len / 10) + decisionSignals * 7,
    expression: 34 + Math.min(30, len / 8) + expressionSignals * 8,
  };

  if (mode === 'counter') base.critical += 14;
  if (mode === 'decision') base.decision += 16;
  if (mode === 'output') base.expression += 16;
  if (mode === 'news') {
    base.structure += 8;
    base.critical += 8;
  }
  if (mode === 'socratic') base.concrete += 6;

  return Object.fromEntries(abilityMeta.map(item => [item.key, clampScore(base[item.key])]));
}

function updateAbilityFromExchange(mode, userText) {
  const ability = getAbilityState();
  const measured = scoreText(mode, userText);
  const alpha = ability.count < 5 ? 0.34 : 0.22;
  const nextScores = {};
  for (const item of abilityMeta) {
    const prev = ability.scores[item.key] ?? defaultAbilityScores[item.key];
    nextScores[item.key] = clampScore(prev * (1 - alpha) + measured[item.key] * alpha);
  }
  storage.set('abilityState', {
    count: ability.count + 1,
    scores: nextScores,
    updatedAt: today(),
  });
}

function renderAbility() {
  const ability = getAbilityState();
  const scores = { ...defaultAbilityScores, ...ability.scores };
  const values = abilityMeta.map(item => scores[item.key]);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const weakest = abilityMeta.reduce((min, item) => scores[item.key] < scores[min.key] ? item : min, abilityMeta[0]);

  $('#ability-average').textContent = ability.count ? `${Math.round(avg)}` : '--';
  $('#ability-summary').textContent = ability.count
    ? `次の焦点: ${weakest.label}`
    : '鍛錬すると更新されます';
  $('#ability-list').innerHTML = abilityMeta.map(item => `
    <div class="ability-row" title="${escapeHtml(item.hint)}">
      <span>${escapeHtml(item.label)}</span>
      <div class="ability-bar"><span style="width:${scores[item.key]}%"></span></div>
      <strong>${scores[item.key]}</strong>
    </div>
  `).join('');

  renderRadar(scores);
}

function polarPoint(cx, cy, radius, index, total) {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total;
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
  };
}

function pointsAttr(points) {
  return points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

function renderRadar(scores) {
  const cx = 130;
  const cy = 112;
  const radius = 70;
  const total = abilityMeta.length;
  const grid = [0.25, 0.5, 0.75, 1].map(level => {
    const points = abilityMeta.map((_, i) => polarPoint(cx, cy, radius * level, i, total));
    return `<polygon class="radar-grid" points="${pointsAttr(points)}"></polygon>`;
  }).join('');
  const axes = abilityMeta.map((_, i) => {
    const p = polarPoint(cx, cy, radius, i, total);
    return `<line class="radar-axis" x1="${cx}" y1="${cy}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}"></line>`;
  }).join('');
  const shapePoints = abilityMeta.map((item, i) => polarPoint(cx, cy, radius * (scores[item.key] / 100), i, total));
  const dots = shapePoints.map(p => `<circle class="radar-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.8"></circle>`).join('');
  const labels = abilityMeta.map((item, i) => {
    const label = polarPoint(cx, cy, radius + 31, i, total);
    const anchor = Math.abs(label.x - cx) < 8 ? 'middle' : label.x > cx ? 'start' : 'end';
    return `
      <text class="radar-label" x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" text-anchor="${anchor}">${item.label}</text>
      <text class="radar-value" x="${label.x.toFixed(1)}" y="${(label.y + 14).toFixed(1)}" text-anchor="${anchor}">${scores[item.key]}</text>
    `;
  }).join('');

  $('#ability-radar').innerHTML = `
    ${grid}
    ${axes}
    <polygon class="radar-shape" points="${pointsAttr(shapePoints)}"></polygon>
    ${dots}
    ${labels}
  `;
}

function saveSessionDraft() {
  if (state.messages.length < 2) return;
  const sessions = storage.get('sessions', []);
  const last = sessions[sessions.length - 1];
  const entry = {
    date: today(),
    mode: state.mode,
    modeTitle: modeMeta[state.mode].title,
  };
  if (last?.date === entry.date && last?.mode === entry.mode) sessions[sessions.length - 1] = entry;
  else sessions.push(entry);
  storage.set('sessions', sessions.slice(-50));
}

function loadProfile() {
  const p = getProfile();
  $('#profile-name').value = p.name || '';
  $('#profile-job').value = p.job || '';
  $('#profile-worries').value = p.worries || '';
  $('#profile-style').value = p.style || 'gentle';
}

function saveProfile(event) {
  event.preventDefault();
  storage.set('profile', {
    name: $('#profile-name').value.trim(),
    job: $('#profile-job').value.trim(),
    worries: $('#profile-worries').value.trim(),
    style: $('#profile-style').value,
  });
  toast('プロフィールを保存しました');
}

function toast(text) {
  $('#toast').textContent = text;
  $('#toast').classList.add('show');
  setTimeout(() => $('#toast').classList.remove('show'), 2200);
}

function autoresize(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

$$('.mode-card').forEach(btn => btn.addEventListener('click', () => startMode(btn.dataset.mode)));
$$('.nav button').forEach(btn => btn.addEventListener('click', () => gotoScreen(btn.dataset.screen)));
$('#back-btn').addEventListener('click', () => gotoScreen('home'));
$('#profile-form').addEventListener('submit', saveProfile);
$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage($('#input').value);
});
$('#input').addEventListener('input', event => autoresize(event.target));
$('#input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage($('#input').value);
  }
});
$('#role-btn').addEventListener('click', async () => {
  if (state.loading) return;
  state.counterRole = state.counterRole === 'defense' ? 'attack' : 'defense';
  $('#role-btn').textContent = state.counterRole === 'attack' ? '攻' : '守';
  if (state.counterRole === 'attack') {
    appendMessage('note', '攻守交代。Codexが主張を出します。あなたは弱点を突いてください。');
    await sendMessage('攻守交代。議論の題材になる主張を1つ提示してください。');
  } else {
    appendMessage('note', '守りに戻りました。あなたの主張を入力してください。');
  }
});

renderHome();
