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
const modelsIndex = pinecone.index(process.env.PINECONE_MODELS_INDEX || "tutar-models");
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── External API keys ──
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// ── AI Generation via Gemini ──
async function generateAI(prompt) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error("Gemini error:", err.message.substring(0, 200));
    throw err;
  }
}

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

          const topicPrompt = `Analyze the following textbook content and extract 8-10 main academic topics that a teacher could create lesson plans about.

Return ONLY a valid JSON array of short topic names (2-4 words each). No explanation, no markdown, just the JSON array.

Textbook content:
${sampleText}

Example output format:
["Photosynthesis", "Cell Division", "Respiration", "Enzymes"]

Your response (JSON array only):`;

          let topicText = (await generateAI(topicPrompt)).trim();

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

    const topicPrompt = `Analyze the following textbook content and extract 8-10 main academic topics that a teacher could create lesson plans about.

Return ONLY a valid JSON array of short topic names (2-4 words each). No explanation, no markdown, just the JSON array.

Textbook content:
${sampleText}

Example output format:
["Photosynthesis", "Cell Division", "Respiration", "Enzymes"]

Your response (JSON array only):`;

    let topicText = (await generateAI(topicPrompt)).trim();
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

// ── Helper: Search Google for images (single query) ──
// ── Helper: Search Wikipedia for images (FREE, no API key) ──
async function searchImages(query, num = 6) {
  try {
    // Step 1: Search Wikipedia for relevant pages
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=3`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    const pages = searchData.query?.search || [];

    if (pages.length === 0) return [];

    // Step 2: For each page, get its images
    const pageImages = [];
    for (const page of pages) {
      try {
        const pageTitle = page.title;
        // Get page images via the prop=pageimages and imageinfo
        const imgUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=images&format=json&origin=*&imlimit=10`;
        const imgRes = await fetch(imgUrl);
        const imgData = await imgRes.json();
        const pagesData = imgData.query?.pages || {};
        const pageData = Object.values(pagesData)[0];
        const images = pageData?.images || [];

        // Filter out icons/logos, prefer actual content images
        const goodImages = images.filter(img => {
          const fname = img.title.toLowerCase();
          return !fname.includes("commons-logo") &&
                 !fname.includes("edit-icon") &&
                 !fname.includes("wiki.png") &&
                 !fname.includes("disambig") &&
                 !fname.includes("ambox") &&
                 !fname.endsWith(".svg") &&
                 (fname.endsWith(".jpg") || fname.endsWith(".jpeg") ||
                  fname.endsWith(".png") || fname.endsWith(".gif"));
        });

        // Get actual image URLs for the good ones
        for (const img of goodImages.slice(0, 3)) {
          const fileName = img.title; // e.g. "File:Photosynthesis.png"
          const fileInfoUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(fileName)}&prop=imageinfo&iiprop=url|size&format=json&origin=*&iiurlwidth=600`;
          const fileRes = await fetch(fileInfoUrl);
          const fileData = await fileRes.json();
          const fileInfo = Object.values(fileData.query?.pages || {})[0]?.imageinfo?.[0];

          if (fileInfo && fileInfo.thumburl) {
            pageImages.push({
              title: fileName.replace("File:", "").replace(/\.[^.]+$/, "").replace(/_/g, " "),
              link: fileInfo.url,
              thumbnail: fileInfo.thumburl,
              source: "Wikipedia",
              contextLink: `https://en.wikipedia.org/wiki/${encodeURIComponent(pageTitle)}`,
              query,
            });

            if (pageImages.length >= num) break;
          }
        }
      } catch (e) {
        console.warn(`  Wikipedia page image fetch failed for "${page.title}":`, e.message);
      }
      if (pageImages.length >= num) break;
    }

    return pageImages.slice(0, num);
  } catch (err) {
    console.warn("Wikipedia image search failed:", err.message);
    return [];
  }
}

// ── Helper: Run multiple image searches in parallel, dedupe ──
async function searchImagesMulti(queries) {
  if (!queries || queries.length === 0) return [];
  const allResults = await Promise.all(queries.map(q => searchImages(q, 4)));
  const seen = new Set();
  const merged = [];
  // Interleave results from each query so variety wins
  const maxLen = Math.max(...allResults.map(r => r.length));
  for (let i = 0; i < maxLen && merged.length < 8; i++) {
    for (const result of allResults) {
      if (i < result.length && !seen.has(result[i].link)) {
        seen.add(result[i].link);
        merged.push(result[i]);
        if (merged.length >= 8) break;
      }
    }
  }
  return merged;
}

