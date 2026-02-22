import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import type { OnboardSession } from './db/schema.js';
import path from 'path';

const app = new Hono();

app.use('*', cors());

// In-memory storage for MVP
const agents: any[] = [];
const tasks: any[] = [];
const waitlist: any[] = [];

interface PitchSubmission {
  uuid: string;
  email: string;
  text: string;
  links: string[];
  audioTranscript?: string;
  audioBase64?: string;
  status: 'generating' | 'ready' | 'error';
  progress: number; // 0-100
  createdAt: string;
  url?: string;
  html?: string;
  error?: string;
}
// --- Pitch file store (survives container restarts) ---
const PITCHES_FILE = process.env.PITCHES_FILE || '/data/pitches.json';

function loadPitches(): Map<string, PitchSubmission> {
  try {
    const raw = fs.readFileSync(PITCHES_FILE, 'utf8');
    const entries: [string, PitchSubmission][] = JSON.parse(raw);
    return new Map(entries);
  } catch {
    return new Map(); // file missing or corrupt → start fresh
  }
}

function savePitches(): void {
  try {
    fs.mkdirSync(path.dirname(PITCHES_FILE), { recursive: true });
    fs.writeFileSync(PITCHES_FILE, JSON.stringify([...pitches.entries()]), 'utf8');
  } catch (e) {
    console.error('savePitches failed:', e);
  }
}

const pitches = loadPitches();
console.log(`📂 Loaded ${pitches.size} pitch(es) from ${PITCHES_FILE}`);

// Telegram notification (best-effort)
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_NOTIFY_CHAT = process.env.TG_NOTIFY_CHAT || '437589940';

async function notifyTelegram(text: string) {
  if (!TG_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_NOTIFY_CHAT, text, parse_mode: 'HTML' }),
    });
  } catch (_) { /* best effort */ }
}

// ─── CRM / Lead Tracking ─────────────────────────────────────────────────────
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';
const BREVO_LIST_ID = parseInt(process.env.BREVO_LIST_ID || '0', 10); // Brevo contact list ID
const TWENTY_API_URL = process.env.TWENTY_API_URL || ''; // e.g. http://crm.machinemachine.ai
const TWENTY_API_KEY = process.env.TWENTY_API_KEY || '';

async function trackLead(opts: {
  email: string;
  text: string;
  links: string[];
  pitchUrl: string;
}) {
  const { email, text, links, pitchUrl } = opts;
  const sourceUrl = links[0] || '';
  const textSnippet = text?.slice(0, 200) || '';

  // 1. Brevo — create/update contact + add to list for automated sequence
  if (BREVO_API_KEY) {
    try {
      await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: {
          'api-key': BREVO_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          updateEnabled: true,
          listIds: BREVO_LIST_ID ? [BREVO_LIST_ID] : [],
          attributes: {
            PITCH_URL: pitchUrl,
            SOURCE_URL: sourceUrl,
            DESCRIPTION: textSnippet,
            SUBMITTED_AT: new Date().toISOString(),
          },
        }),
      });
    } catch (_) { /* best effort */ }
  }

  // 2. Twenty CRM — create person record
  if (TWENTY_API_URL && TWENTY_API_KEY) {
    try {
      const firstName = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const res = await fetch(`${TWENTY_API_URL}/graphql`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TWENTY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `mutation {
            createPerson(data: {
              name: { firstName: "${firstName}", lastName: "" }
              emails: { primaryEmail: "${email}" }
            }) { id }
          }`,
        }),
      });
      // If person created, add a note with pitch context
      const data = await res.json() as any;
      const personId = data?.data?.createPerson?.id;
      if (personId && textSnippet) {
        await fetch(`${TWENTY_API_URL}/graphql`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${TWENTY_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: `mutation {
              createNote(data: {
                body: "Pitch submitted via machinemachine.ai\\nURL: ${pitchUrl}\\nSource: ${sourceUrl}\\nDescription: ${textSnippet.replace(/"/g, "'")}"
                noteTargets: { createMany: { data: [{ personId: "${personId}" }] } }
              }) { id }
            }`,
          }),
        });
      }
    } catch (_) { /* best effort */ }
  }
}

// ─── Confirmation Email ───────────────────────────────────────────────────────
const BREVO_SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'hello@machinemachine.ai';
const BREVO_SENDER_NAME  = process.env.BREVO_SENDER_NAME  || 'Machine.Machine';

async function sendConfirmationEmail(pitch: PitchSubmission) {
  if (!BREVO_API_KEY) return;

  const firstName = pitch.email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const sourceUrl = pitch.links?.[0] || '';
  const context   = [pitch.text, pitch.audioTranscript, sourceUrl].filter(Boolean).join('\n').slice(0, 600);

  // Generate a short personalized email body with AI
  const prompt = `You are writing a short, warm, personal email on behalf of Machine.Machine (an AI team-building company).

A potential client just submitted a pitch request. Here's what they shared:
${context || '(only a URL provided)'}

Their email: ${pitch.email}
Their pitch is ready at: ${pitch.url}

Write a short confirmation email (4–6 sentences max). Requirements:
- Address them by first name: ${firstName}
- Reference something specific from what they shared (their industry, problem, or domain)
- Tell them their personalised pitch is ready and link to it
- End with a warm, low-pressure invitation to reply if they have questions
- Tone: sharp, human, not corporate, not salesy
- Language: match the language of their submission (default English)
- Output ONLY the email body HTML (no subject, no greeting header — just the <p> tags)`;

  let emailHtml = '';
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const anthropic = new Anthropic();
      const msg = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      });
      emailHtml = msg.content
        .filter((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === 'text')
        .map((b: Anthropic.TextBlock) => b.text)
        .join('');
    } else {
      emailHtml = await generateWithCerebras('You write short warm confirmation emails.', prompt);
    }
  } catch (_) {
    // Fallback to simple template
    emailHtml = `<p>Hi ${firstName},</p>
<p>Your personalised Machine.Machine pitch is ready. We built it specifically around what you shared — take a look and let us know what you think.</p>
<p><a href="${pitch.url}" style="color:#7C3AED;font-weight:bold;">View your pitch →</a></p>
<p>If anything feels off or you have questions, just reply to this email. We're here.</p>`;
  }

  // Wrap in minimal branded shell
  const fullHtml = `<!DOCTYPE html><html><body style="font-family:Inter,sans-serif;background:#f9f9f9;padding:40px 0;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:40px;color:#1a1a2e;line-height:1.7;">
  <div style="font-size:1.5rem;font-weight:700;background:linear-gradient(135deg,#3b82f6,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:24px;">M²</div>
  ${emailHtml}
  <hr style="border:none;border-top:1px solid #eee;margin:32px 0;">
  <p style="font-size:0.8rem;color:#aaa;">Machine.Machine · <a href="https://machinemachine.ai" style="color:#aaa;">machinemachine.ai</a></p>
</div></body></html>`;

  // Determine subject line language hint from pitch text
  const isGerman  = /\b(wir|und|die|das|der|ist|für|sie|mit)\b/i.test(pitch.text || '');
  const isPolish  = /\b(jest|dla|się|jako|przez|tego|który)\b/i.test(pitch.text || '');
  const subject   = isGerman  ? `Dein Machine.Machine Pitch ist bereit ✨` :
                    isPolish  ? `Twój pitch Machine.Machine jest gotowy ✨` :
                                `Your Machine.Machine pitch is ready ✨`;

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender:      { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
      to:          [{ email: pitch.email }],
      subject,
      htmlContent: fullHtml,
    }),
  });
}

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString()
  });
});

