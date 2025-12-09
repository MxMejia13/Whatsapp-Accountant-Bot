/**
 * Standardize Aliases by Phone Number - Migration Script
 *
 * This script performs a one-time migration to:
 * 1. Set lowercase primary aliases for specific users
 * 2. Configure dual-alias display names for user +18093833443
 *
 * IMPORTANT: Run this ONCE after deploying the dual-alias update
 * Safe to run multiple times (idempotent)
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables from project root
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');

// MongoDB connection URI
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ Error: MONGODB_URI not found in environment variables');
  console.error('   Please ensure .env file exists and contains MONGODB_URI');
  process.exit(1);
}

/**
 * Phone Number to Alias Mapping
 * Maps phone numbers to their primary lowercase alias and optional displayNames
 */
const PHONE_TO_ALIAS_MAP = {
  '+18096510177': {
    primaryAlias: 'max',
    displayNames: null // No custom display names
  },
  '+18293803443': {
    primaryAlias: 'sebastian',
    displayNames: null
  },
  '+18098903565': {
    primaryAlias: 'vinicio',
    displayNames: null
  },
  '+18093833443': {
    primaryAlias: 'pally',
    displayNames: {
      preferred: 'Sr. Vinicio',
      secondary: 'Sr. Pally'
    }
  },
  '+18292995088': {
    primaryAlias: 'jose',
    displayNames: null
  }
};

/**
 * Main migration function
 */
async function standardizeAliasesByPhone() {
  try {
    console.log('🔧 Starting alias standardization by phone number...\n');
    console.log(`📞 Processing ${Object.keys(PHONE_TO_ALIAS_MAP).length} user(s)...\n`);

    // Connect to MongoDB
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    let updatedCount = 0;
    let notFoundCount = 0;
    let skippedCount = 0;

    // Process each phone number
    for (const [phoneNumber, config] of Object.entries(PHONE_TO_ALIAS_MAP)) {
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📱 Processing: ${phoneNumber}`);
      console.log(`   Target Alias: "${config.primaryAlias}"`);

      if (config.displayNames) {
        console.log(`   Display Names:`);
        console.log(`     - Preferred: "${config.displayNames.preferred}"`);
        console.log(`     - Secondary: "${config.displayNames.secondary}"`);
      }

      // Find user by phone number
      const user = await User.findOne({ phoneNumber: phoneNumber });

      if (!user) {
        console.log(`   ❌ User NOT FOUND in database`);
        console.log(`   ⚠️  Skipping... (user may need to be created first)\n`);
        notFoundCount++;
        continue;
      }

      console.log(`   ✅ User Found: ${user.alias || user.fullName || 'No alias'}`);
      console.log(`   Current Data:`);
      console.log(`     - Alias: "${user.alias || 'NULL'}"`);
      console.log(`     - Full Name: "${user.fullName || 'NULL'}"`);
      console.log(`     - Email: "${user.email || 'NULL'}"`);
      console.log(`     - ProfileData: ${JSON.stringify(user.profileData || {})}`);

      // Check if update is needed
      const aliasNeedsUpdate = user.alias !== config.primaryAlias;
      const displayNamesNeedUpdate = config.displayNames &&
        JSON.stringify(user.profileData?.displayNames) !== JSON.stringify(config.displayNames);

      if (!aliasNeedsUpdate && !displayNamesNeedUpdate) {
        console.log(`   ✅ Already up to date - skipping\n`);
        skippedCount++;
        continue;
      }

      // Perform updates
      if (aliasNeedsUpdate) {
        const oldAlias = user.alias;
        user.alias = config.primaryAlias;
        console.log(`   🔄 Updating alias: "${oldAlias}" → "${config.primaryAlias}"`);
      }

      if (displayNamesNeedUpdate) {
        // Initialize profileData if it doesn't exist
        if (!user.profileData) {
          user.profileData = {};
        }

        user.profileData.displayNames = config.displayNames;
        console.log(`   🔄 Setting displayNames in profileData`);
        console.log(`      Preferred: "${config.displayNames.preferred}"`);
        console.log(`      Secondary: "${config.displayNames.secondary}"`);
      }

      // Save user
      await user.save();
      console.log(`   ✅ User updated successfully\n`);
      updatedCount++;
    }

    // Final summary
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`\n✅ MIGRATION COMPLETE\n`);
    console.log(`📊 Summary:`);
    console.log(`   Total Users Processed: ${Object.keys(PHONE_TO_ALIAS_MAP).length}`);
    console.log(`   ✅ Updated: ${updatedCount}`);
    console.log(`   ⏭️  Skipped (already correct): ${skippedCount}`);
    console.log(`   ❌ Not Found: ${notFoundCount}`);

    if (notFoundCount > 0) {
      console.log(`\n⚠️  WARNING: ${notFoundCount} user(s) not found in database`);
      console.log(`   These users may need to be created first or their phone numbers may be incorrect`);
    }

    console.log(`\n💡 Next Steps:`);
    console.log(`   1. Run "node scripts/query-all-users.js" to verify changes`);
    console.log(`   2. Test the send_email tool with user aliases`);
    console.log(`   3. Verify display names appear correctly in Agent responses\n`);

    // Disconnect from MongoDB
    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB\n');

    return {
      success: true,
      updatedCount,
      skippedCount,
      notFoundCount
    };

  } catch (error) {
    console.error('\n❌ ERROR during migration:', error);
    console.error('   Error message:', error.message);
    console.error('   Stack trace:', error.stack);

    // Ensure we disconnect even on error
    try {
      await mongoose.disconnect();
    } catch (disconnectError) {
      // Ignore disconnect errors
    }

    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Run the migration
 */
if (require.main === module) {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║   ALIAS STANDARDIZATION BY PHONE - DUAL ALIAS MIGRATION   ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  standardizeAliasesByPhone()
    .then((result) => {
      if (result.success) {
        console.log('🎉 Migration completed successfully!');
        process.exit(0);
      } else {
        console.log('❌ Migration failed');
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error('❌ Unexpected error:', error);
      process.exit(1);
    });
}

module.exports = { standardizeAliasesByPhone, PHONE_TO_ALIAS_MAP };
