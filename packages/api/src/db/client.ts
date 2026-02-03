import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

let _db: PostgresJsDatabase<typeof schema> | null = null;
let _connectionError: string | null = null;

export function getDb(): PostgresJsDatabase<typeof schema> | null {
  if (_connectionError) {
    console.warn('Database unavailable:', _connectionError);
    return null;
  }
  
  if (!_db) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      _connectionError = 'DATABASE_URL not set';
      console.warn('Database unavailable:', _connectionError);
      return null;
    }
    try {
      const client = postgres(connectionString);
      _db = drizzle(client, { schema });
    } catch (err: any) {
      _connectionError = err.message;
      console.warn('Database connection failed:', _connectionError);
      return null;
    }
  }
  return _db;
}

export function isDbAvailable(): boolean {
  return getDb() !== null;
}

export { schema };
