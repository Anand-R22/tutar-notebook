// ============================================
// TutAR NotebookLM POC — Backend Server
// Run: npm start
// Open: http://localhost:3000
// ============================================

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const { createClient } = require("@supabase/supabase-js");
const { Pinecone } = require("@pinecone-database/pinecone");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ── Validate environment variables ──
const required = [
  "GEMINI_API_KEY",
  "PINECONE_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_KEY",
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`❌ Missing env vars: ${missing.join(", ")}`);
  console.error("See .env.example for the required format.");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const app = express();

// ── Setup external services ──
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.index(process.env.PINECONE_INDEX || "tutar-textbooks");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Middleware ──
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// File upload setup
const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed"));
  },
});

// ── Embedding model (loaded once) ──
let extractor = null;
async function getExtractor() {
  if (!extractor) {
    console.log("Loading embedding model...");
    const { pipeline } = await import("@xenova/transformers");
    extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.log("✅ Embedding model loaded");
  }
  return extractor;
}

async function embed(text) {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

// ── Helper — authenticate user from request ──
async function authenticate(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const userClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

// ── Text chunking ──
function chunkText(text, chunkSize = 500, overlap = 50) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    const end = Math.min(i + chunkSize, words.length);
    chunks.push(words.slice(i, end).join(" "));
    if (end === words.length) break;
    i = end - overlap;
  }
  return chunks;
}

// ══════════════════════════════════════════════
// ROUTES
// ══════════════════════════════════════════════

