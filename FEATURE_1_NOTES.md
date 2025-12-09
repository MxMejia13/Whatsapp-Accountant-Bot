# Feature #1: Intelligent Media Handling & Permanent Storage

## Implementation Summary

### What Was Built

#### 1. **Cloud Storage Service** (`services/CloudStorage.js`)
- AWS S3 / Cloudflare R2 integration
- Permanent file storage (survives Railway restarts)
- File upload/download/delete
- Signed URL generation for temporary access

**Required Environment Variables:**
```bash
CLOUD_STORAGE_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com  # For R2
CLOUD_STORAGE_ACCESS_KEY=xxx
CLOUD_STORAGE_SECRET_KEY=xxx
CLOUD_STORAGE_BUCKET=whatsapp-bot-media
CLOUD_STORAGE_REGION=auto  # or us-east-1 for S3
```

#### 2. **MongoDB Connection & Schema** (`database/mongodb.js`)
- Replaced PostgreSQL for media storage
- Full-text search indexing
- Three collections:
  - `MediaFile`: Permanent media with AI metadata
  - `User`: User management
  - `PendingConfirmation`: Temporary storage for low-confidence saves

**Required Environment Variable:**
```bash
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/whatsapp-bot
```

**MediaFile Schema:**
```javascript
{
  userId: String,           // Phone number
  s3Url: String,            // Permanent cloud URL
  s3Key: String,            // S3/R2 key
  filename: String,         // AI-generated filename
  description: String,      // AI description
  keywords: [String],       // Search keywords
  detectedText: String,     // OCR or transcript
  documentType: String,     // passport, receipt, id_card, etc.
  confidence: Number,       // 0-100%
  mimeType: String,
  isForwarded: Boolean,
  createdAt: Date
}
```

#### 3. **MediaProcessor Service** (`services/MediaProcessor.js`)
The "Smart Save" brain that runs BEFORE the main Agent.

**Audio Heuristic (Critical Feature):**
```
Audio Received
    ↓
Is it Forwarded?
    ↓
NO (Direct Voice Message)
    → Transcribe
    → Pass to Agent as CHAT
    → DO NOT SAVE

YES (Forwarded Audio)
    → Transcribe
    → Generate filename
    → SAVE to cloud + MongoDB
    → Confirm to user
```

**Vision Analysis (Images):**
```
Image Received
    ↓
GPT-4o Vision Analysis
    → Document type (passport, receipt, etc.)
    → Extract text (OCR)
    → Generate filename
    → Generate keywords
    → Confidence score (0-100%)
    ↓
Confidence >= 80%?
    ↓
YES: Auto-save
NO: Ask user for confirmation
```

**Smart Save Logic:**
- **High Confidence (≥80%):** Auto-save with AI-generated metadata
- **Low Confidence (<80%):** Ask user "¿Cómo quieres que lo guarde?"

---

## How It Works

### Example 1: Direct Voice Message (Chat)
```
User: [Records voice note] "Hey bot, what's my schedule?"
    ↓
MediaProcessor detects: NOT forwarded
    ↓
Action: CHAT
    ↓
Whisper transcribes: "Hey bot, what's my schedule?"
    ↓
Pass to Agent as normal chat message
    ↓
Agent responds with schedule
```

**Result:** Voice message is NOT saved as a file, treated as conversation.

### Example 2: Forwarded Audio (Save)
```
User: [Forwards audio recording]
    ↓
MediaProcessor detects: FORWARDED
    ↓
Action: SAVE
    ↓
Whisper transcribes: "Reunión con el equipo sobre el proyecto X..."
    ↓
AI generates filename: "reunion-equipo-proyecto-x"
    ↓
Upload to S3/R2
    ↓
Save metadata to MongoDB
    ↓
Confirm: "✅ Audio guardado como 'reunion-equipo-proyecto-x'"
```

**Result:** Audio permanently saved, searchable later.

### Example 3: High-Confidence Image (Auto-save)
```
User: [Sends image of cedula]
    ↓
MediaProcessor runs Vision Analysis
    ↓
GPT-4o detects:
  - Type: "id_card"
  - Filename: "cedula-max-mejia"
  - Text: "República Dominicana, Cédula No. 402-2873981-5..."
  - Confidence: 95%
    ↓
Confidence >= 80% → AUTO-SAVE
    ↓
Upload to cloud + save to MongoDB
    ↓
Confirm: "✅ Cédula guardada como 'cedula-max-mejia'"
```

