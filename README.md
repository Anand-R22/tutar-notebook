# TutAR Notebook — POC

A NotebookLM-style system where teachers upload textbooks and AI generates lesson plans based on that specific textbook.

## Features (POC)

- ✅ User authentication (signup/login via Supabase)
- ✅ Upload PDF textbooks
- ✅ Background processing (PDF → text → chunks → vectors → Pinecone)
- ✅ AI-generated lesson plans using Google Gemini
- ✅ Lesson plans based ONLY on uploaded textbook (RAG)
- ✅ Source citations from the textbook
- ✅ Each teacher's books are private

## Setup

### Step 1 — Create `.env` file

Copy `.env.example` to `.env` and fill in your keys:

```
GEMINI_API_KEY=AIza_your_key_here
PINECONE_API_KEY=your_pinecone_key
PINECONE_INDEX=tutar-textbooks
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ_your_anon_key
SUPABASE_SERVICE_KEY=eyJ_your_service_role_key
```

**Where to find each:**
- Gemini: https://aistudio.google.com → Get API Key
- Pinecone: https://app.pinecone.io → API Keys
- Supabase URL + anon: https://supabase.com → Settings → API
- Supabase service_role: Same page as anon (KEEP SECRET!)

### Step 2 — Create the Supabase `books` table

Go to your Supabase project → SQL Editor → Run this:

```sql
CREATE TABLE books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  class_name TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  total_chunks INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE books ENABLE ROW LEVEL SECURITY;

-- Users can only see their own books
CREATE POLICY "Users can view own books" ON books
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own books" ON books
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own books" ON books
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own books" ON books
  FOR DELETE USING (auth.uid() = user_id);
```

### Step 3 — Disable email confirmation (for POC convenience)

In Supabase → Authentication → Providers → Email:
- Toggle "Confirm email" to OFF

This lets teachers sign up and login immediately without email verification.

### Step 4 — Install dependencies

```
npm install
```

### Step 5 — Start the server

```
npm start
```

Open: http://localhost:3000

## How to Use

1. Open http://localhost:3000
2. Sign up with email and password (or login)
3. Click "Upload Textbook"
4. Fill in title, class, subject and select a PDF
5. Click "Upload & Process"
6. Wait for processing (small books ~1-2 min, large books 5-10 min)
7. Click on the book in sidebar when status is "ready"
8. Type a topic and click "Generate"
9. Get an AI-generated lesson plan based on that textbook

## Architecture

```
Teacher uploads PDF
   ↓
PDF text extraction (pdf-parse)
   ↓
Split into 500-word chunks
   ↓
Embed each chunk (all-MiniLM-L6-v2 local)
   ↓
Store in Pinecone (tutar-textbooks index)
   ↓
Teacher searches topic
   ↓
Embed topic → query Pinecone (filter by book_id)
   ↓
Get top 8 relevant chunks
   ↓
Send chunks + prompt to Gemini
   ↓
Display lesson plan
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Node.js + Express |
| PDF Processing | pdf-parse |
| Embedding | @xenova/transformers (all-MiniLM-L6-v2) |
| Vector DB | Pinecone (HNSW) |
| AI Model | Google Gemini 1.5 Flash |
| Auth + DB + Storage | Supabase |
| Frontend | HTML + CSS + JavaScript |