// ── Helper: Search YouTube for videos ──
async function searchYouTube(query) {
  if (!YOUTUBE_API_KEY) return [];
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?key=${YOUTUBE_API_KEY}&q=${encodeURIComponent(query + " education tutorial")}&part=snippet&type=video&maxResults=6&videoEmbeddable=true&safeSearch=strict&relevanceLanguage=en`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) {
      console.warn("YouTube error:", data.error.message);
      return [];
    }
    return (data.items || []).map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      channel: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      embedUrl: `https://www.youtube.com/embed/${item.id.videoId}`,
      publishedAt: item.snippet.publishedAt,
    }));
  } catch (err) {
    console.warn("YouTube search failed:", err.message);
    return [];
  }
}

// ── Helper: Search 3D models from tutar-models index ──
async function search3DModels(queryVector, className, subject) {
  try {
    // Map class names to match tutar-models index format
    // tutar-models uses formats like "6", "11", "Kindergarten" (not "Class 6")
    let classFilter = className;
    if (classFilter && classFilter.startsWith("Class ")) {
      classFilter = classFilter.replace("Class ", "");
    }

    // Try filtered search first
    const filter = {};
    if (classFilter) filter.class = { $eq: classFilter };
    if (subject) filter.subject = { $eq: subject };

    let response;
    if (Object.keys(filter).length > 0) {
      response = await modelsIndex.query({
        vector: queryVector,
        topK: 8,
        filter,
        includeMetadata: true,
      });
    }

    // If no/few results with filter, broaden
    if (!response || !response.matches || response.matches.length < 3) {
      response = await modelsIndex.query({
        vector: queryVector,
        topK: 8,
        includeMetadata: true,
      });
    }

    if (!response.matches || response.matches.length === 0) return [];

    const maxScore = response.matches[0].score || 1;
    return response.matches.map((m) => ({
      name: m.metadata.name,
      class: m.metadata.class,
      subject: m.metadata.subject,
      topic: m.metadata.topic,
      relevance: Math.round((m.score / maxScore) * 100),
    }));
  } catch (err) {
    console.warn("3D models search failed:", err.message);
    return [];
  }
}