// GET / — serve home page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// POST /api/upload — upload PDF + process it
app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  try {
    const user = await authenticate(req);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { title, className, subject } = req.body;
    if (!title || !className || !subject) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Title, class and subject are required" });
    }

    // Create book record in Supabase
    const { data: bookData, error: bookError } = await supabaseAdmin
      .from("books")
      .insert({
        user_id: user.id,
        title,
        class_name: className,
        subject,
        status: "processing",
        total_chunks: 0,
      })
      .select()
      .single();

    if (bookError) {
      console.error("Supabase insert error:", bookError);
      fs.unlinkSync(req.file.path);
      return res.status(500).json({ error: "Failed to create book record: " + bookError.message });
    }

    const bookId = bookData.id;
    console.log(`📚 Book created: ${title} (id: ${bookId})`);

    // Respond immediately — process in background
    res.json({
      message: "Upload received. Processing in background.",
      book: bookData,
    });

    // ── Background processing ──
    (async () => {
      try {
        // 1. Extract text from PDF
        console.log(`[${bookId}] Extracting PDF text...`);
        const pdfBuffer = fs.readFileSync(req.file.path);
        const pdfData = await pdfParse(pdfBuffer);
        const text = pdfData.text;
        console.log(`[${bookId}] Extracted ${text.length} characters`);

        // 2. Chunk the text
        const chunks = chunkText(text, 500, 50);
        console.log(`[${bookId}] Created ${chunks.length} chunks`);

        // 3. Embed and upload to Pinecone
        const vectors = [];
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const embedding = await embed(chunk);
          vectors.push({
            id: `${bookId}-chunk-${i}`,
            values: embedding,
            metadata: {
              book_id: bookId,
              user_id: user.id,
              chunk_index: i,
              chunk_text: chunk.slice(0, 1000), // limit metadata size
              class_name: className,
              subject,
              title,
            },
          });

          // Upload in batches of 100
          if (vectors.length >= 100) {
            await pineconeIndex.upsert(vectors.splice(0, 100));
            console.log(`[${bookId}] Uploaded ${i + 1}/${chunks.length}`);
          }
        }
        if (vectors.length > 0) await pineconeIndex.upsert(vectors);

        // 4. Update book status to ready
        await supabaseAdmin
          .from("books")
          .update({ status: "ready", total_chunks: chunks.length })
          .eq("id", bookId);

        console.log(`✅ [${bookId}] Done!`);

        // 5. Generate topic suggestions in background using Gemini
        try {
          console.log(`[${bookId}] Generating topic suggestions...`);

          // Sample chunks from across the entire book (not just first 5)
          // This gives a better overview of all topics
          const sampleChunks = [];
          const step = Math.max(1, Math.floor(chunks.length / 8));
          for (let i = 0; i < chunks.length && sampleChunks.length < 8; i += step) {
            sampleChunks.push(chunks[i]);
          }
          const sampleText = sampleChunks.join("\n\n---\n\n").slice(0, 8000);

          const topicModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
          const topicPrompt = `Analyze the following textbook content and extract 8-10 main academic topics that a teacher could create lesson plans about.

Return ONLY a valid JSON array of short topic names (2-4 words each). No explanation, no markdown, just the JSON array.

Textbook content:
${sampleText}

Example output format:
["Photosynthesis", "Cell Division", "Respiration", "Enzymes"]

Your response (JSON array only):`;

          const topicResult = await topicModel.generateContent(topicPrompt);
          let topicText = topicResult.response.text().trim();

          // Clean up common Gemini response patterns
          topicText = topicText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

          console.log(`[${bookId}] Topic AI response:`, topicText.slice(0, 200));

          // Try to parse JSON from response
          const jsonMatch = topicText.match(/\[[\s\S]*?\]/);
          if (jsonMatch) {
            try {
              const topics = JSON.parse(jsonMatch[0]);
              if (Array.isArray(topics) && topics.length > 0) {
                const cleanTopics = topics
                  .filter((t) => typeof t === "string" && t.length > 0 && t.length < 100)
                  .slice(0, 10);

                await supabaseAdmin
                  .from("books")
                  .update({ suggested_topics: cleanTopics })
                  .eq("id", bookId);
                console.log(`✅ [${bookId}] Saved ${cleanTopics.length} topic suggestions:`, cleanTopics);
              } else {
                console.warn(`[${bookId}] Empty or invalid topics array`);
              }
            } catch (parseErr) {
              console.warn(`[${bookId}] JSON parse error:`, parseErr.message);
            }
          } else {
            console.warn(`[${bookId}] No JSON array found in response`);
          }
        } catch (topicErr) {
          console.warn(`[${bookId}] Topic suggestions failed:`, topicErr.message);
        }

        // Cleanup uploaded file
        fs.unlinkSync(req.file.path);

      } catch (err) {
        console.error(`❌ [${bookId}] Processing failed:`, err);
        await supabaseAdmin
          .from("books")
          .update({ status: "error" })
          .eq("id", bookId);
        try { fs.unlinkSync(req.file.path); } catch {}
      }
    })();

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/books — list user's books
app.get("/api/books", async (req, res) => {
  try {
    const user = await authenticate(req);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    const { data, error } = await supabaseAdmin
      .from("books")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ books: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/books/:id — delete a book
app.delete("/api/books/:id", async (req, res) => {
  try {
    const user = await authenticate(req);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    const bookId = req.params.id;

    // Verify ownership
    const { data: book, error: getError } = await supabaseAdmin
      .from("books")
      .select("*")
      .eq("id", bookId)
      .eq("user_id", user.id)
      .single();

    if (getError || !book) return res.status(404).json({ error: "Book not found" });

    // Delete from Pinecone (delete all vectors with this book_id)
    try {
      await pineconeIndex.deleteMany({ filter: { book_id: { $eq: bookId } } });
    } catch (e) {
      console.warn("Pinecone deletion warning:", e.message);
    }

    // Delete from Supabase
    await supabaseAdmin.from("books").delete().eq("id", bookId);

    res.json({ message: "Book deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/books/:id/regenerate-topics — regenerate topic suggestions for a book
app.post("/api/books/:id/regenerate-topics", async (req, res) => {
  try {
    const user = await authenticate(req);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    const bookId = req.params.id;

    // Verify ownership
    const { data: book, error: bookError } = await supabaseAdmin
      .from("books")
      .select("*")
      .eq("id", bookId)
      .eq("user_id", user.id)
      .single();

    if (bookError || !book) return res.status(404).json({ error: "Book not found" });
    if (book.status !== "ready") {
      return res.status(400).json({ error: "Book is not ready yet" });
    }

    console.log(`🔄 Regenerating topics for "${book.title}"`);

    // Fetch sample chunks from Pinecone
    // Use a generic query to get a variety of chunks
    const genericVector = await embed("main topics important concepts");
    const sampleResult = await pineconeIndex.query({
      vector: genericVector,
      topK: 12,
      filter: { book_id: { $eq: bookId } },
      includeMetadata: true,
    });

    if (!sampleResult.matches || sampleResult.matches.length === 0) {
      return res.status(500).json({ error: "No content found for this book" });
    }

    const sampleText = sampleResult.matches
      .map((m) => m.metadata.chunk_text)
      .join("\n\n---\n\n")
      .slice(0, 8000);

    const topicModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
    const topicPrompt = `Analyze the following textbook content and extract 8-10 main academic topics that a teacher could create lesson plans about.

Return ONLY a valid JSON array of short topic names (2-4 words each). No explanation, no markdown, just the JSON array.

Textbook content:
${sampleText}

Example output format:
["Photosynthesis", "Cell Division", "Respiration", "Enzymes"]

Your response (JSON array only):`;

    const topicResult = await topicModel.generateContent(topicPrompt);
    let topicText = topicResult.response.text().trim();
    topicText = topicText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

    const jsonMatch = topicText.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      return res.status(500).json({ error: "Failed to parse topic response", raw: topicText });
    }

    const topics = JSON.parse(jsonMatch[0]);
    const cleanTopics = topics
      .filter((t) => typeof t === "string" && t.length > 0 && t.length < 100)
      .slice(0, 10);

    await supabaseAdmin
      .from("books")
      .update({ suggested_topics: cleanTopics })
      .eq("id", bookId);

    console.log(`✅ Regenerated ${cleanTopics.length} topics`);
    res.json({ topics: cleanTopics });

  } catch (err) {
    console.error("Regenerate topics error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generate — generate lesson plan
app.post("/api/generate", async (req, res) => {
  try {
    const user = await authenticate(req);
    if (!user) return res.status(401).json({ error: "Not authenticated" });

    const { bookId, topic } = req.body;
    if (!bookId || !topic) {
      return res.status(400).json({ error: "Book ID and topic required" });
    }

    // Verify book belongs to user and is ready
    const { data: book, error: bookError } = await supabaseAdmin
      .from("books")
      .select("*")
      .eq("id", bookId)
      .eq("user_id", user.id)
      .single();

    if (bookError || !book) return res.status(404).json({ error: "Book not found" });
    if (book.status !== "ready") {
      return res.status(400).json({ error: `Book is not ready yet (status: ${book.status})` });
    }

    console.log(`🔍 Generating lesson plan: "${topic}" from "${book.title}"`);

    // 1. Embed the topic
    const queryVector = await embed(topic);

    // 2. Search Pinecone for relevant chunks (only from this book)
    const searchResult = await pineconeIndex.query({
      vector: queryVector,
      topK: 12,
      filter: { book_id: { $eq: bookId } },
      includeMetadata: true,
    });

    if (!searchResult.matches || searchResult.matches.length === 0) {
      return res.json({
        lessonPlan: "No relevant content found in this textbook for the given topic. Try a different topic or check the book content.",
        sources: [],
      });
    }

    // 3. Assemble context from chunks
    const contextChunks = searchResult.matches.map((m, i) => ({
      chunk: m.metadata.chunk_text,
      score: m.score,
      index: m.metadata.chunk_index,
    }));

    const context = contextChunks
      .map((c, i) => `[Excerpt ${i + 1}]\n${c.chunk}`)
      .join("\n\n");

    // 4. Generate lesson plan with Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    const prompt = `You are an expert educational assistant creating a concise, practical lesson plan for a teacher.

The teacher wants to teach the topic: "${topic}"
Class/Grade: ${book.class_name}
Subject: ${book.subject}
Textbook: ${book.title}

Based ONLY on the following excerpts from the textbook, generate a SHORT and PRACTICAL lesson plan.
Do NOT use general knowledge — use only the information present in these excerpts.

TEXTBOOK EXCERPTS:
${context}

Generate a CONCISE lesson plan with EXACTLY these section headings (use ## markdown):

## Lesson Objective
One clear sentence — what students will learn.

## Key Concepts
3-5 bullet points. Format each as: **Concept Name** — short definition. Formula if any.

## Lesson Flow

### Introduction (5 min)
- One hook question
- Brief topic introduction

### Main Teaching (20 min)
- 3-5 concise teaching points
- Include key formulas/reactions where mentioned in excerpts
- Reference excerpts briefly: "(Excerpt 1)"

### Activity (10 min)
- One practical activity (diagram/problem/discussion)

### Conclusion (5 min)
- Quick recap of 2-3 main points

## Key Formulas
Only if present in excerpts. List them clearly with proper notation.
If none, write "None present in the excerpts."

## Practice Questions
3 brief mixed conceptual/numerical questions.

## Discussion Questions
2 brief questions to gauge understanding.

---

RULES:
- Use EXACTLY the section headings shown above (## for sections, ### for sub-sections)
- Use bullet points heavily, not paragraphs
- Use proper notation: H₂O, CO₂, E = mc², A → B
- Language suitable for ${book.class_name}
- Keep each section SHORT
- DO NOT pad with unnecessary text`;

    const result = await model.generateContent(prompt);
    const lessonPlan = result.response.text();

    console.log(`✅ Lesson plan generated (${lessonPlan.length} chars)`);

    res.json({
      lessonPlan,
      sources: contextChunks.map((c, i) => ({
        excerptNumber: i + 1,
        relevance: Math.round(c.score * 100),
        preview: c.chunk.slice(0, 200) + "...",
      })),
      stats: {
        chunksUsed: contextChunks.length,
        topic,
        book: book.title,
      },
    });

  } catch (err) {
    console.error("Generate error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/config — frontend gets Supabase public config
app.get("/api/config", (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// Start server
app.listen(PORT, async () => {
  console.log(`\n🚀 TutAR NotebookLM POC`);
  console.log(`   Open: http://localhost:${PORT}\n`);

  // Pre-load embedding model
  await getExtractor();
});
