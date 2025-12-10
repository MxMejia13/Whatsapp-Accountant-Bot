/**
 * User Model - Complete Schema Definition with Data Cleaning
 *
 * Defines the User schema with full profile information
 * including phone, alias, full name, email, and admin status
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const UserSchema = new Schema({
  // Identity
  phoneNumber: {
    type: String,
    required: true,
    unique: true, // unique: true automatically creates an index
    trim: true,
    // E.164 format validation (optional but recommended)
    validate: {
      validator: function(v) {
        return /^\+\d{10,15}$/.test(v);
      },
      message: props => `${props.value} is not a valid E.164 phone number!`
    }
  },

  alias: {
    type: String,
    lowercase: true, // CRITICAL: Store aliases in lowercase for consistent lookups
    trim: true,
    index: true
  },

  fullName: {
    type: String,
    trim: true,
    index: true
  },

  email: {
    type: String,
    lowercase: true,
    trim: true,
    sparse: true, // Allows multiple null values
    index: true,
    // Email validation
    validate: {
      validator: function(v) {
        // Allow empty strings and null, but validate if provided
        if (!v || v === '') return true;
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
      },
      message: props => `${props.value} is not a valid email address!`
    }
  },

  // Legacy compatibility
  name: { type: String }, // For backward compatibility
  title: { type: String }, // For backward compatibility (alias)

  // Flexible profile data for future extensions
  profileData: {
    type: Object,
    default: {}
  },

  // User preferences
  preferences: {
    type: Object,
    default: {}
  },

  // Statistics
  totalFiles: {
    type: Number,
    default: 0
  },

  totalMessages: {
    type: Number,
    default: 0
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },

  lastActive: {
    type: Date,
    default: Date.now
  },

  // V2.0 Launch
  v2LaunchNotified: {
    type: Boolean,
    default: false
  },

  v2LaunchNotifiedAt: {
    type: Date
  }
});

// Indexes for performance
// Note: phoneNumber, email, alias, createdAt already have index: true in schema
// No need to define them again here to avoid "Duplicate index" warnings

// Instance methods
UserSchema.methods.updateLastActive = function() {
  this.lastActive = new Date();
  return this.save();
};

UserSchema.methods.incrementMessageCount = function() {
  this.totalMessages += 1;
  return this.save();
};

UserSchema.methods.incrementFileCount = function() {
  this.totalFiles += 1;
  return this.save();
};

UserSchema.methods.getDisplayName = function() {
  return this.alias || this.fullName || this.name || this.phoneNumber;
};

// Static methods
UserSchema.statics.findByPhone = function(phoneNumber) {
  return this.findOne({ phoneNumber });
};

UserSchema.statics.findByEmail = function(email) {
  if (!email) return null;
  return this.findOne({ email: email.toLowerCase() });
};

/**
 * DATA CLEANING: Standardize existing aliases to lowercase
 * Call this once during application startup to fix historical data
 */
UserSchema.statics.standardizeAliases = async function() {
  try {
    console.log('🔧 Running alias standardization...');

    // Find all users with non-empty aliases
    const users = await this.find({
      alias: { $exists: true, $ne: null, $ne: '' }
    });

    let updatedCount = 0;

    for (const user of users) {
      const originalAlias = user.alias;
      const lowercaseAlias = originalAlias.toLowerCase();

      // Only update if there's a case difference
      if (originalAlias !== lowercaseAlias) {
        user.alias = lowercaseAlias;
        await user.save();
        updatedCount++;
        console.log(`   ✓ Standardized: "${originalAlias}" → "${lowercaseAlias}"`);
      }
    }

    if (updatedCount > 0) {
      console.log(`✅ Alias standardization complete: ${updatedCount} users updated`);
    } else {
      console.log(`✅ Alias standardization complete: All aliases already standardized`);
    }

    return { success: true, updatedCount };
  } catch (error) {
    console.error('❌ Error standardizing aliases:', error);
    return { success: false, error: error.message };
  }
};

// Pre-save middleware
UserSchema.pre('save', function(next) {
  // Sync legacy fields
  if (this.isModified('alias')) {
    this.title = this.alias;
  }
  if (this.isModified('fullName')) {
    this.name = this.fullName;
  }
  next();
});

// Prevent OverwriteModelError by checking if model already exists
const User = mongoose.models.User || mongoose.model('User', UserSchema);

module.exports = User;
