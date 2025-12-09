#!/usr/bin/env node
/**
 * Add User Titles Script
 * Adds or updates user titles for personalized greetings
 *
 * Usage: node scripts/add-user-titles.js
 */

require('dotenv').config();
const { updateUserTitle, getUserByPhone, pool } = require('../database/db');

// User titles configuration
const USER_TITLES = [
  {
    phoneNumber: 'whatsapp:+18296510177',
    title: 'Sr. Max',
    name: 'Max Mejia'
  },
  {
    phoneNumber: 'whatsapp:+18292995088',
    title: 'Sr. Jose',
    name: 'Jose Ismael Medina'
  }
];

async function addUserTitles() {
  console.log('👥 Adding user titles...\n');

  try {
    // Check if DATABASE_URL is configured
    if (!process.env.DATABASE_URL) {
      console.error('❌ ERROR: DATABASE_URL environment variable not found');
      console.log('\n📝 Run setup-database.js first\n');
      process.exit(1);
    }

    console.log('✅ DATABASE_URL found\n');

    // Add each user
    for (const user of USER_TITLES) {
      console.log(`📝 Processing ${user.name}...`);
      console.log(`   Phone: ${user.phoneNumber}`);
      console.log(`   Title: ${user.title}`);

      const updatedUser = await updateUserTitle(
        user.phoneNumber,
        user.title,
        user.name
      );

      console.log(`   ✅ User updated successfully!`);
      console.log(`   ID: ${updatedUser.id}\n`);
    }

    console.log('🎉 All user titles added successfully!\n');

    // Show summary
    console.log('📊 Summary:');
    for (const user of USER_TITLES) {
      const dbUser = await getUserByPhone(user.phoneNumber);
      if (dbUser) {
        console.log(`   ${dbUser.title || 'No title'} - ${dbUser.name || 'No name'} (${dbUser.phone_number})`);
      }
    }
    console.log('');

  } catch (error) {
    console.error('\n❌ Failed to add user titles:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run script
addUserTitles();
