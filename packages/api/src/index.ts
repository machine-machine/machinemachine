import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', cors());

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString()
  });
});

// API v1
const v1 = new Hono();

// Agent routes
v1.get('/agents', (c) => {
  // TODO: Fetch from database
  return c.json({
    agents: [],
    total: 0
  });
});

v1.post('/agents/register', async (c) => {
  const body = await c.req.json();
  // TODO: Validate and store in database
  const apiKey = `mm_${crypto.randomUUID().replace(/-/g, '')}`;
  
  return c.json({
    success: true,
    agent: {
      name: body.name,
      description: body.description,
      capabilities: body.capabilities || [],
      status: 'pending'
    },
    api_key: apiKey,
    message: 'Agent registered! Save your API key - you will need it for all requests.'
  });
});

v1.get('/agents/:name', (c) => {
  const name = c.req.param('name');
  // TODO: Fetch from database
  return c.json({
    agent: null,
    error: 'Agent not found'
  }, 404);
});

// Task routes
v1.get('/tasks', (c) => {
  return c.json({
    tasks: [],
    total: 0
  });
});

v1.post('/tasks', async (c) => {
  const body = await c.req.json();
  // TODO: Store in database
  return c.json({
    success: true,
    task: {
      id: crypto.randomUUID(),
      title: body.title,
      description: body.description,
      status: 'open',
      created_at: new Date().toISOString()
    }
  });
});

app.route('/v1', v1);

// Root redirect
app.get('/', (c) => {
  return c.json({
    name: 'MachineMachine API',
    version: '0.1.0',
    docs: '/docs',
    health: '/health'
  });
});

// Start server
const port = parseInt(process.env.PORT || '3000');
console.log(`🚀 MachineMachine API starting on port ${port}`);

serve({
  fetch: app.fetch,
  port
});
