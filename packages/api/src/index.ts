import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { getDb, schema } from './db/client';
import { eq } from 'drizzle-orm';

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
v1.get('/agents', async (c) => {
  try {
    const agents = await getDb().select({
      id: schema.agents.id,
      name: schema.agents.name,
      description: schema.agents.description,
      capabilities: schema.agents.capabilities,
      status: schema.agents.status,
      karma: schema.agents.karma,
      createdAt: schema.agents.createdAt,
    }).from(schema.agents);
    
    return c.json({
      agents,
      total: agents.length
    });
  } catch (error) {
    console.error('Error fetching agents:', error);
    return c.json({ agents: [], total: 0, error: 'Database error' });
  }
});

v1.post('/agents/register', async (c) => {
  try {
    const body = await c.req.json();
    const apiKey = `mm_${crypto.randomUUID().replace(/-/g, '')}`;
    
    const [agent] = await getDb().insert(schema.agents).values({
      name: body.name,
      description: body.description || '',
      capabilities: body.capabilities || [],
      pricing: body.pricing || {},
      apiKey,
      ownerEmail: body.email,
      status: 'pending',
    }).returning();
    
    return c.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        capabilities: agent.capabilities,
        status: agent.status,
      },
      api_key: apiKey,
      message: 'Agent registered! Save your API key - you will need it for all requests.'
    });
  } catch (error: any) {
    console.error('Error registering agent:', error);
    if (error.code === '23505') {
      return c.json({ success: false, error: 'Agent name already exists' }, 400);
    }
    return c.json({ success: false, error: 'Registration failed' }, 500);
  }
});

v1.get('/agents/:name', async (c) => {
  const name = c.req.param('name');
  try {
    const [agent] = await getDb().select({
      id: schema.agents.id,
      name: schema.agents.name,
      description: schema.agents.description,
      capabilities: schema.agents.capabilities,
      pricing: schema.agents.pricing,
      status: schema.agents.status,
      karma: schema.agents.karma,
      createdAt: schema.agents.createdAt,
    }).from(schema.agents).where(eq(schema.agents.name, name));
    
    if (!agent) {
      return c.json({ agent: null, error: 'Agent not found' }, 404);
    }
    return c.json({ agent });
  } catch (error) {
    console.error('Error fetching agent:', error);
    return c.json({ agent: null, error: 'Database error' }, 500);
  }
});

// Task routes
v1.get('/tasks', async (c) => {
  try {
    const status = c.req.query('status');
    const tasks = await getDb().select().from(schema.tasks);
    
    return c.json({
      tasks: status ? tasks.filter(t => t.status === status) : tasks,
      total: tasks.length
    });
  } catch (error) {
    console.error('Error fetching tasks:', error);
    return c.json({ tasks: [], total: 0, error: 'Database error' });
  }
});

v1.post('/tasks', async (c) => {
  try {
    const body = await c.req.json();
    
    const [task] = await getDb().insert(schema.tasks).values({
      title: body.title,
      description: body.description,
      requirements: body.requirements || {},
      budget: body.budget,
      tokenBounty: body.token_bounty,
      submittedBy: body.submitted_by,
      status: 'open',
    }).returning();
    
    return c.json({
      success: true,
      task
    });
  } catch (error) {
    console.error('Error creating task:', error);
    return c.json({ success: false, error: 'Failed to create task' }, 500);
  }
});

v1.post('/tasks/:id/claim', async (c) => {
  const id = c.req.param('id');
  const apiKey = c.req.header('X-API-Key');
  
  if (!apiKey) {
    return c.json({ error: 'API key required' }, 401);
  }
  
  try {
    // Find agent by API key
    const [agent] = await getDb().select().from(schema.agents).where(eq(schema.agents.apiKey, apiKey));
    if (!agent) {
      return c.json({ error: 'Invalid API key' }, 401);
    }
    
    // Claim task
    const [task] = await getDb().update(schema.tasks)
      .set({ 
        assignedAgentId: agent.id, 
        status: 'assigned',
        updatedAt: new Date()
      })
      .where(eq(schema.tasks.id, id))
      .returning();
    
    if (!task) {
      return c.json({ error: 'Task not found' }, 404);
    }
    
    return c.json({ success: true, task });
  } catch (error) {
    console.error('Error claiming task:', error);
    return c.json({ error: 'Failed to claim task' }, 500);
  }
});

v1.post('/tasks/:id/complete', async (c) => {
  const id = c.req.param('id');
  const apiKey = c.req.header('X-API-Key');
  
  if (!apiKey) {
    return c.json({ error: 'API key required' }, 401);
  }
  
  try {
    const body = await c.req.json();
    
    const [task] = await getDb().update(schema.tasks)
      .set({ 
        result: body.result,
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(schema.tasks.id, id))
      .returning();
    
    if (!task) {
      return c.json({ error: 'Task not found' }, 404);
    }
    
    return c.json({ success: true, task });
  } catch (error) {
    console.error('Error completing task:', error);
    return c.json({ error: 'Failed to complete task' }, 500);
  }
});

app.route('/v1', v1);

// Root
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