**Result:** Instantly saved without asking user.

### Example 4: Low-Confidence Image (Ask)
```
User: [Sends blurry image]
    ↓
MediaProcessor runs Vision Analysis
    ↓
GPT-4o detects:
  - Type: "document"
  - Confidence: 45%
    ↓
Confidence < 80% → ASK USER
    ↓
Create PendingConfirmation (expires in 1 hour)
    ↓
Ask: "📷 Recibí una imagen. Parece ser un documento, pero no estoy seguro (45% confianza). ¿Cómo quieres que lo guarde?"
    ↓
User responds: "Guárdalo como contrato"
    ↓
Save with custom filename
```

**Result:** User provides context for ambiguous files.

---

## Semantic Search

With MongoDB text indexes, users can search using natural language:

**Example:**
```
User: "Envíame mi pasaporte"
    ↓
Search MongoDB text index for "pasaporte passport"
    ↓
Matches files with:
  - documentType: "passport"
  - keywords: ["pasaporte", "travel"]
  - detectedText: "...passport..."
    ↓
Return file to user
```

**Works even if filename is:** `image_001.jpg`
**Because metadata contains:** "passport", "travel document", etc.

---

## Next Steps Required

### To Complete Feature #1:

1. **Update `index.js`** to:
   - Connect to MongoDB on startup
   - Call `MediaProcessor.processMedia()` BEFORE Agent
   - Handle pending confirmations

2. **Add npm packages:**
   ```bash
   npm install mongoose aws-sdk
   ```

3. **Configure Environment Variables:**
   ```bash
   # MongoDB
   MONGODB_URI=xxx

   # Cloud Storage (S3 or R2)
   CLOUD_STORAGE_ENDPOINT=xxx  # Only for R2
   CLOUD_STORAGE_ACCESS_KEY=xxx
   CLOUD_STORAGE_SECRET_KEY=xxx
   CLOUD_STORAGE_BUCKET=whatsapp-bot-media
   CLOUD_STORAGE_REGION=auto
   ```

4. **Update AgentService** to use MongoDB search instead of PostgreSQL

5. **Test Scenarios:**
   - ✅ Direct voice message → treated as chat
   - ✅ Forwarded audio → saved permanently
   - ✅ High-confidence image (cedula) → auto-saved
   - ✅ Low-confidence image → asks user
   - ✅ Search: "mi pasaporte" → finds file

---

## Benefits

1. **No Data Loss:** Files stored in cloud (S3/R2), not local filesystem
2. **Smart Audio:** Distinguishes chat vs file storage
3. **Intelligent Naming:** AI generates descriptive filenames
4. **Semantic Search:** Find files by content, not just filename
5. **Confidence-Based UX:** Auto-save when sure, ask when unsure
6. **Full-Text OCR:** Extract and search text from images
7. **Permanent Storage:** Survives Railway restarts

---

## Architecture Flow

```
Incoming Message
    ↓
Has Media?
    ↓
YES → MediaProcessor.processMedia()
    ↓
Audio? → Check isForwarded
    ├─ NO → CHAT (transcribe, pass to Agent)
    └─ YES → SAVE (upload, store metadata)
    ↓
Image? → Vision Analysis
    ├─ Confidence >= 80% → AUTO-SAVE
    └─ Confidence < 80% → ASK USER
    ↓
Document? → ASK USER
    ↓
Return result to webhook
    ↓
Webhook sends confirmation or question
```

---

## Database Comparison

### Before (PostgreSQL):
- Limited full-text search
- No confidence tracking
- No keyword indexing
- Simple file metadata

### After (MongoDB):
- Advanced full-text search with weights
- Confidence scoring
- Keyword arrays with indexing
- Rich AI-generated metadata
- Text index on description + keywords + detectedText

---

## File Storage Comparison

### Before (Local Filesystem):
- Files in `media/` directory
- Lost on Railway restart
- No backup
- Limited by disk space

### After (Cloud Storage):
- Files in S3 / Cloudflare R2
- Permanent (never lost)
- Scalable (unlimited)
- Accessible via signed URLs

---

**Status:** Core services implemented. Integration into main webhook needed.
