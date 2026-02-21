import { pgTable, uuid, varchar, text, jsonb, boolean, integer, decimal, timestamp } from 'drizzle-orm/pg-core';

// Agents table
export const agents = pgTable('agents', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 100 }).unique().notNull(),
  description: text('description'),
  capabilities: jsonb('capabilities').default([]),
  pricing: jsonb('pricing').default({}),
  metadata: jsonb('metadata').default({}),
  apiKey: varchar('api_key', { length: 64 }).unique().notNull(),
  ownerEmail: varchar('owner_email', { length: 255 }),
  ownerVerified: boolean('owner_verified').default(false),
  status: varchar('status', { length: 20 }).default('pending'),
  karma: integer('karma').default(0),
  tokenBalance: decimal('token_balance', { precision: 18, scale: 8 }).default('0'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Tasks table
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: varchar('title', { length: 200 }).notNull(),
  description: text('description').notNull(),
  requirements: jsonb('requirements').default({}),
  status: varchar('status', { length: 20 }).default('open'),
  budget: decimal('budget', { precision: 10, scale: 2 }),
  tokenBounty: decimal('token_bounty', { precision: 18, scale: 8 }),
  assignedAgentId: uuid('assigned_agent_id').references(() => agents.id),
  submittedBy: varchar('submitted_by', { length: 255 }),
  result: jsonb('result'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
  completedAt: timestamp('completed_at'),
});

// Task history for audit trail
export const taskHistory = pgTable('task_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskId: uuid('task_id').references(() => tasks.id),
  status: varchar('status', { length: 20 }).notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at').defaultNow(),
});

// Types
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

// M2O Onboarding (in-memory + JSON file, not a DB table)
export type OnboardState = 'email_pending' | 'email_verified' | 'token_validated' | 'name_chosen' | 'provisioning' | 'live' | 'rejected';

export interface OnboardSession {
  id: string;               // crypto.randomUUID()
  telegramUserId?: string;  // set when initiated from bot
  email: string;
  emailOtp?: string;        // 6-digit code
  emailOtpExpiry?: number;  // Date.now() + 10min
  emailOtpAttempts: number; // max 3
  botToken?: string;
  botUsername?: string;      // from Telegram getMe
  agentName?: string;
  state: OnboardState;
  twentyCrmContactId?: string;
  createdAt: string;
  updatedAt: string;
  pendingApprovalSince?: number; // when m2 approval was requested
}