// Root
app.get('/', (c) => {
  return c.json({
    name: 'MachineMachine API',
    version: '0.1.0',
    health: '/health'
  });
});

// Agents
app.get('/v1/agents', (c) => {
  return c.json({ agents, total: agents.length });
});

app.post('/v1/agents/register', async (c) => {
  const body = await c.req.json();
  const apiKey = `mm_${crypto.randomUUID().replace(/-/g, '')}`;
  
  const agent = {
    id: crypto.randomUUID(),
    name: body.name,
    description: body.description || '',
    capabilities: body.capabilities || [],
    status: 'active',
    apiKey,
    createdAt: new Date().toISOString()
  };
  
  agents.push(agent);
  
  return c.json({
    success: true,
    agent: { ...agent, apiKey: undefined },
    api_key: apiKey,
    message: 'Agent registered!'
  });
});

app.get('/v1/agents/:name', (c) => {
  const name = c.req.param('name');
  const agent = agents.find(a => a.name === name);
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  return c.json({ agent: { ...agent, apiKey: undefined } });
});

// Tasks
app.get('/v1/tasks', (c) => {
  return c.json({ tasks, total: tasks.length });
});

app.post('/v1/tasks', async (c) => {
  const body = await c.req.json();
  
  const task = {
    id: crypto.randomUUID(),
    title: body.title,
    description: body.description,
    status: 'open',
    createdAt: new Date().toISOString()
  };
  
  tasks.push(task);
  return c.json({ success: true, task });
});

// Waitlist / Early Access
app.post('/v1/waitlist', async (c) => {
  const body = await c.req.json();
  
  if (!body.email) {
    return c.json({ error: 'Email is required' }, 400);
  }

  // Check duplicate
  if (waitlist.find(w => w.email === body.email)) {
    return c.json({ success: true, message: "You're already on the list!" });
  }

  const entry = {
    id: crypto.randomUUID(),
    email: body.email,
    name: body.name || '',
    company: body.company || '',
    useCase: body.useCase || '',
    createdAt: new Date().toISOString(),
  };

  waitlist.push(entry);

  // Notify via Telegram
  const msg = `🚀 <b>New Early Access Signup!</b>\n\n` +
    `📧 ${entry.email}\n` +
    (entry.name ? `👤 ${entry.name}\n` : '') +
    (entry.company ? `🏢 ${entry.company}\n` : '') +
    (entry.useCase ? `💡 ${entry.useCase}\n` : '') +
    `\n#${waitlist.length} on waitlist`;
  notifyTelegram(msg);

  return c.json({
    success: true,
    message: "You're on the list! We'll be in touch soon.",
    position: waitlist.length,
  });
});

app.get('/v1/waitlist/count', (c) => {
  return c.json({ count: waitlist.length });
});

// --- Pitch generation ---

async function transcribeAudio(base64Audio: string): Promise<string> {
  try {
    // Decode base64 to binary
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    const blob = new Blob([audioBuffer], { type: 'audio/webm' });

    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', 'Systran/faster-whisper-large-v3');

    const res = await fetch(
      'http://speaches-l0w808o4k80k0gogg88s80cc:8000/v1/audio/transcriptions',
      { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) },
    );

    if (!res.ok) throw new Error(`Speaches returned ${res.status}`);
    const data = (await res.json()) as { text?: string };
    return data.text || '';
  } catch {
    return 'Audio transcription unavailable';
  }
}

async function generateWithCerebras(systemPrompt: string, userPrompt: string): Promise<string> {
  const apiKey = process.env.CEREBRAS_API_KEY || '';
  const model = process.env.CEREBRAS_MODEL || 'zai-glm-4.7';
  const baseUrl = process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Cerebras API error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.choices?.[0]?.message?.content || '';
}

