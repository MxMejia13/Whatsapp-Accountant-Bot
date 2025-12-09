# User Database Utility Scripts

This directory contains utility scripts for managing and inspecting user data in the MongoDB database.

---

## 📋 Available Scripts

### 1. **query-all-users.js** - View All Users
Displays all users in the database with complete details.

### 2. **standardize-aliases.js** - Fix Alias Case Issues
Converts all existing aliases to lowercase for consistent lookups.

---

## 🚀 Quick Start

### Prerequisites
1. MongoDB must be running
2. `.env` file must contain `MONGODB_URI`
3. Node.js and dependencies installed (`npm install`)

### Check Your MongoDB Connection
```bash
# Verify MONGODB_URI is set
cat .env | grep MONGODB_URI

# Should show something like:
# MONGODB_URI=mongodb://localhost:27017/whatsapp-bot
```

---

## 📖 Usage Instructions

### Query All Users

**Purpose:** View all registered users, their aliases, emails, and check email resolution readiness.

**Command:**
```bash
node scripts/query-all-users.js
```

**Example Output:**
```
✅ Connected to MongoDB.

======================================================
| 👥 TOTAL USERS FOUND: 3
======================================================

--- USER 1 ---
  Display Name: max
  Alias:        max
  Full Name:    Max Mejia
  Phone:        +18091234567
  Email:        max@example.com
  Admin Status: YES
  Total Files:  15
  Total Msgs:   142
  Profile Data: {}
  Created:      12/1/2024
  Last Active:  12/9/2024

--- USER 2 ---
  Display Name: vinicio
  Alias:        vinicio
  Full Name:    Vinicio Rodriguez
  Phone:        +18098765432
  Email:        vinicio@example.com
  Admin Status: NO
  Total Files:  8
  Total Msgs:   56
  Profile Data: {}
  Created:      12/5/2024
  Last Active:  12/9/2024

======================================================
| 📊 SUMMARY STATISTICS
======================================================
  Users with Email:     2 / 3
  Users with Alias:     2 / 3
  Admin Users:          1 / 3
  Total Files Stored:   23
  Total Messages Sent:  198

======================================================
| 🔍 ALIAS RESOLUTION CHECK
======================================================

Users with aliases (for send_email resolution):
  ✅ ✅ "max" → max@example.com
  ✅ ✅ "vinicio" → vinicio@example.com

  Legend:
  ✅ = Has email configured (ready for send_email)
  ❌ = Missing email (send_email will fail)
  ✅ = Lowercase alias (consistent lookups)
  ⚠️  = Mixed case alias (may need standardization)

✅ Disconnected from MongoDB.
```

**When to Use:**
- ✅ Debug send_email alias resolution failures
- ✅ Check which users have email configured
- ✅ Verify alias standardization
- ✅ View database statistics
- ✅ Inspect user data for troubleshooting

---

### Standardize Aliases

**Purpose:** Convert all existing user aliases to lowercase for consistent send_email lookups.

**Command:**
```bash
node scripts/standardize-aliases.js
```

**Example Output:**
```
============================================================
| 🔧 ALIAS STANDARDIZATION UTILITY
============================================================

This script will convert all user aliases to lowercase.
Examples:
  "Max"     → "max"
  "Vinicio" → "vinicio"
  "JOHN"    → "john"

This is safe to run multiple times.

🔄 Connecting to MongoDB...
✅ Connected to MongoDB.

🔧 Starting alias standardization...

🔧 Running alias standardization...
   ✓ Standardized: "Max" → "max"
   ✓ Standardized: "Vinicio" → "vinicio"
✅ Alias standardization complete: 2 users updated

============================================================
| ✅ STANDARDIZATION COMPLETE
============================================================
  Total users updated: 2
  2 alias(es) converted to lowercase.

✅ Disconnected from MongoDB.
```

**When to Run:**
- ✅ **ONCE** after deploying the lowercase alias update
- ✅ After migrating old user data
- ✅ When alias lookups are failing due to case mismatch
- ✅ Safe to run multiple times (idempotent)

---

## 🔧 Troubleshooting

### Error: "MONGODB_URI is not set"

**Problem:** Environment variable not found.

**Solution:**
```bash
# Check .env file exists
ls -la .env

# Verify content
cat .env | grep MONGODB

# Should contain:
MONGODB_URI=mongodb://localhost:27017/whatsapp-bot
```

### Error: "MongooseError: Cannot connect"

**Problem:** MongoDB not running.

**Solution:**
```bash
# Start MongoDB (varies by installation)
sudo systemctl start mongod      # Linux with systemd
brew services start mongodb      # macOS with Homebrew
mongod --dbpath ~/data/db        # Manual start
```

### Error: "Cannot find module '../models/User'"

**Problem:** Script not run from correct directory.

**Solution:**
```bash
# Always run from project root
cd /home/user/Whatsapp-Accountant-Bot
node scripts/query-all-users.js
```

---

## 📊 Understanding the Output

### Alias Resolution Status

| Symbol | Meaning | Action Needed |
|--------|---------|---------------|
| ✅ ✅ | Alias lowercase + email set | ✅ Ready for send_email |
| ⚠️ ✅ | Mixed case + email set | Run standardize-aliases.js |
| ✅ ❌ | Lowercase + no email | User needs to set email |
| ⚠️ ❌ | Mixed case + no email | Standardize + set email |

### Example Scenarios

**Scenario 1: Perfect Setup**
```
✅ ✅ "max" → max@example.com
```
✅ send_email("max", ...) will work perfectly

**Scenario 2: Needs Standardization**
```
⚠️ ✅ "Max" → max@example.com
```
⚠️ send_email("max", ...) might fail
🔧 Run: `node scripts/standardize-aliases.js`

**Scenario 3: Missing Email**
```
✅ ❌ "john" → NO EMAIL SET
```
❌ send_email("john", ...) will fail
📝 User needs to configure email in system

---

## 🔄 Integration with Application

### Automatic Standardization at Startup

Add to `index.js` (main application file):

```javascript
const User = require('./models/User');

// After MongoDB connection
connectMongoDB().then(async () => {
  console.log('✅ MongoDB connected');

  // Run alias standardization on startup
  await User.standardizeAliases();

  // Start server
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
```

This ensures aliases are always standardized when the bot starts.

---

## 📝 Best Practices

1. **Run standardize-aliases.js ONCE** after deploying the lowercase update
2. **Run query-all-users.js regularly** to monitor user data health
3. **Check alias resolution** before troubleshooting send_email issues
4. **Verify email configuration** for users who need email functionality
5. **Monitor statistics** to track bot usage and growth

---

## 🆘 Need Help?

If you encounter issues:

1. ✅ Verify MongoDB is running
2. ✅ Check `.env` has correct `MONGODB_URI`
3. ✅ Ensure you're in project root directory
4. ✅ Run `npm install` to ensure dependencies are installed
5. ✅ Check logs for specific error messages

---

## 📚 Related Documentation

- **User Model:** `models/User.js` - Schema definition with lowercase alias
- **Agent Service:** `services/AgentService.js` - send_email implementation
- **Main Application:** `index.js` - Webhook and server logic

---

**Last Updated:** December 9, 2024
**Version:** V3.0 (Lowercase Alias Update)
