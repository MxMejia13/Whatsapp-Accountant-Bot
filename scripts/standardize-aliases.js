/**
 * Alias Standardization Script
 *
 * This script runs the User.standardizeAliases() method to convert
 * all existing user aliases to lowercase for consistent lookups.
 *
 * Run this ONCE after deploying the lowercase alias update.
 *
 * Usage:
 *   node scripts/standardize-aliases.js
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Import User Model
const User = require('../models/User');

// MongoDB URI
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function runStandardization() {
    if (!MONGO_URI) {
        console.error("❌ ERROR: MONGODB_URI is not set in environment variables.");
        return;
    }

    try {
        // Connect to MongoDB
        console.log("🔄 Connecting to MongoDB...");
        await mongoose.connect(MONGO_URI);
        console.log("✅ Connected to MongoDB.\n");

        // Run the standardization method
        console.log("🔧 Starting alias standardization...\n");
        const result = await User.standardizeAliases();

        if (result.success) {
            console.log("\n" + "=".repeat(60));
            console.log(`| ✅ STANDARDIZATION COMPLETE`);
            console.log("=".repeat(60));
            console.log(`  Total users updated: ${result.updatedCount}`);

            if (result.updatedCount === 0) {
                console.log(`  All aliases were already lowercase - no changes needed.`);
            } else {
                console.log(`  ${result.updatedCount} alias(es) converted to lowercase.`);
            }
        } else {
            console.error("\n❌ Standardization failed:", result.error);
        }

    } catch (error) {
        console.error("\n❌ STANDARDIZATION FAILED:", error.message);
        console.error("   Stack trace:", error.stack);
    } finally {
        // Disconnect
        await mongoose.disconnect();
        console.log("\n✅ Disconnected from MongoDB.");
    }
}

// Confirmation prompt
console.log("=".repeat(60));
console.log("| 🔧 ALIAS STANDARDIZATION UTILITY");
console.log("=".repeat(60));
console.log("\nThis script will convert all user aliases to lowercase.");
console.log("Examples:");
console.log('  "Max"     → "max"');
console.log('  "Vinicio" → "vinicio"');
console.log('  "JOHN"    → "john"');
console.log("\nThis is safe to run multiple times.\n");

// Run immediately (no prompt needed for scripts)
runStandardization();
