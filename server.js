// 🛟 Noah — always-online recovery bot for Clawd + all OpenClaw agents.
// Job: if Michael loses Clawd/the Mac mini, Noah knows the whole brain + walks him
// through restoring everything from the encrypted vault. Read-mostly. Map, not the hands.

const express = require('express');
const fs = require('fs');
const path = require('path');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_CHAT_ID = String(process.env.OWNER_CHAT_ID || '8322726860'); // Michael
const MODEL = process.env.MODEL || 'claude-opus-5';
const PORT = process.env.PORT || 3000;

// Brain: use bundled ./brain if present, else clone the private brain repo at startup via PAT.
let BRAIN_DIR = path.join(__dirname, 'brain');
if (!fs.existsSync(BRAIN_DIR) && process.env.BRAIN_REPO_PAT) {
  try {
    const { execSync } = require('child_process');
    const repo = process.env.BRAIN_REPO || 'github.com/clawd1993-hue/noah-recovery.git';
    const dest = path.join(__dirname, '_brain');
    console.log('cloning private brain...');
    execSync(`rm -rf ${dest} && git clone --depth 1 https://x-access-token:${process.env.BRAIN_REPO_PAT}@${repo} ${dest}`, { stdio: 'inherit' });
    BRAIN_DIR = path.join(dest, 'brain');
  } catch (e) { console.error('brain clone failed:', e.message); }
}

// ---------- load the brain into memory ----------
let BRAIN = []; // {rel, text}
function loadBrain(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) loadBrain(p);
    else if (/\.(md|txt|json|js)$/i.test(e.name)) {
      try { BRAIN.push({ rel: path.relative(BRAIN_DIR, p), text: fs.readFileSync(p, 'utf8') }); } catch {}
    }
  }
}
try { loadBrain(BRAIN_DIR); } catch (e) { console.error('brain load error', e); }
console.log(`Noah brain loaded: ${BRAIN.length} files`);

const CORE = ['noah-restore-runbook', 'openclaw-ops-bible']; // always-loaded essentials (small)
function isCore(rel) { return CORE.some(c => rel.includes(c)); }

// ---------- keyword retrieval (loads FULL file contents, not just names) ----------
const STOP = new Set('the and for you this that with what how are can get got our your has have was were will just like about tell them they then than into over out all any but not who why when where here there does did done any some more most much very who whom into onto its his her their'.split(' '));
function retrieve(query, budget = 320000) {
  // distinct, meaningful query words only
  const words = [...new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(w => !STOP.has(w)))];
  const core = BRAIN.filter(f => isCore(f.rel));
  const rest = BRAIN.filter(f => !isCore(f.rel)).map(f => {
    const lt = f.text.toLowerCase();
    const ln = f.rel.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (ln.includes(w)) score += 8;      // filename match = very strong
      else if (lt.includes(w)) score += 2; // presence once (not frequency) so big files don't dominate
    }
    return { f, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 25).map(x => x.f);

  // relevant matches FIRST (so they always make the window), then the small core docs
  let out = '', used = 0;
  for (const f of [...rest, ...core]) {
    const chunk = `\n\n===== FILE: ${f.rel} =====\n${f.text}`;
    if (used + chunk.length > budget) { out += chunk.slice(0, Math.max(0, budget - used)); break; }
    out += chunk; used += chunk.length;
  }
  return out;
}

const SYSTEM = `You are Noah — Michael's always-online recovery bot.

WHO YOU ARE: A calm, sharp backup brain that lives in the cloud, independent of Michael's Mac mini. You hold the complete knowledge of "Clawd" (Michael's main AI partner/COO) and all of Clawd's sub-agents, plus how the whole OpenClaw system is wired.

YOUR ONE JOB: If Michael has lost Clawd or the Mac mini is down, help him get everything back — calmly, one step at a time, from his phone. You are the MAP, not the hands: you explain, look things up, and guide. You cannot decrypt the vault (only Michael's passphrase can) and you don't touch live systems yourself.

HOW TO ANSWER:
- Talk like a competent friend. Plain language. Short. No walls of text.
- In a restore, give ONE step at a time, confirm it worked, then the next.
- Ground every answer in the CONTEXT files below. If something isn't in your knowledge, say so plainly — don't invent.
- The encrypted vault lives on Google Drive (clawd1993@gmail.com), newest file clawd-vault-core-YYYY-MM-DD.tar.gz.enc. The passphrase is ONLY in Michael's password manager.
- Once Clawd is restored, Clawd takes back over as normal operator; your job ends.

You are talking ONLY to Michael. Use the CONTEXT below (relevant slices of Clawd's brain) to answer.`;

async function askClaude(userText) {
  const context = retrieve(userText);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1500,
      system: SYSTEM + '\n\n===== CONTEXT (Clawd brain slices) =====' + context,
      messages: [{ role: 'user', content: userText }]
    })
  });
  const j = await r.json();
  if (j.error) { console.error('anthropic error', j.error); return `⚠️ Brain error: ${j.error.message || 'unknown'}`; }
  return (j.content || []).map(c => c.text).join('\n').trim() || '(no reply)';
}

// ---------- telegram ----------
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}
async function send(chatId, text) {
  for (let i = 0; i < text.length; i += 3900) await tg('sendMessage', { chat_id: chatId, text: text.slice(i, i + 3900) });
}

let offset = 0;
async function poll() {
  try {
    const res = await tg('getUpdates', { offset, timeout: 30 });
    for (const u of (res.result || [])) {
      offset = u.update_id + 1;
      const m = u.message; if (!m || !m.text) continue;
      const chatId = String(m.chat.id);
      if (chatId !== OWNER_CHAT_ID) { await send(chatId, "Sorry — I'm Michael's private recovery bot and can't help here."); continue; }
      if (m.text === '/start') { await send(chatId, "🛟 Hey Michael — I'm Noah, your backup brain. I'm always online, and I hold Clawd's entire memory + how to restore everything if the mini ever goes down. Ask me anything, or if something's broken, just tell me what happened and I'll walk you through it."); continue; }
      await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
      const reply = await askClaude(m.text);
      await send(chatId, reply);
    }
  } catch (e) { console.error('poll error', e.message); }
  setTimeout(poll, 500);
}

// ---------- web (Render health check) ----------
const app = express();
app.get('/', (_, res) => res.send(`🛟 Noah is alive. Brain: ${BRAIN.length} files. Model: ${MODEL}.`));
app.listen(PORT, () => {
  console.log(`Noah web up on ${PORT}`);
  if (TELEGRAM_TOKEN && ANTHROPIC_API_KEY) poll();
  else console.error('MISSING env: TELEGRAM_TOKEN and/or ANTHROPIC_API_KEY');
});