async function generatePitch(uuid: string) {
  const pitch = pitches.get(uuid);
  if (!pitch) return;

  // Increment progress smoothly during generation (5→85 over ~60s)
  pitch.progress = 5;
  const progressTimer = setInterval(() => {
    const p = pitches.get(uuid);
    if (!p || p.status !== 'generating') { clearInterval(progressTimer); return; }
    if (p.progress < 85) { p.progress = Math.min(85, p.progress + 2); }
  }, 1500);

  try {
    const useAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

    const userPrompt = `Generate a personalised pitch deck in German OR English (match the language of the submission) for the following team/company:

Context: ${pitch.text}
Links: ${pitch.links.join(', ')}
Audio transcript: ${pitch.audioTranscript || 'not provided'}

Design system (copy EXACTLY):
- Dark navy background: #0F1729
- Purple accent: #7C3AED, cyan accent: #00D9FF
- Font: Inter (Google Fonts)
- scroll-snap full-height slides (.deck > .slide)
- Left 4px gradient bar on non-title slides
- Same component classes: .label, .stat-grid, .card-grid, .comparison, .cta
- 10-12 slides covering: their specific problem → how Machine.Machine solves it for them → what their AI org would look like → concrete use cases for their domain → next steps (join waitlist)

CRITICAL CSS rules (must include verbatim — do NOT override these):
.slide { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
.slide h1,.slide h2,.slide h3,.slide h4 { text-align:center; }
.slide > p { text-align:center; margin-left:auto; margin-right:auto; max-width:720px; }
.slide .label, .slide span.label { display:block; text-align:center; width:100%; }
.org-chart { justify-content:center; width:100%; }
.org-node { text-align:center; }
.stat-item { text-align:center; }
.stat-item h3,.stat-item p { text-align:center; }

Make it feel written specifically for them — use their industry terms, their use cases, their team context.
Keep the Machine.Machine brand but frame everything around THEIR world.
End with: "Bereit? → machinemachine.ai" CTA.

Output ONLY the complete HTML document starting with <!DOCTYPE html>`;

    const systemPrompt =
      'You are a pitch deck generator. Generate a complete, self-contained HTML pitch deck for this company/team, using the exact design system described. Output ONLY the complete HTML document, no explanation.';

    let htmlContent = '';

    if (useAnthropic) {
      const anthropic = new Anthropic();
      const message = await anthropic.messages.create({
        model,
        max_tokens: 16000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      htmlContent =
        message.content
          .filter((b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === 'text')
          .map((b: Anthropic.TextBlock) => b.text)
          .join('') || '';
    } else {
      // Cerebras fallback (OpenAI-compatible, lightning fast)
      htmlContent = await generateWithCerebras(systemPrompt, userPrompt);
    }

    clearInterval(progressTimer);
    pitch.progress = 100;
    pitch.status = 'ready';
    pitch.html = htmlContent;
    pitch.url = `https://machinemachine.ai/pitch/${uuid}`;
    savePitches();

    notifyTelegram(`✅ Pitch ready for ${pitch.email}: machinemachine.ai/pitch/${uuid}`);

    // Send personalized confirmation email via Brevo
    sendConfirmationEmail(pitch).catch(() => {/* best effort */});
  } catch (err) {
    clearInterval(progressTimer);
    pitch.progress = 0;
    pitch.status = 'error';
    pitch.error = err instanceof Error ? err.message : String(err);
    savePitches();
    notifyTelegram(
      `❌ Pitch generation failed for ${pitch.email}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseLinks(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // comma-separated fallback
    }
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// POST /v1/pitch/submit
app.post('/v1/pitch/submit', async (c) => {
  let email = '';
  let text = '';
  let linksRaw: unknown = [];
  let audioBase64: string | undefined;

  const contentType = c.req.header('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    email = (form.get('email') as string) || '';
    text = (form.get('text') as string) || '';
    linksRaw = form.get('links') as string;
    audioBase64 = (form.get('audio') as string) || undefined;
  } else {
    const body = await c.req.json();
    email = body.email || '';
    text = body.text || '';
    linksRaw = body.links;
    audioBase64 = body.audioBase64 || body.audio || undefined;
  }

  if (!email) return c.json({ error: 'email is required' }, 400);

  const links = parseLinks(linksRaw);

  if (!text && links.length === 0 && !audioBase64) {
    return c.json({ error: 'Please provide a description, at least one link, or a voice recording.' }, 400);
  }
  const uuid = crypto.randomUUID();

  // Transcribe audio if provided
  let audioTranscript: string | undefined;
  if (audioBase64) {
    audioTranscript = await transcribeAudio(audioBase64);
  }

  const pitch: PitchSubmission = {
    uuid,
    email,
    text,
    links,
    audioTranscript,
    audioBase64,
    status: 'generating',
    progress: 0,
    createdAt: new Date().toISOString(),
    url: `https://machinemachine.ai/pitch/${uuid}`,
  };

  pitches.set(uuid, pitch);
  savePitches();

  // Fire-and-forget background generation + CRM tracking
  generatePitch(uuid);
  trackLead({ email, text, links, pitchUrl: `https://machinemachine.ai/pitch/${uuid}` });

  const truncatedText = text.length > 100 ? text.slice(0, 100) + '...' : text;
  notifyTelegram(
    `🎯 New pitch request: ${email} | text: ${truncatedText} | links: ${links.join(', ')}`,
  );

  return c.json({
    uuid,
    url: `https://machinemachine.ai/pitch/${uuid}`,
    progress: 0,
    message: 'Your pitch is being generated. This page will update automatically.',
  });
});

// GET /v1/pitch/:uuid/status
app.get('/v1/pitch/:uuid/status', (c) => {
  const uuid = c.req.param('uuid');
  const pitch = pitches.get(uuid);
  if (!pitch) return c.json({ error: 'Pitch not found' }, 404);

  const elapsed = Date.now() - new Date(pitch.createdAt).getTime();
  const etaSec = pitch.status === 'ready' ? 0 : Math.max(0, 60 - Math.floor(elapsed / 1000));

  return c.json({
    uuid: pitch.uuid,
    status: pitch.status,
    progress: pitch.progress ?? 0,
    url: pitch.url,
    createdAt: pitch.createdAt,
    eta_seconds: etaSec,
    ...(pitch.error ? { error: pitch.error } : {}),
  });
});

// GET /v1/pitch/:uuid/html
app.get('/v1/pitch/:uuid/html', (c) => {
  const uuid = c.req.param('uuid');
  const pitch = pitches.get(uuid);

  if (!pitch) return c.json({ error: 'Pitch not found' }, 404);

  if (pitch.status === 'ready' && pitch.html) {
    // Inject CSS fix for slide alignment (retroactive fix for all pitches)
    const cssfix = `<style>
/* === Pitch alignment fixes === */
.slide{display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;text-align:center!important}
.slide h1,.slide h2,.slide h3,.slide h4{text-align:center!important}
.slide>p{text-align:center!important;margin-left:auto!important;margin-right:auto!important;max-width:720px!important}
.slide .label,.slide span.label{display:block!important;text-align:center!important;width:100%!important}
.org-chart{justify-content:center!important;width:100%!important}
.org-node{text-align:center!important}
.stat-grid{justify-items:center!important}
.stat-item{text-align:center!important}
.stat-item h3,.stat-item h4,.stat-item p{text-align:center!important}
.comp-col h3,.comp-col h4{text-align:center!important}
.cta{display:block!important;text-align:center!important;margin-left:auto!important;margin-right:auto!important;width:fit-content!important}
</style></head>`;
    const ctaBar = `
<div id="m2-cta-bar" style="
  position:fixed;bottom:0;left:0;right:0;z-index:9999;
  background:linear-gradient(90deg,#0f1729ee,#1a0a3fee);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  border-top:1px solid #7c3aed55;
  padding:12px 24px;
  display:flex;align-items:center;justify-content:space-between;
  gap:16px;font-family:inherit;">
  <span style="color:#94a3b8;font-size:13px;white-space:nowrap;">
    ⚡ <strong style="color:#e2e8f0;">Machine.Machine</strong> — Your personal AI agent
  </span>
  <a href="https://t.me/m2_onboarding_bot" target="_blank" rel="noopener" style="
    display:inline-flex;align-items:center;gap:8px;
    background:linear-gradient(135deg,#7c3aed,#4f46e5);
    color:#fff;text-decoration:none;
    padding:10px 22px;border-radius:50px;
    font-size:14px;font-weight:600;letter-spacing:0.3px;
    box-shadow:0 0 20px #7c3aed55;
    white-space:nowrap;flex-shrink:0;
    transition:opacity .2s;" onmouseover="this.style.opacity='.85'" onmouseout="this.style.opacity='1'">
    Get Your Agent →
  </a>
</div>
<style>#m2-cta-bar+*,body{padding-bottom:70px}</style>
</body>`;
    const fixedHtml = pitch.html
      .replace('</head>', cssfix)
      .replace('</body>', ctaBar);
    return c.html(fixedHtml);
  }

  // Placeholder page with auto-refresh
  const placeholder = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="30">
  <title>M² Pitch wird generiert…</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0F1729;
      color: #fff;
      font-family: 'Inter', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .container {
      text-align: center;
      max-width: 480px;
      padding: 2rem;
    }
    .logo {
      font-size: 3rem;
      font-weight: 700;
      background: linear-gradient(135deg, #7C3AED, #00D9FF);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 2rem;
    }
    .spinner {
      width: 48px;
      height: 48px;
      border: 4px solid rgba(124, 58, 237, 0.3);
      border-top-color: #7C3AED;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 2rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    p { color: rgba(255,255,255,0.7); line-height: 1.6; }
    .status {
      margin-top: 1.5rem;
      padding: 0.75rem 1.5rem;
      background: rgba(124, 58, 237, 0.15);
      border: 1px solid rgba(124, 58, 237, 0.3);
      border-radius: 8px;
      font-size: 0.875rem;
      color: #00D9FF;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">M²</div>
    <div class="spinner"></div>
    <h1>Dein persönlicher Pitch wird generiert…</h1>
    <p>Komm in ~30 Minuten zurück.<br>Diese Seite aktualisiert sich automatisch.</p>
    <div class="status">Status: ${pitch.status === 'error' ? 'Fehler bei der Generierung' : 'Wird generiert…'}</div>
  </div>
</body>
</html>`;

  return c.html(placeholder);
});

// =============================================================================
// M2O — Client Onboarding Flow
// Routes: /v1/onboard/*
// State machine: email_pending → email_verified → token_validated →
//                name_chosen → provisioning → live
// =============================================================================

const ONBOARD_BOT_TOKEN      = process.env.ONBOARD_BOT_TOKEN      || '';
const ONBOARD_WEBHOOK_SECRET = process.env.ONBOARD_WEBHOOK_SECRET  || '';
const ONBOARD_FILE           = process.env.ONBOARD_FILE            || '/data/onboarding.json';
// Approval notifications go here — set to the Machine.Machine group chat ID
// Falls back to TG_NOTIFY_CHAT (master's personal chat) if not set
const ONBOARD_NOTIFY_CHAT    = process.env.ONBOARD_NOTIFY_CHAT     || TG_NOTIFY_CHAT;
const TWENTY_CRM_URL         = process.env.TWENTY_CRM_URL          || 'https://crm.machinemachine.ai';
const POSTHOG_API_KEY        = process.env.POSTHOG_API_KEY         || '';
const POSTHOG_HOST           = process.env.POSTHOG_HOST            || 'https://posthog.machinemachine.ai';

// ── PostHog — fire-and-forget server-side capture (no SDK, just REST) ─────────
function track(
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
): void {
  if (!POSTHOG_API_KEY) return;
  fetch(`${POSTHOG_HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: POSTHOG_API_KEY,
      distinct_id: distinctId || 'anonymous',
      event,
      properties: { ...properties, $lib: 'machinemachine-api' },
      timestamp: new Date().toISOString(),
    }),
  }).catch(() => {});
}

// ── Onboarding session store ──────────────────────────────────────────────────

function loadSessions(): Map<string, OnboardSession> {
  try {
    const raw = fs.readFileSync(ONBOARD_FILE, 'utf8');
    return new Map(JSON.parse(raw));
  } catch { return new Map(); }
}

function saveSessions(): void {
  try {
    fs.mkdirSync(path.dirname(ONBOARD_FILE), { recursive: true });
    fs.writeFileSync(ONBOARD_FILE, JSON.stringify([...onboardSessions.entries()]));
  } catch (e) { console.error('saveSessions failed:', e); }
}

const onboardSessions = loadSessions();

// ── Qualification scoring ─────────────────────────────────────────────────────

const FREE_EMAIL_PROVIDERS = new Set([
  'gmail.com','yahoo.com','hotmail.com','outlook.com','live.com',
  'protonmail.com','icloud.com','me.com','aol.com','mail.com',
]);
const QUALIFY_THRESHOLD = 70;

function scoreSession(session: OnboardSession): { score: number; reasons: string[] } {
  let score = 50;
  const reasons: string[] = [];

  // Company email domain
  const domain = (session.email || '').split('@')[1]?.toLowerCase() || '';
  if (domain && !FREE_EMAIL_PROVIDERS.has(domain)) {
    score += 30; reasons.push(`company email (${domain}) +30`);
  }

  // Specific use case
  const useCase = session.qualifyAnswers?.useCase || 'generalist';
  if (useCase !== 'generalist') {
    score += 20; reasons.push(`specific use case (${useCase}) +20`);
  }

  // Team size
  const teamSize = session.qualifyAnswers?.teamSize || 'solo';
  if (teamSize === 'company')   { score += 40; reasons.push('company size +40'); }
  else if (teamSize === 'team') { score += 20; reasons.push('team size +20'); }

  // Referral
  if (session.referralCode) { score += 25; reasons.push(`referral +25`); }

  return { score, reasons };
}

// ── Spawn queue (heartbeat picks this up and runs spawn-machine.sh) ───────────

const SPAWN_QUEUE_FILE = process.env.SPAWN_QUEUE_FILE || '/data/spawn-queue.json';

function writeSpawnQueue(entry: {
  name: string; token: string; session_id: string; notify_url: string;
}): void {
  try {
    fs.mkdirSync(path.dirname(SPAWN_QUEUE_FILE), { recursive: true });
    let queue: any = { pending: [] };
    try { queue = JSON.parse(fs.readFileSync(SPAWN_QUEUE_FILE, 'utf8')); } catch {}
    queue.pending = queue.pending || [];
    queue.pending.push({ ...entry, attempts: 0, requestedAt: Date.now() });
    fs.writeFileSync(SPAWN_QUEUE_FILE, JSON.stringify(queue, null, 2));
    console.log(`[spawn-queue] queued: ${entry.name}`);
  } catch (e) { console.error('[spawn-queue] write failed:', e); }
}

// ── Bot helpers ───────────────────────────────────────────────────────────────

async function sendBotMessage(chatId: string, payload: Record<string, unknown>): Promise<void> {
  if (!ONBOARD_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${ONBOARD_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, ...payload }),
  }).catch(() => {});
}

// In-memory rate limit: email → { count, window_start }
const emailRateLimit = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(email: string): boolean {
  const now = Date.now();
  const window = 60 * 60 * 1000; // 1 hour
  const entry = emailRateLimit.get(email);
  if (!entry || now - entry.windowStart > window) {
    emailRateLimit.set(email, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= 3) return false;
  entry.count++;
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendOtpEmail(email: string, otp: string): Promise<void> {
  if (!BREVO_API_KEY) return;
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: BREVO_SENDER_NAME, email: BREVO_SENDER_EMAIL },
      to: [{ email }],
      subject: 'Your Machine.Machine verification code',
      htmlContent: `<div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:40px;background:#0F1729;color:#fff;border-radius:12px">
        <div style="font-size:1.5rem;font-weight:700;background:linear-gradient(135deg,#3b82f6,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:24px">M²</div>
        <h2 style="margin:0 0 16px">Your verification code</h2>
        <div style="font-size:2.5rem;font-weight:700;letter-spacing:0.3em;color:#00D9FF;margin:24px 0;text-align:center">${otp}</div>
        <p style="color:rgba(255,255,255,0.6);font-size:0.875rem">This code expires in 10 minutes. If you didn't request this, ignore it.</p>
      </div>`,
    }),
  });
}

