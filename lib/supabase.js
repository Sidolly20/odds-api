// lib/supabase.js — single shared connection to the database.
// Uses the SECRET key because this runs on the server, never in a browser.

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseSecretKey) {
  console.warn('Warning: SUPABASE_URL or SUPABASE_SECRET_KEY is missing from environment variables.');
}

const supabase = createClient(supabaseUrl, supabaseSecretKey);

module.exports = supabase;
