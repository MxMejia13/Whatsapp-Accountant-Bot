# AI Agent Architecture Refactor

## Date: December 9, 2025

## Overview
Major architectural refactor transitioning from **Rule-Based Intent Detection** to **AI Agent Architecture** using OpenAI Function Calling (Tools).

---

## What Changed

### ❌ REMOVED (Old Approach)
1. **Manual Intent Detection**
   - Regex pattern matching (`if (msg.includes("save"))`)
   - Keyword-based routing
   - GPT-4o-mini for intent detection
   - Rigid switch/case logic

2. **Hard-coded Routing**
   - Manual file save triggers
   - Manual search triggers
   - Fixed command patterns

### ✅ ADDED (New Approach)
1. **AI Agent Service** (`services/AgentService.js`)
   - GPT-4o as the "brain"
   - Function calling loop
   - Context-aware decision making
   - Automatic tool execution

2. **Tool Definitions** (`config/tools.js`)
   - `save_file`: Save media with metadata
   - `search_files`: Semantic file retrieval
   - `get_my_stats`: Usage statistics
   - `list_recent_files`: List recent files
   - `ask_clarification`: Request clarification when ambiguous

3. **Streamlined Webhook** (`index.js`)
   - Focused on infrastructure (download, transcribe, vision)
   - Delegates all decision-making to AI Agent
   - Cleaner, more maintainable code (560 lines vs 1645 lines)

---

## Architecture Flow

```
User Message
    ↓
[Infrastructure Layer]
- Download media
- Transcribe audio (Whisper)
- Analyze images (GPT-4o Vision)
- Save to disk
    ↓
[AI Agent Service]
- Analyze user intent with context
- Decide which tools to call (if any)
- Execute tools
- Generate natural language response
    ↓
[Response]
- Send message to user
- Save to conversation history
```

---

## Key Benefits

### 1. **Smarter Intent Understanding**
- Understands context, not just keywords
- Handles ambiguous requests ("save that", "find it")
- Uses conversation history

**Example:**
```
User: [sends image] "guarda esto"
Old: Checks if message contains "guarda" → saves
New: GPT-4o analyzes: user sent image + said "guarda" → calls save_file tool
```

### 2. **Asks for Clarification**
- Won't guess when uncertain
- Uses `ask_clarification` tool

**Example:**
```
User: "Delete that document"
Old: Might search for "document" and delete first result
New: Calls ask_clarification → "¿Qué documento quieres eliminar?"
```

### 3. **Context-Aware**
- Remembers conversation history
- Resolves pronouns ("it", "that")

**Example:**
```
User: [sends cedula image]
Assistant: "This is your ID card..."
User: "Save it"
Old: Doesn't know what "it" is
New: GPT-4o knows "it" = the cedula image just sent
```

### 4. **Easier to Extend**
- Add new tools by updating `config/tools.js`
- No need to modify routing logic
- GPT-4o automatically learns to use new tools

---

## File Structure

```
project/
├── index.js                    # Main app (NEW: 560 lines, streamlined)
├── index.js.old                # Backup of old version (1645 lines)
├── services/
│   └── AgentService.js         # NEW: AI Agent with tool calling
├── config/
│   └── tools.js                # NEW: OpenAI function definitions
├── database/
│   ├── db.js                   # Database functions (unchanged)
│   └── init.sql                # Schema (unchanged)
├── utils/
│   ├── chartGenerator.js       # Chart generation (unchanged)
│   ├── imageGenerator.js       # DALL-E (not implemented)
│   └── scheduler.js            # Scheduling (unchanged)
└── media/                      # File storage (unchanged)
```

---

## Configuration

### Required Environment Variables
```bash
OPENAI_API_KEY=sk-...          # For GPT-4o
TWILIO_ACCOUNT_SID=AC...       # For WhatsApp
TWILIO_AUTH_TOKEN=...          # For WhatsApp
TWILIO_WHATSAPP_NUMBER=...     # Bot's number
DATABASE_URL=postgresql://...  # PostgreSQL database
PORT=3000                       # Server port
```

### Model Usage
- **GPT-4o**: Main conversation brain + function calling
- **GPT-4o Vision**: Image analysis
- **Whisper**: Audio transcription

**Cost Impact:**
- OLD: GPT-4o for vision + GPT-4o-mini for intent → 2 API calls
- NEW: GPT-4o for everything → 1-3 API calls (depending on tools)
- Expected: ~20-30% cost increase, but much smarter behavior

---

## System Prompt Philosophy

The new system prompt enforces:

1. **Understand Intent, Not Words**
   - Analyze what user MEANS
   - Use conversation history

2. **Ask When Unsure**
   - Don't guess
   - Use `ask_clarification` tool

3. **Be Proactive with Files**
   - Default: Save media when sent
   - Exception: User asking question about it

4. **Use Tools Confidently**
   - Call tools when sure
   - Don't call tools when just chatting

5. **Be Honest**
   - Never claim success without evidence
   - Admit when can't do something

---

## Testing Checklist

### Core Flows to Test:
- [ ] Send image with "guarda como cedula" → Should save with custom name
- [ ] Send image with "what does this say?" → Should analyze, NOT save
- [ ] Send audio → Should transcribe and save
- [ ] Say "enviame mi pasaporte" → Should search and send
- [ ] Say "save it" without context → Should ask clarification
- [ ] Say "cuantos archivos tengo?" → Should call get_my_stats
- [ ] Send voice message "hola como estas" → Should NOT save (conversational)

### Edge Cases:
- [ ] Ambiguous request ("that thing") → Should ask clarification
- [ ] Multiple file results → Should list options
- [ ] File not found → Should say so honestly
- [ ] Database down → Should fail gracefully

---

## Migration Notes

### For Users:
- **No behavior changes expected** for basic operations
- **Improved understanding** of complex/ambiguous requests
- **Better conversation flow** with clarification questions

### For Developers:
- Old `index.js` saved as `index.js.old`
- Can rollback by: `mv index.js index.js.agent && mv index.js.old index.js`
- All database schemas unchanged
- All file storage unchanged

---

## Future Enhancements

1. **Return Structured Data**
   - Have tools return file objects to send
   - Webhook can then send files directly

2. **More Tools**
   - `delete_file`: Delete saved files
   - `rename_file`: Rename files
   - `create_note`: Save text notes
   - `schedule_reminder`: Set reminders

3. **Tool Chaining**
   - Example: search_files → delete_file in one flow

4. **Better File Sending**
   - Agent returns files to send
   - Webhook handles the actual sending

---

## Troubleshooting

### Issue: "Function not found"
**Solution:** Check `config/tools.js` has the tool defined

### Issue: "Max iterations reached"
**Solution:** GPT is stuck in a tool loop. Check system prompt or tool descriptions.

### Issue: "Database error"
**Solution:** Ensure DATABASE_URL is set and database is initialized

### Issue: Bot doesn't call tools
**Solution:** Check system prompt gives clear guidance on when to use tools

---

## Summary

This refactor transforms the bot from a "dumb router" to an "intelligent agent" that:
- Understands context
- Makes smart decisions
- Asks questions when unsure
- Executes actions confidently

**Result:** More natural, human-like interactions with better error handling.