async function updateTwentyCrm(session: OnboardSession, note: string): Promise<void> {
  if (!TWENTY_API_URL || !TWENTY_API_KEY) return;
  try {
    // Get or create contact
    let contactId = session.twentyCrmContactId;
    if (!contactId) {
      const firstName = session.email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const res = await fetch(`${TWENTY_API_URL}/graphql`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TWENTY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `mutation { createPerson(data: { name: { firstName: "${firstName}", lastName: "" } emails: { primaryEmail: "${session.email}" } }) { id } }` }),
      });
      const data = await res.json() as any;
      contactId = data?.data?.createPerson?.id;
      if (contactId) { session.twentyCrmContactId = contactId; saveSessions(); }
    }
    if (!contactId) return;
    // Add state note
    await fetch(`${TWENTY_API_URL}/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TWENTY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `mutation { createNote(data: { body: "${note}" noteTargets: { createMany: { data: [{ personId: "${contactId}" }] } } }) { id } }` }),
    });
  } catch { /* best effort */ }
}

async function notifyMasterApproval(session: OnboardSession): Promise<void> {
  if (!ONBOARD_BOT_TOKEN) return;
  const crmLink = session.twentyCrmContactId
    ? `\n🔗 <a href="${TWENTY_CRM_URL}/object/people/${session.twentyCrmContactId}">View in CRM</a>`
    : '';
  const text = `🚀 <b>New agent onboarding request!</b>\n\n📧 ${session.email}\n🤖 @${session.botUsername}\n⚡ Agent: <b>${session.agentName}</b>${crmLink}\n\nApprove to spawn?`;
  try {
    const res = await fetch(`https://api.telegram.org/bot${ONBOARD_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ONBOARD_NOTIFY_CHAT,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve_${session.id}` },
            { text: '❌ Reject',  callback_data: `reject_${session.id}` },
          ]],
        },
      }),
    });
    const data = await res.json() as any;
    // store message_id for later editing
    if (data?.result?.message_id) {
      (session as any)._approvalMsgId = data.result.message_id;
      saveSessions();
    }
  } catch { /* best effort */ }
}

