import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
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
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
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

CRITICAL CSS rules (must include verbatim):
.slide { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
.slide h1, .slide h2, .slide h3 { text-align:center; }
.slide p { text-align:center; margin-left:auto; margin-right:auto; max-width:720px; }
.slide .label { text-align:center; display:block; }

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
    return c.html(pitch.html);
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

// Start server
const port = parseInt(process.env.PORT || '3000');
console.log(`🚀 MachineMachine API starting on port ${port}`);

serve({ fetch: app.fetch, port });
