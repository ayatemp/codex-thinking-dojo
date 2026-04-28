const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const modeMeta = {
  socratic: { title: '対話', sub: '問いで思考を深める', first: '今日は何について考えますか？悩み、違和感、最近の出来事、どれでも大丈夫です。' },
  counter: { title: '反論トレーニング', sub: 'Codexがあえて反論します', first: 'あなたの主張を入力してください。Codexが前提や根拠を突きます。' },
  decision: { title: '意思決定ログ', sub: '選択を構造化する', first: 'いま迷っている選択を書いてください。小さな決断でもOKです。' },
  output: { title: 'アウトプット力', sub: '要約・説明を採点する', first: '下の題材を読んで、自分の言葉で要約してください。\n\n題材: AI時代には、情報を覚える力だけでなく、問いを立てる力、説明する力、検証する力が重要になる。便利なツールが増えるほど、何を任せ、何を自分で考えるかを選ぶ判断力が問われる。' },
  news: { title: 'ニュース分析', sub: '貼ったニュースを分析してクイズ化', first: '分析したいニュース本文やURL、気になる国際情勢の論点を貼ってください。Codexが構造化して、理解確認クイズを出します。' },
};

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
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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
