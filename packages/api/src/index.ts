import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors());

// In-memory storage for MVP
const agents: any[] = [];
const tasks: any[] = [];

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

// Start server
const port = parseInt(process.env.PORT || '3000');
console.log(`🚀 MachineMachine API starting on port ${port}`);

serve({ fetch: app.fetch, port });