async function editApprovalMessage(msgId: number, text: string): Promise<void> {
  if (!ONBOARD_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${ONBOARD_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ONBOARD_NOTIFY_CHAT, message_id: msgId, text, parse_mode: 'HTML' }),
    });
  } catch { /* best effort */ }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /v1/onboard/start
app.post('/v1/onboard/start', async (c) => {
  const { email, telegram_user_id, existing_session_id } = await c.req.json<{
    email: string; telegram_user_id?: string; existing_session_id?: string;
  }>();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Valid email required' }, 400);
  }
  if (!checkRateLimit(email)) {
    return c.json({ error: 'Too many attempts. Try again in an hour.' }, 429);
  }

  // If user came from bot qualification — attach email to their existing session
  if (existing_session_id) {
    const qualified = onboardSessions.get(existing_session_id);
    if (qualified && ['qualifying','qualified','contact_track'].includes(qualified.state)) {
      qualified.email = email;
      qualified.emailOtp = generateOtp();
      qualified.emailOtpExpiry = Date.now() + 10 * 60 * 1000;
      qualified.emailOtpAttempts = 0;
      qualified.telegramUserId = telegram_user_id || qualified.telegramUserId;
      // Move qualifying → email_pending (needs OTP before proceeding)
      if (qualified.state === 'qualifying') qualified.state = 'email_pending';
      qualified.updatedAt = new Date().toISOString();
      saveSessions();
      await sendOtpEmail(email, qualified.emailOtp).catch(() => {});
      await updateTwentyCrm(qualified, `[M2O] Email attached: ${email}`).catch(() => {});
      return c.json({ session_id: qualified.id });
    }
  }

  // Reject if active session exists (not rejected/live)
  const existing = [...onboardSessions.values()].find(
    s => s.email === email && !['rejected', 'live'].includes(s.state)
  );
  if (existing) {
    return c.json({ session_id: existing.id, message: 'Session already active. Check your email.' });
  }
  const otp = generateOtp();
  const session: OnboardSession = {
    id: crypto.randomUUID(),
    email,
    telegramUserId: telegram_user_id,
    emailOtp: otp,
    emailOtpExpiry: Date.now() + 10 * 60 * 1000,
    emailOtpAttempts: 0,
    state: 'email_pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  onboardSessions.set(session.id, session);
  saveSessions();
  await sendOtpEmail(email, otp).catch(() => {});
  await updateTwentyCrm(session, `[M2O] Onboarding started — state: email_pending`).catch(() => {});
  return c.json({ session_id: session.id, message: 'Check your email for a 6-digit verification code.' });
});

