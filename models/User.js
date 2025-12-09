/**
 * User Model - Complete Schema Definition
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
    unique: true,
    index: true,
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
    trim: true,
    // Example: "Sr. Max", "Sr. Vinicio"
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

  // Authorization
  isAdmin: {
    type: Boolean,
    default: false,
    index: true
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
UserSchema.index({ phoneNumber: 1 });
UserSchema.index({ email: 1 }, { sparse: true });
UserSchema.index({ alias: 1 });
UserSchema.index({ isAdmin: 1 });
UserSchema.index({ createdAt: -1 });

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

UserSchema.statics.getAllAdmins = function() {
  return this.find({ isAdmin: true });
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

const User = mongoose.model('User', UserSchema);

module.exports = User;
