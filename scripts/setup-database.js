#!/usr/bin/env node
/**
 * Database Setup Script
 * Run this once to initialize your database
 *
 * Usage: node scripts/setup-database.js
 */

require('dotenv').config();
const { initializeDatabase, pool } = require('../database/db');

async function setup() {
  console.log('🔧 Setting up database...\n');

  try {
    // Check if DATABASE_URL is configured
    if (!process.env.DATABASE_URL) {
      console.error('❌ ERROR: DATABASE_URL environment variable not found');
      console.log('\n📝 To fix this:');
      console.log('1. Go to Railway dashboard');
      console.log('2. Create a PostgreSQL database');
      console.log('3. Add DATABASE_URL to your bot service variables\n');
      process.exit(1);
    }

    console.log('✅ DATABASE_URL found');
    console.log(`📍 Connecting to: ${process.env.DATABASE_URL.split('@')[1]?.split('/')[0] || 'database'}\n`);

    // Initialize database (create tables)
    await initializeDatabase();

    console.log('\n✅ Database setup complete!');
    console.log('\n📊 Tables created:');
    console.log('  - users');
    console.log('  - messages');
    console.log('  - media_files');
    console.log('  - conversations');
    console.log('  - usage_logs\n');

    console.log('🎉 Your database is ready to use!\n');

  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run setup
setup();
