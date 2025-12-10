#!/usr/bin/env node

/**
 * Check User Data Script
 * Displays the actual data for a specific user in MongoDB
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function checkUserData() {
  try {
    console.log('\n📡 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Check the user with phone +18096510177
    const phone = '+18096510177';
    console.log(`🔍 Looking for user: ${phone}\n`);

    const user = await User.findOne({ phoneNumber: phone });

    if (user) {
      console.log('✅ User found!');
      console.log('\n📋 User Data:');
      console.log('─'.repeat(60));
      console.log(`Phone Number:  ${user.phoneNumber}`);
      console.log(`Alias:         ${user.alias || 'NULL'}`);
      console.log(`Full Name:     ${user.fullName || 'NULL'}`);
      console.log(`Email:         ${user.email || 'NULL'}`);
      console.log(`Title (legacy): ${user.title || 'NULL'}`);
      console.log(`Name (legacy):  ${user.name || 'NULL'}`);
      console.log(`Created At:    ${user.createdAt}`);
      console.log(`Last Active:   ${user.lastActive}`);
      console.log('─'.repeat(60));

      // Check all users
      console.log('\n\n👥 All Users in Database:');
      console.log('═'.repeat(60));
      const allUsers = await User.find({});
      allUsers.forEach((u, idx) => {
        console.log(`\n[${idx + 1}] ${u.alias || 'No Alias'}`);
        console.log(`    Phone: ${u.phoneNumber}`);
        console.log(`    Full Name: ${u.fullName || 'NULL'}`);
        console.log(`    Email: ${u.email || 'NULL'}`);
      });
      console.log('\n' + '═'.repeat(60));
    } else {
      console.log('❌ User NOT found in database!');
      console.log('\nThis means the seed script has not been run yet.');
      console.log('Run: npm run seed');
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    throw error;
  } finally {
    await mongoose.connection.close();
    console.log('\n📡 MongoDB connection closed\n');
  }
}

checkUserData()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