// POST /api/generate — generate full content package
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

    console.log(`🔍 Generating full content: "${topic}" from "${book.title}"`);

    // 1. Embed the topic
    const queryVector = await embed(topic);

    // 2. Search textbook chunks (filtered by book)
    const searchResult = await pineconeIndex.query({
      vector: queryVector,
      topK: 12,
      filter: { book_id: { $eq: bookId } },
      includeMetadata: true,
    });

    const contextChunks = (searchResult.matches || []).map((m, i) => ({
      chunk: m.metadata.chunk_text,
      score: m.score,
      index: m.metadata.chunk_index,
    }));

    const context = contextChunks
      .map((c, i) => `[Excerpt ${i + 1}]\n${c.chunk}`)
      .join("\n\n");

    // 3. Run all generation tasks in parallel using generateAI wrapper

    // -- Content prompt: detailed explanation (textbook + general knowledge) --
    const contentPrompt = `You are an expert educational content writer.

Topic: "${topic}"
Class/Grade: ${book.class_name}
Subject: ${book.subject}

Below are excerpts from the student's textbook. Use them as the foundation, but ALSO supplement with your general academic knowledge to give a complete, accurate explanation suitable for ${book.class_name}.

TEXTBOOK EXCERPTS:
${context || "(No textbook excerpts available — use your knowledge)"}

Write a detailed, well-structured explanation of "${topic}" with these sections (use ## markdown):

## Introduction
2-3 sentences introducing the topic.

## Detailed Explanation
The main content. Use sub-headings (###) for sub-topics. Include:
- Clear definitions
- How it works / mechanism
- Examples
- Formulas / equations / chemical reactions (if applicable) with proper notation (H₂O, CO₂, →, etc.)

## Real-World Applications
2-4 practical examples or applications.

## Key Takeaways
3-5 bullet points summarizing the most important facts.

## Common Misconceptions
1-2 common mistakes students make about this topic.

RULES:
- Use clear, age-appropriate language for ${book.class_name}
- Combine textbook information with your knowledge for completeness
- Use proper scientific notation
- Be thorough but not verbose
- Avoid ASCII art diagrams (no text boxes made from -, |, +, etc.) — describe processes in prose or numbered lists instead
- For chemical equations: inline notation like 6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂
- For math equations: LaTeX like $E = mc^2$ or $$F = ma$$`;

    // -- Lesson plan prompt (existing) --
    const lessonPrompt = `You are an expert educational assistant creating a concise lesson plan.

Topic: "${topic}"
Class/Grade: ${book.class_name}
Subject: ${book.subject}
Textbook: ${book.title}

Based ONLY on the following excerpts from the textbook, generate a SHORT and PRACTICAL lesson plan.

TEXTBOOK EXCERPTS:
${context || "(Use general academic knowledge for this topic)"}

Generate a CONCISE lesson plan with EXACTLY these section headings (use ## markdown):

## Lesson Objective
One clear sentence.

## Key Concepts
3-5 bullet points. Format: **Concept Name** — short definition.

## Lesson Flow

### Introduction (5 min)
- One hook question
- Brief introduction

### Main Teaching (20 min)
- 3-5 concise teaching points
- Include key formulas/reactions if applicable

### Activity (10 min)
- One practical activity

### Conclusion (5 min)
- Quick recap

## Key Formulas
List formulas if applicable, else write "None applicable."

## Practice Questions
3 brief questions.

## Discussion Questions
2 brief questions.

RULES:
- Use EXACT section headings shown above
- Bullet points, not paragraphs
- Proper notation: H₂O, CO₂, E = mc², A → B
- Suitable for ${book.class_name}`;

    // -- MCQ prompt --
    const mcqPrompt = `You are an expert educational assessment creator.

Topic: "${topic}"
Class/Grade: ${book.class_name}
Subject: ${book.subject}

Based on the topic and these textbook excerpts (combined with your knowledge), create 5 multiple-choice questions to test student understanding.

TEXTBOOK EXCERPTS:
${context || "(Use your knowledge)"}

Return ONLY a valid JSON array. Each question must have this exact structure:
[
  {
    "question": "What is...",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctIndex": 2,
    "explanation": "Brief explanation of why this answer is correct."
  }
]

RULES:
- Exactly 5 questions
- Each has exactly 4 options
- correctIndex is the index (0-3) of the correct option
- Mix difficulty: 2 easy, 2 medium, 1 hard
- Cover different aspects of the topic
- Age-appropriate for ${book.class_name}
- Return ONLY JSON, no markdown fences, no explanation text`;

    // Execute all in parallel
    console.log(`  ↪ Running parallel generation tasks...`);
    const [
      contentResult,
      lessonResult,
      mcqResult,
      models3D,
      videos,
    ] = await Promise.all([
      generateAI(contentPrompt).catch(e => {
        console.warn("Content generation failed:", e.message);
        return "";
      }),
      generateAI(lessonPrompt).catch(e => {
        console.warn("Lesson generation failed:", e.message);
        return "";
      }),
      generateAI(mcqPrompt).catch(e => {
        console.warn("MCQ generation failed:", e.message);
        return "";
      }),
      search3DModels(queryVector, book.class_name, book.subject),
      searchYouTube(`${topic} ${book.subject} ${book.class_name} explained`),
    ]);

    // ── Image search via Wikipedia (FREE, no API key) ──
    const ENABLE_IMAGE_SEARCH = true;
    let images = [];
    if (ENABLE_IMAGE_SEARCH) {
      // Wikipedia works better with clean topic names (no extra modifiers)
      const imageQueries = [
        topic,
        `${topic} ${book.subject}`,
      ];
      console.log(`  ↪ Wikipedia image queries: ${imageQueries.join(" | ")}`);
      images = await searchImagesMulti(imageQueries);
      console.log(`  ↪ Found ${images.length} images from Wikipedia`);
    } else {
      console.log(`  ↪ Image search disabled`);
    }

    // Parse MCQs
    let mcqs = [];
    try {
      let mcqText = mcqResult.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();
      const jsonMatch = mcqText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        mcqs = JSON.parse(jsonMatch[0]);
        // Validate each MCQ
        mcqs = mcqs.filter(q =>
          q.question && Array.isArray(q.options) && q.options.length === 4 &&
          typeof q.correctIndex === "number" && q.correctIndex >= 0 && q.correctIndex < 4
        );
      }
    } catch (e) {
      console.warn("MCQ parse failed:", e.message);
    }

    console.log(`✅ Generated: content=${!!contentResult}, lesson=${!!lessonResult}, mcqs=${mcqs.length}, models=${models3D.length}, images=${images.length}, videos=${videos.length}`);

    res.json({
      content: contentResult,
      lessonPlan: lessonResult,
      mcqs,
      models3D,
      images,
      videos,
      sources: contextChunks.map((c, i) => ({
        excerptNumber: i + 1,
        relevance: Math.round(c.score * 100),
        preview: c.chunk.slice(0, 200) + "...",
      })),
      stats: {
        chunksUsed: contextChunks.length,
        topic,
        book: book.title,
        className: book.class_name,
        subject: book.subject,
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