// POST /v1/onboard/verify-email
app.post('/v1/onboard/verify-email', async (c) => {
  const { session_id, otp } = await c.req.json<{ session_id: string; otp: string }>();
  const session = onboardSessions.get(session_id);
  if (!session || session.state !== 'email_pending') return c.json({ error: 'Invalid session' }, 400);
  if (session.emailOtpAttempts >= 3) return c.json({ error: 'Too many attempts. Start over.' }, 429);
  session.emailOtpAttempts++;
  if (!session.emailOtp || otp !== session.emailOtp || Date.now() > (session.emailOtpExpiry ?? 0)) {
    saveSessions();
    return c.json({ error: 'Invalid or expired code.' }, 400);
  }
  session.state = 'email_verified';
  session.emailOtp = undefined;
  session.updatedAt = new Date().toISOString();
  saveSessions();
  await updateTwentyCrm(session, `[M2O] State: email_verified`).catch(() => {});
  track(session.telegramUserId || session.email, 'email_verified', {
    session_id, had_bot_qualification: !!session.qualifyScore,
    qualify_score: session.qualifyScore,
  });
  return c.json({ success: true, next_step: 'bot_token' });
});

// POST /v1/onboard/validate-token
app.post('/v1/onboard/validate-token', async (c) => {
  const { session_id, bot_token } = await c.req.json<{ session_id: string; bot_token: string }>();
  const session = onboardSessions.get(session_id);
  if (!session || session.state !== 'email_verified') return c.json({ error: 'Invalid session' }, 400);
  try {
    const res = await fetch(`https://api.telegram.org/bot${bot_token}/getMe`);
    const data = await res.json() as any;
    if (!data.ok) return c.json({ error: 'Invalid bot token. Check you copied it correctly.' }, 400);
    session.botToken   = bot_token;
    session.botUsername = data.result.username;
    session.state      = 'token_validated';
    session.updatedAt  = new Date().toISOString();
    saveSessions();
    await updateTwentyCrm(session, `[M2O] State: token_validated — bot @${session.botUsername}`).catch(() => {});
    track(session.telegramUserId || session.email, 'token_validated', {
      session_id, bot_username: session.botUsername, preset: session.preset,
    });
    return c.json({ success: true, bot_username: session.botUsername, next_step: 'choose_name' });
  } catch {
    return c.json({ error: 'Could not validate token. Try again.' }, 500);
  }
});

// POST /v1/onboard/set-name — auto-provisions without manual approval
app.post('/v1/onboard/set-name', async (c) => {
  const { session_id, agent_name, preset } = await c.req.json<{
    session_id: string; agent_name: string; preset?: string;
  }>();
  const session = onboardSessions.get(session_id);
  if (!session || session.state !== 'token_validated') return c.json({ error: 'Invalid session' }, 400);
  const RESERVED = ['admin', 'root', 'system', 'master', 'm2', 'api', 'bot', 'test'];
  if (!/^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/.test(agent_name) || RESERVED.includes(agent_name)) {
    return c.json({ error: 'Name must be 3-20 lowercase letters/numbers/hyphens, no reserved words.' }, 400);
  }
  // Store preset if provided from Mini App (overrides bot qualification preset)
  if (preset && ['researcher','builder','creator','generalist'].includes(preset)) {
    session.preset = preset as any;
  }
  // Re-score now that we have email
  const { score, reasons } = scoreSession(session);
  session.qualifyScore = score;
  session.agentName    = agent_name;
  session.state        = 'provisioning';
  session.updatedAt    = new Date().toISOString();
  saveSessions();

  await updateTwentyCrm(session,
    `[M2O] Provisioning: ${agent_name} | preset: ${session.preset || 'generalist'} | score: ${score} (${reasons.join(', ')})`
  ).catch(() => {});

  // Write to spawn queue — m2 heartbeat picks this up and runs spawn-machine.sh
  const notifyUrl = `https://api.machinemachine.ai/v1/onboard/notify-live`;
  writeSpawnQueue({ name: agent_name, token: session.botToken!, session_id, notify_url: notifyUrl });
  track(session.telegramUserId || session.email, 'spawn_queued', {
    session_id, agent_name, preset: session.preset || 'generalist',
    qualify_score: session.qualifyScore, email_domain: session.email.split('@')[1],
  });

  // Non-blocking observability log to MM group
  notifyTelegram(
    `⚙️ <b>Spawn queued: ${agent_name}</b>\nEmail: ${session.email}\nPreset: ${session.preset || 'generalist'}\nScore: ${score}\nBot: @${session.botUsername}`
  );

  return c.json({ success: true, provisioning: true, message: 'Your agent is being set up. You\'ll get a message on Telegram when it\'s live.' });
});

// GET /v1/onboard/status/:id
app.get('/v1/onboard/status/:id', (c) => {
  const session = onboardSessions.get(c.req.param('id'));
  if (!session) return c.json({ error: 'Not found' }, 404);
  return c.json({
    state:         session.state,
    bot_username:  session.botUsername,
    agent_name:    session.agentName,
    preset:        session.preset,
    qualify_score: session.qualifyScore,
    updated_at:    session.updatedAt,
  });
});

