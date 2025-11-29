-- Database Schema for WhatsApp Bot
-- Run this to initialize your database

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100),
    title VARCHAR(50), -- Sr. Mejia, Sr. Max, etc.
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    phone_number VARCHAR(20) NOT NULL,
    message_sid VARCHAR(100) UNIQUE,
    content TEXT,
    direction VARCHAR(10) CHECK (direction IN ('incoming', 'outgoing')),
    message_type VARCHAR(20) DEFAULT 'text', -- text, image, audio, document
    is_forwarded BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Media files table (for images, audio, documents)
CREATE TABLE IF NOT EXISTS media_files (
    id SERIAL PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    file_type VARCHAR(50), -- image/jpeg, audio/ogg, application/pdf, etc.
    file_size INTEGER,
    file_name VARCHAR(255),
    file_description TEXT, -- AI-generated description of file content for semantic search
    storage_url TEXT, -- URL where file is stored (S3, R2, etc.)
    twilio_media_url TEXT, -- Original Twilio URL
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Conversation threads (optional, for grouping related messages)
CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200),
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0
);

-- Analytics/Logs (optional)
CREATE TABLE IF NOT EXISTS usage_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(50), -- message_sent, image_analyzed, table_generated, etc.
    details JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone_number);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_date ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_message ON media_files(message_id);
CREATE INDEX IF NOT EXISTS idx_media_type ON media_files(file_type);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_action ON usage_logs(action);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);

-- Function to update last_active timestamp
CREATE OR REPLACE FUNCTION update_user_last_active()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE users
    SET last_active = CURRENT_TIMESTAMP
    WHERE id = NEW.user_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update last_active
DROP TRIGGER IF EXISTS trigger_update_last_active ON messages;
CREATE TRIGGER trigger_update_last_active
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_user_last_active();
