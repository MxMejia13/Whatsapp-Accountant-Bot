/**
 * User Database Query Script
 *
 * This script connects to MongoDB and displays all users with their details.
 * Useful for debugging alias resolution, email configuration, and user data.
 *
 * Usage:
 *   node scripts/query-all-users.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from project root
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Import User Model
const User = require('../models/User');

// MongoDB URI from environment
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function queryAllUsers() {
    if (!MONGO_URI) {
        console.error("❌ ERROR: MONGODB_URI is not set in environment variables.");
        console.error("   Please ensure your .env file contains:");
        console.error("   MONGODB_URI=mongodb://localhost:27017/whatsapp-bot");
        return;
    }

    try {
        // Connect to MongoDB
        console.log("🔄 Connecting to MongoDB...");
        await mongoose.connect(MONGO_URI);
        console.log("✅ Connected to MongoDB.");

        // Query all user documents
        const users = await User.find({});

        if (users.length === 0) {
            console.log("\n👥 No users found in the database.");
            console.log("   Tip: Users are created automatically when they send a WhatsApp message.");
            return;
        }

        console.log(`\n======================================================`);
        console.log(`| 👥 TOTAL USERS FOUND: ${users.length}`);
        console.log(`======================================================`);

        // Iterate and display key data
        users.forEach((user, index) => {
            console.log(`\n--- USER ${index + 1} ---`);
            console.log(`  Display Name: ${user.getDisplayName()}`); // Uses the helper method
            console.log(`  Alias:        ${user.alias || 'N/A'}`);
            console.log(`  Full Name:    ${user.fullName || 'N/A'}`);
            console.log(`  Phone:        ${user.phoneNumber}`);
            console.log(`  Email:        ${user.email || 'N/A'}`);
            console.log(`  Admin Status: ${user.isAdmin ? 'YES' : 'NO'}`);
            console.log(`  Total Files:  ${user.totalFiles || 0}`);
            console.log(`  Total Msgs:   ${user.totalMessages || 0}`);
            console.log(`  Profile Data: ${JSON.stringify(user.profileData || {})}`);
            console.log(`  Created:      ${user.createdAt ? user.createdAt.toLocaleDateString() : 'N/A'}`);
            console.log(`  Last Active:  ${user.lastActive ? user.lastActive.toLocaleDateString() : 'N/A'}`);
        });

        // Summary statistics
        console.log(`\n======================================================`);
        console.log(`| 📊 SUMMARY STATISTICS`);
        console.log(`======================================================`);

        const usersWithEmail = users.filter(u => u.email && u.email.trim()).length;
        const usersWithAlias = users.filter(u => u.alias && u.alias.trim()).length;
        const adminUsers = users.filter(u => u.isAdmin).length;

        console.log(`  Users with Email:     ${usersWithEmail} / ${users.length}`);
        console.log(`  Users with Alias:     ${usersWithAlias} / ${users.length}`);
        console.log(`  Admin Users:          ${adminUsers} / ${users.length}`);
        console.log(`  Total Files Stored:   ${users.reduce((sum, u) => sum + (u.totalFiles || 0), 0)}`);
        console.log(`  Total Messages Sent:  ${users.reduce((sum, u) => sum + (u.totalMessages || 0), 0)}`);

        // Alias resolution check
        console.log(`\n======================================================`);
        console.log(`| 🔍 ALIAS RESOLUTION CHECK`);
        console.log(`======================================================`);

        const aliasUsers = users.filter(u => u.alias && u.alias.trim());
        if (aliasUsers.length > 0) {
            console.log(`\nUsers with aliases (for send_email resolution):`);
            aliasUsers.forEach(u => {
                const emailStatus = u.email && u.email.trim() ? '✅' : '❌';
                const lowercaseCheck = u.alias === u.alias.toLowerCase() ? '✅' : '⚠️';
                console.log(`  ${emailStatus} ${lowercaseCheck} "${u.alias}" → ${u.email || 'NO EMAIL SET'}`);
            });

            console.log(`\n  Legend:`);
            console.log(`  ✅ = Has email configured (ready for send_email)`);
            console.log(`  ❌ = Missing email (send_email will fail)`);
            console.log(`  ✅ = Lowercase alias (consistent lookups)`);
            console.log(`  ⚠️  = Mixed case alias (may need standardization)`);
        } else {
            console.log(`\n  No aliases configured yet.`);
            console.log(`  Tip: Set aliases for easier send_email usage.`);
        }

    } catch (error) {
        console.error("\n❌ DATABASE QUERY FAILED:", error.message);
        console.error("   Stack trace:", error.stack);
    } finally {
        // Disconnect after query
        await mongoose.disconnect();
        console.log("\n✅ Disconnected from MongoDB.");
    }
}

// Run the query
queryAllUsers();
