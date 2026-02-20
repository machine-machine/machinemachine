import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import Anthropic from '@anthropic-ai/sdk';

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
  createdAt: string;
  url?: string;
  html?: string;
}
const pitches = new Map<string, PitchSubmission>();

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

async function generatePitch(uuid: string) {
  const pitch = pitches.get(uuid);
  if (!pitch) return;

  try {
    const anthropic = new Anthropic(); // uses ANTHROPIC_API_KEY env
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

Make it feel written specifically for them — use their industry terms, their use cases, their team context.
Keep the Machine.Machine brand but frame everything around THEIR world.
End with: "Bereit? → machinemachine.ai" CTA.

Output ONLY the complete HTML document starting with <!DOCTYPE html>`;

    const message = await anthropic.messages.create({
      model,
      max_tokens: 16000,
      system:
        'You are a pitch deck generator. Generate a complete, self-contained HTML pitch deck for this company/team, using the exact design system described. Output ONLY the complete HTML document, no explanation.',
      messages: [{ role: 'user', content: userPrompt }],
    });

    const htmlContent =
      message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('') || '';

    pitch.status = 'ready';
    pitch.html = htmlContent;
    pitch.url = `https://machinemachine.ai/pitch/${uuid}`;

    notifyTelegram(`✅ Pitch ready for ${pitch.email}: machinemachine.ai/pitch/${uuid}`);
  } catch (err) {
    pitch.status = 'error';
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
  if (!text) return c.json({ error: 'text is required' }, 400);

  const links = parseLinks(linksRaw);
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
    createdAt: new Date().toISOString(),
    url: `https://machinemachine.ai/pitch/${uuid}`,
  };

  pitches.set(uuid, pitch);

  // Fire-and-forget background generation
  generatePitch(uuid);

  const truncatedText = text.length > 100 ? text.slice(0, 100) + '...' : text;
  notifyTelegram(
    `🎯 New pitch request: ${email} | text: ${truncatedText} | links: ${links.join(', ')}`,
  );

  return c.json({
    uuid,
    url: `https://machinemachine.ai/pitch/${uuid}`,
    eta_minutes: 30,
    message:
      'Dein persönlicher Pitch wird generiert. Komm in ~30 Minuten zurück.',
  });
});

// GET /v1/pitch/:uuid/status
app.get('/v1/pitch/:uuid/status', (c) => {
  const uuid = c.req.param('uuid');
  const pitch = pitches.get(uuid);
  if (!pitch) return c.json({ error: 'Pitch not found' }, 404);

  return c.json({
    uuid: pitch.uuid,
    status: pitch.status,
    url: pitch.url,
    createdAt: pitch.createdAt,
    eta_minutes: 30,
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
