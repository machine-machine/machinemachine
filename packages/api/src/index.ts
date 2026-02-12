import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors());

// In-memory storage for MVP
const agents: any[] = [];
const tasks: any[] = [];
const waitlist: any[] = [];

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

// Start server
const port = parseInt(process.env.PORT || '3000');
console.log(`🚀 MachineMachine API starting on port ${port}`);

serve({ fetch: app.fetch, port });