// POST /v1/onboard/webhook  — Telegram bot webhook (qualification + legacy approve/reject)
app.post('/v1/onboard/webhook', async (c) => {
  if (ONBOARD_WEBHOOK_SECRET) {
    const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
    if (secret !== ONBOARD_WEBHOOK_SECRET) return c.json({ ok: false }, 403);
  }
  const update = await c.req.json<any>();

  // ── /start message — begin qualification conversation ──────────────────────
  if (update.message) {
    const msg  = update.message;
    const text = (msg.text || '').trim();
    const chatId = msg.chat.id.toString();

    if (text.startsWith('/start')) {
      const tgUser   = msg.from;
      const refCode  = text.split(' ')[1] || undefined;

      // One active session per Telegram user — reuse if already qualifying/qualified
      const existing = [...onboardSessions.values()].find(
        s => s.telegramUserId === chatId && !['live','rejected'].includes(s.state)
      );
      if (existing && existing.state === 'qualified') {
        const miniAppUrl = `https://machinemachine.ai/onboard?sid=${existing.id}`;
        await sendBotMessage(chatId, {
          text: `You're already approved ⚡\n\nSet up your agent here:`,
          reply_markup: { inline_keyboard: [[
            { text: '⚡ Set up my agent →', web_app: { url: miniAppUrl } }
          ]]},
        });
        return c.json({ ok: true });
      }
      if (existing && existing.state === 'contact_track') {
        await sendBotMessage(chatId, { text: `You're on the early access list — we'll reach out when your spot opens.` });
        return c.json({ ok: true });
      }

      // Create new qualifying session
      const sessionId = crypto.randomUUID();
      const session: OnboardSession = {
        id: sessionId, telegramUserId: chatId, email: '',
        emailOtpAttempts: 0, state: 'qualifying',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        referralCode: refCode,
      };
      onboardSessions.set(sessionId, session);
      saveSessions();
      track(chatId, 'bot_start', { ref_code: refCode, tg_username: tgUser.username });

      await sendBotMessage(chatId, {
        text: `Hey ${tgUser.first_name} 👋\n\nQuick question before we set you up.\n\n*What should your agent specialize in?*`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [
            { text: '🔬 Research & Analysis', callback_data: `qu_${sessionId}_usecase_researcher` },
            { text: '🛠 Building & Code',     callback_data: `qu_${sessionId}_usecase_builder`    },
          ],
          [
            { text: '✍️ Writing & Content',   callback_data: `qu_${sessionId}_usecase_creator`    },
            { text: '🧠 General Intelligence', callback_data: `qu_${sessionId}_usecase_generalist` },
          ],
        ]},
      });
      return c.json({ ok: true });
    }
  }

  // ── callback_query — qualification + legacy approve/reject ─────────────────
  if (update.callback_query) {
    const { id: cbId, data, message, from } = update.callback_query;
    const chatId = (message?.chat?.id || from?.id)?.toString() || '';

    const answerCb = (text: string) =>
      fetch(`https://api.telegram.org/bot${ONBOARD_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cbId, text }),
      }).catch(() => {});

    // ── Step 1: use case answer → ask team size ──────────────────────────────
    if (data?.startsWith('qu_') && data.includes('_usecase_')) {
      // format: qu_{sessionId}_usecase_{value}
      const parts   = data.split('_usecase_');
      const sessionId = parts[0].replace('qu_', '');
      const useCase   = parts[1]; // researcher | builder | creator | generalist
      const session   = onboardSessions.get(sessionId);
      if (!session) { await answerCb('Session expired — send /start to begin again'); return c.json({ ok: true }); }

      session.qualifyAnswers = { useCase, teamSize: '' };
      session.preset = useCase as any;
      session.updatedAt = new Date().toISOString();
      saveSessions();
      await answerCb('Got it!');
      track(session.telegramUserId || sessionId, 'qualify_usecase_selected', { use_case: useCase, session_id: sessionId });

      await sendBotMessage(chatId, {
        text: `Perfect. Who's this for?`,
        reply_markup: { inline_keyboard: [[
          { text: 'Just me',    callback_data: `qu_${sessionId}_team_solo`    },
          { text: 'My team',   callback_data: `qu_${sessionId}_team_team`    },
          { text: 'My company',callback_data: `qu_${sessionId}_team_company` },
        ]]},
      });
      return c.json({ ok: true });
    }

    // ── Step 2: team size answer → score + branch ────────────────────────────
    if (data?.startsWith('qu_') && data.includes('_team_')) {
      // format: qu_{sessionId}_team_{value}
      const parts    = data.split('_team_');
      const sessionId = parts[0].replace('qu_', '');
      const teamSize  = parts[1]; // solo | team | company
      const session   = onboardSessions.get(sessionId);
      if (!session) { await answerCb('Session expired — send /start to begin again'); return c.json({ ok: true }); }

      session.qualifyAnswers = { ...(session.qualifyAnswers || { useCase: 'generalist' }), teamSize };
      session.updatedAt = new Date().toISOString();

      // Score (email domain can't be checked yet — scored again in set-name)
      const { score, reasons } = scoreSession(session);
      session.qualifyScore = score;
      await answerCb('✅');
      track(session.telegramUserId || sessionId, 'qualify_result', {
        score, qualified: score >= QUALIFY_THRESHOLD,
        use_case: session.qualifyAnswers?.useCase, team_size: teamSize,
        session_id: sessionId,
      });

      if (score >= QUALIFY_THRESHOLD) {
        session.state = 'qualified';
        saveSessions();
        await updateTwentyCrm(session,
          `[M2O] Qualified (score: ${score}) — ${reasons.join(', ')}`
        ).catch(() => {});

        const miniAppUrl = `https://machinemachine.ai/onboard?sid=${session.id}`;
        await sendBotMessage(chatId, {
          text: `You're in ⚡\n\nSet up your agent — takes about 5 minutes.`,
          reply_markup: { inline_keyboard: [[
            { text: '⚡ Set up my agent →', web_app: { url: miniAppUrl } }
          ]]},
        });
      } else {
        session.state = 'contact_track';
        saveSessions();
        await updateTwentyCrm(session,
          `[M2O] Contact track (score: ${score}) — ${reasons.join(', ')}`
        ).catch(() => {});

        await sendBotMessage(chatId, {
          text: `You're on the early access list for Machine.Machine.\n\nWe're rolling out deliberately — each agent is set up with care, not mass-deployed.\n\nWe'll reach out directly when your spot opens.\n\n→ machinemachine.ai`,
        });
      }
      return c.json({ ok: true });
    }

    // ── Legacy: manual approve/reject (kept for backward compat, now rarely used) ──
    if (data?.startsWith('approve_') || data?.startsWith('reject_')) {
      const [action, sessionId] = [data.split('_')[0], data.slice(data.indexOf('_') + 1)];
      const session = onboardSessions.get(sessionId);
      if (!session) { await answerCb('Session not found'); return c.json({ ok: true }); }

      if (action === 'approve') {
        session.state = 'provisioning';
        session.updatedAt = new Date().toISOString();
        saveSessions();
        await answerCb(`✅ Spawning ${session.agentName}...`);
        if (message?.message_id) await editApprovalMessage(message.message_id, `✅ <b>Approved</b> — spawning <b>${session.agentName}</b>...`);
        await updateTwentyCrm(session, `[M2O] State: provisioning — approved by master`).catch(() => {});
        writeSpawnQueue({ name: session.agentName!, token: session.botToken!, session_id: session.id, notify_url: 'https://api.machinemachine.ai/v1/onboard/notify-live' });
      } else {
        session.state = 'rejected';
        session.updatedAt = new Date().toISOString();
        saveSessions();
        await answerCb('❌ Rejected');
        if (message?.message_id) await editApprovalMessage(message.message_id, `❌ <b>Rejected</b> — ${session.agentName}`);
        await updateTwentyCrm(session, `[M2O] State: rejected`).catch(() => {});
        if (session.botToken && session.telegramUserId) {
          fetch(`https://api.telegram.org/bot${session.botToken}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: session.telegramUserId, text: "We couldn't approve your request at this time. Contact us at hello@machinemachine.ai if you think this is a mistake." }),
          }).catch(() => {});
        }
      }
    }
    return c.json({ ok: true });
  }

  return c.json({ ok: true });
});

// POST /v1/spawn — internal, called after approval
app.post('/v1/spawn', async (c) => {
  const { name, token, session_id } = await c.req.json<{ name: string; token: string; session_id?: string }>();
  if (!name || !token) return c.json({ error: 'name and token required' }, 400);
  notifyTelegram(`⚙️ <b>Spawning agent: ${name}</b>\nBot token: set\nQueue: will call spawn-machine.sh`);
  // TODO: exec spawn-machine.sh <name> <token> when API has shell access
  // For now: logged + master notified
  if (session_id) {
    const session = onboardSessions.get(session_id);
    if (session) {
      session.state = 'provisioning';
      session.updatedAt = new Date().toISOString();
      saveSessions();
    }
  }
  return c.json({ success: true, message: `Spawn queued for ${name}` });
});

// POST /v1/onboard/notify-live — called when agent is confirmed live
app.post('/v1/onboard/notify-live', async (c) => {
  const { session_id } = await c.req.json<{ session_id: string }>();
  const session = onboardSessions.get(session_id);
  if (!session) return c.json({ error: 'Not found' }, 404);
  const provisioningStartMs = new Date(session.updatedAt).getTime();
  session.state = 'live';
  session.updatedAt = new Date().toISOString();
  saveSessions();
  await updateTwentyCrm(session, `[M2O] State: live 🚀`).catch(() => {});
  track(session.telegramUserId || session.email, 'agent_live', {
    session_id, agent_name: session.agentName,
    preset: session.preset || 'generalist',
    qualify_score: session.qualifyScore,
    time_to_live_ms: Date.now() - new Date(session.createdAt).getTime(),
  });
  // Personalized first message per preset
  const firstMessages: Record<string, string> = {
    researcher: `Hey 👋 I'm <b>${session.agentName}</b> — your research intelligence.\n\nI can search the web, synthesize anything, and remember what matters.\n\nWhat are you trying to understand?`,
    builder:    `Hey 👋 I'm <b>${session.agentName}</b>.\n\nI build with you: code, debug, review, deploy. I remember context across sessions.\n\nWhat are you working on?`,
    creator:    `Hey 👋 I'm <b>${session.agentName}</b> — your creative partner.\n\nI write, edit, position, and pitch. Tell me what you're making.`,
    generalist: `Hey 👋 I'm <b>${session.agentName}</b>.\n\nI adapt to whatever you need. Web access, memory, no patience for filler.\n\nWhat's first?`,
  };
  const firstMsg = firstMessages[session.preset || 'generalist'] || firstMessages.generalist;
  if (session.botToken && session.telegramUserId) {
    fetch(`https://api.telegram.org/bot${session.botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: session.telegramUserId, text: firstMsg, parse_mode: 'HTML' }),
    }).catch(() => {});
  }
  return c.json({ success: true });
});

// POST /v1/coolify/webhook — receive Coolify deploy notifications → Telegram alert
// Setup in Coolify: Team → Notifications → Add → Custom Webhook → https://api.machinemachine.ai/v1/coolify/webhook
app.post('/v1/coolify/webhook', async (c) => {
  const secret = c.req.header('x-webhook-secret') || '';
  const expectedSecret = process.env.COOLIFY_WEBHOOK_SECRET || '';
  if (expectedSecret && secret !== expectedSecret) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<any>().catch(() => ({}));

  // Coolify sends: { type, status, name, uuid, fqdn, ... }
  const type   = body?.type   || body?.data?.type   || 'deployment';
  const status = body?.status || body?.data?.status || '';
  const name   = body?.name   || body?.data?.name   || body?.application_name || 'unknown';
  const uuid   = body?.uuid   || body?.data?.uuid   || '';
  const fqdn   = body?.fqdn   || body?.data?.fqdn   || '';

  const statusEmoji: Record<string, string> = {
    success:  '✅', failed: '🔴', error: '🔴',
    running:  '🟡', queued: '⏳',
  };
  const emoji = statusEmoji[status] || '🔔';
  const urlLine = fqdn ? `\n🌐 <a href="${fqdn}">${fqdn}</a>` : '';

  const text = `${emoji} <b>Coolify deploy</b>\n\n📦 ${name}\n📊 Status: <b>${status || type}</b>${urlLine}`;

  // Send to MM group via onboarding bot
  if (ONBOARD_BOT_TOKEN && ONBOARD_NOTIFY_CHAT) {
    await fetch(`https://api.telegram.org/bot${ONBOARD_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: ONBOARD_NOTIFY_CHAT, text, parse_mode: 'HTML' }),
    }).catch(() => {});
  }

  return c.json({ ok: true });
});

// Start server
const port = parseInt(process.env.PORT || '3000');
console.log(`🚀 MachineMachine API starting on port ${port}`);

serve({ fetch: app.fetch, port });
