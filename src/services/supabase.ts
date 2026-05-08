import { createClient, SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }

  _client = createClient(url, key, {
    auth: { persistSession: false },
    realtime: {
      transport: WebSocket as any,
    },
  });

  return _client;
}
