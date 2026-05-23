// ============================================
// TutAR Notebook — Frontend Logic
// ============================================

let supa = null;
let currentUser = null;
let currentBookId = null;
let booksData = [];

// ── Initialize Supabase ──
async function initSupabase() {
  const res = await fetch("/api/config");
  const config = await res.json();
  supa = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

  // Check if already logged in
  const { data: { session } } = await supa.auth.getSession();
  if (session?.user) {
    currentUser = session.user;
    showMainApp();
    loadBooks();
  }
}

// ── Auth Tabs ──
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    document.getElementById("loginForm").classList.toggle("hidden", which !== "login");
    document.getElementById("signupForm").classList.toggle("hidden", which !== "signup");
  });
});

// ── Login ──
async function login() {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.classList.remove("show");

  if (!email || !password) {
    errEl.textContent = "Please enter email and password";
    errEl.classList.add("show");
    return;
  }

  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = error.message;
    errEl.classList.add("show");
    return;
  }
  currentUser = data.user;
  showMainApp();
  loadBooks();
}

// ── Signup ──
async function signup() {
  const name = document.getElementById("signupName").value.trim();
  const email = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPassword").value;
  const errEl = document.getElementById("signupError");
  errEl.classList.remove("show");

  if (!name || !email || !password) {
    errEl.textContent = "All fields are required";
    errEl.classList.add("show");
    return;
  }
  if (password.length < 6) {
    errEl.textContent = "Password must be at least 6 characters";
    errEl.classList.add("show");
    return;
  }

  const { data, error } = await supa.auth.signUp({
    email,
    password,
    options: { data: { full_name: name } },
  });
  if (error) {
    errEl.textContent = error.message;
    errEl.classList.add("show");
    return;
  }

  if (data.user && !data.session) {
    errEl.textContent = "Account created! Please check your email to confirm, then login.";
    errEl.classList.add("show");
    errEl.style.background = "#E8F8EF";
    errEl.style.color = "#12A150";
    return;
  }

  currentUser = data.user;
  showMainApp();
  loadBooks();
}

// ── Logout ──
async function logout() {
  await supa.auth.signOut();
  currentUser = null;
  currentBookId = null;
  document.getElementById("authScreen").classList.remove("hidden");
  document.getElementById("mainApp").classList.add("hidden");
}

// ── Show Main App ──
function showMainApp() {
  document.getElementById("authScreen").classList.add("hidden");
  document.getElementById("mainApp").classList.remove("hidden");

  const name = currentUser?.user_metadata?.full_name || currentUser?.email || "User";
  document.getElementById("userName").textContent = name;
  document.getElementById("userAvatar").textContent = name.charAt(0).toUpperCase();
}

// ── Get auth header ──
async function authHeader() {
  const { data: { session } } = await supa.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}

// ── Load Books ──
async function loadBooks() {
  const headers = await authHeader();
  const res = await fetch("/api/books", { headers });
  const data = await res.json();
  booksData = data.books || [];
  renderBooks();
}

// ── Render Books in sidebar ──
function renderBooks() {
  const list = document.getElementById("bookList");
  list.innerHTML = "";

  if (booksData.length === 0) {
    list.innerHTML = '<div style="color:var(--light);font-size:12px;padding:8px;text-align:center;">No books yet</div>';
    return;
  }

  booksData.forEach((book) => {
    const item = document.createElement("div");
    item.className = "book-item" + (book.id === currentBookId ? " active" : "");
    item.innerHTML = `
      <div class="book-title">${book.title}</div>
      <div class="book-tag">${book.class_name} · ${book.subject}</div>
      <div class="book-status status-${book.status}">${book.status}</div>
    `;
    item.onclick = () => selectBook(book.id);
    list.appendChild(item);
  });

  // Auto-refresh if any book is processing
  if (booksData.some(b => b.status === "processing")) {
    setTimeout(loadBooks, 3000);
  }
}

// ── Select a book ──
function selectBook(bookId) {
  currentBookId = bookId;
  const book = booksData.find((b) => b.id === bookId);
  if (!book) return;

  if (book.status !== "ready") {
    alert(`This book is ${book.status}. Please wait until it's ready.`);
    return;
  }

  document.getElementById("welcomeState").classList.add("hidden");
  document.getElementById("bookView").classList.remove("hidden");
  document.getElementById("selectedBookTitle").textContent = book.title;
  document.getElementById("selectedBookMeta").textContent = `${book.class_name} · ${book.subject}`;

  document.getElementById("lessonOutput").classList.add("hidden");
  document.getElementById("topicInput").value = "";

  // Render suggested topics
  renderSuggestedTopics(book.suggested_topics);

  renderBooks();
}

// ── Render suggested topics chips ──
function renderSuggestedTopics(topics) {
  const container = document.getElementById("suggestedTopics");
  const chips = document.getElementById("topicChips");
  chips.innerHTML = "";

  if (!topics || !Array.isArray(topics) || topics.length === 0) {
    container.classList.add("hidden");
    return;
  }

  container.classList.remove("hidden");
  topics.forEach((topic) => {
    const chip = document.createElement("button");
    chip.className = "topic-chip";
    chip.textContent = topic;
    chip.onclick = () => {
      document.getElementById("topicInput").value = topic;
      generateLesson();
    };
    chips.appendChild(chip);
  });
}

// ── Regenerate topic suggestions ──
async function regenerateTopics() {
  if (!currentBookId) return;
  const btn = document.getElementById("regenTopicsBtn");
  const originalText = btn.textContent;
  btn.textContent = "Regenerating...";
  btn.disabled = true;

  try {
    const headers = await authHeader();
    const res = await fetch(`/api/books/${currentBookId}/regenerate-topics`, {
      method: "POST",
      headers,
    });
    const data = await res.json();

    if (!res.ok) {
      alert("Failed: " + (data.error || "Unknown error"));
      return;
    }

    // Update local book data and re-render
    const book = booksData.find((b) => b.id === currentBookId);
    if (book) {
      book.suggested_topics = data.topics;
      renderSuggestedTopics(data.topics);
    }
  } catch (err) {
    alert("Error: " + err.message);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// ── Delete current book ──
async function deleteCurrentBook() {
  if (!currentBookId) return;
  if (!confirm("Delete this book and all its content?")) return;

  const headers = await authHeader();
  const res = await fetch(`/api/books/${currentBookId}`, {
    method: "DELETE",
    headers,
  });

  if (res.ok) {
    currentBookId = null;
    document.getElementById("bookView").classList.add("hidden");
    document.getElementById("welcomeState").classList.remove("hidden");
    loadBooks();
  } else {
    alert("Failed to delete book");
  }
}

// ── Upload Modal ──
function showUploadModal() {
  document.getElementById("uploadModal").classList.remove("hidden");
}
function hideUploadModal() {
  document.getElementById("uploadModal").classList.add("hidden");
  document.getElementById("uploadTitle").value = "";
  document.getElementById("uploadClass").value = "";
  document.getElementById("uploadSubject").value = "";
  document.getElementById("uploadFile").value = "";
  document.getElementById("uploadError").classList.remove("show");
  document.getElementById("uploadProgress").classList.add("hidden");
  document.getElementById("uploadBtn").disabled = false;
}

async function uploadBook() {
  const title = document.getElementById("uploadTitle").value.trim();
  const className = document.getElementById("uploadClass").value;
  const subject = document.getElementById("uploadSubject").value.trim();
  const fileInput = document.getElementById("uploadFile");
  const errEl = document.getElementById("uploadError");
  errEl.classList.remove("show");

  if (!title || !className || !subject) {
    errEl.textContent = "All fields are required";
    errEl.classList.add("show");
    return;
  }
  if (!fileInput.files.length) {
    errEl.textContent = "Please select a PDF file";
    errEl.classList.add("show");
    return;
  }

  const file = fileInput.files[0];
  if (file.size > 50 * 1024 * 1024) {
    errEl.textContent = "File too large (max 50 MB)";
    errEl.classList.add("show");
    return;
  }

  // Show progress
  document.getElementById("uploadProgress").classList.remove("hidden");
  document.getElementById("uploadBtn").disabled = true;

  const formData = new FormData();
  formData.append("pdf", file);
  formData.append("title", title);
  formData.append("className", className);
  formData.append("subject", subject);

  const headers = await authHeader();

  try {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload", true);
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        document.getElementById("progressFill").style.width = pct + "%";
        document.getElementById("progressText").textContent = `Uploading ${pct}%`;
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        document.getElementById("progressText").textContent = "Upload complete! Processing in background...";
        setTimeout(() => {
          hideUploadModal();
          loadBooks();
        }, 1500);
      } else {
        const err = JSON.parse(xhr.responseText);
        errEl.textContent = err.error || "Upload failed";
        errEl.classList.add("show");
        document.getElementById("uploadBtn").disabled = false;
        document.getElementById("uploadProgress").classList.add("hidden");
      }
    };

    xhr.onerror = () => {
      errEl.textContent = "Network error";
      errEl.classList.add("show");
      document.getElementById("uploadBtn").disabled = false;
    };

    xhr.send(formData);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.add("show");
    document.getElementById("uploadBtn").disabled = false;
  }
}

// ── Generate Lesson Plan ──
async function generateLesson() {
  const topic = document.getElementById("topicInput").value.trim();
  if (!topic) {
    alert("Please enter a topic");
    return;
  }
  if (!currentBookId) return;

  document.getElementById("lessonOutput").classList.add("hidden");
  document.getElementById("generateLoading").classList.remove("hidden");

  try {
    const headers = await authHeader();
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ bookId: currentBookId, topic }),
    });

    const data = await res.json();
    document.getElementById("generateLoading").classList.add("hidden");

    if (!res.ok) {
      alert("Error: " + (data.error || "Unknown error"));
      return;
    }

    // Render lesson plan
    document.getElementById("lessonOutput").classList.remove("hidden");
    document.getElementById("lessonMeta").textContent =
      `${data.stats.chunksUsed} sources`;
    renderLessonPlan(data);

    // Render sources
    const sourcesList = document.getElementById("sourcesList");
    sourcesList.innerHTML = "";
    data.sources.forEach((src) => {
      const item = document.createElement("div");
      item.className = "source-item";
      item.innerHTML = `
        <div class="source-item-header">
          <span>Excerpt ${src.excerptNumber}</span>
          <span class="source-relevance">${src.relevance}% match</span>
        </div>
        <div>${src.preview}</div>
      `;
      sourcesList.appendChild(item);
    });

  } catch (err) {
    document.getElementById("generateLoading").classList.add("hidden");
    alert("Failed to generate: " + err.message);
  }
}

// ══════════════════════════════════════════════
// Beautiful lesson plan renderer
// ══════════════════════════════════════════════
function renderLessonPlan(data) {
  const container = document.getElementById("lessonContent");
  const markdown = data.lessonPlan;
  const stats = data.stats;

  const sections = parseMarkdownSections(markdown);

  let html = `
    <div class="lesson-banner">
      <div class="banner-item">
        <div class="banner-icon">🎯</div>
        <div class="banner-text">
          <div class="banner-label">Topic</div>
          <div class="banner-value">${escapeHtml(stats.topic)}</div>
        </div>
      </div>
      <div class="banner-item">
        <div class="banner-icon">⏱️</div>
        <div class="banner-text">
          <div class="banner-label">Duration</div>
          <div class="banner-value">40 mins</div>
        </div>
      </div>
      <div class="banner-item">
        <div class="banner-icon">📑</div>
        <div class="banner-text">
          <div class="banner-label">Sources</div>
          <div class="banner-value">${stats.chunksUsed} excerpts</div>
        </div>
      </div>
      <div class="banner-item banner-actions">
        <button class="banner-btn" onclick="copyLessonPlan()">📋 Copy</button>
        <button class="banner-btn" onclick="printLessonPlan()">🖨️ Print</button>
      </div>
    </div>
  `;

  for (const section of sections) {
    const key = section.title.toLowerCase().trim();

    // Fuzzy matching for section type
    let config = null;
    if (key.includes("objective")) config = { icon: "🎯", color: "blue", title: "Lesson Objective" };
    else if (key.includes("concept")) config = { icon: "📚", color: "purple", title: "Key Concepts" };
    else if (key.includes("flow") || key.includes("plan") || key.includes("structure")) config = { icon: "⏱️", color: "orange", title: "Lesson Flow", isFlow: true };
    else if (key.includes("formula") || key.includes("equation") || key.includes("reaction")) config = { icon: "🧮", color: "green", title: "Key Formulas" };
    else if (key.includes("practice") || key.includes("problem") || key.includes("exercise")) config = { icon: "✏️", color: "pink", title: "Practice Questions" };
    else if (key.includes("discussion") || key.includes("question")) config = { icon: "💭", color: "teal", title: "Discussion Questions" };
    else if (key.includes("topic") || key.includes("overview") || key.includes("introduction")) config = { icon: "📖", color: "blue", title: section.title };
    else if (key.includes("learning")) config = { icon: "🎓", color: "purple", title: "Learning Objectives" };
    else if (key.includes("important")) config = { icon: "⭐", color: "orange", title: "Important Points" };
    else config = { icon: "📄", color: "gray", title: section.title };

    if (config.isFlow) {
      html += renderTimelineSection(section, config);
    } else {
      html += renderRegularSection(section, config);
    }
  }

  container.innerHTML = html;
}

function renderRegularSection(section, config) {
  return `
    <div class="section-card section-${config.color}">
      <div class="section-header">
        <div class="section-icon">${config.icon}</div>
        <h3 class="section-title">${config.title}</h3>
      </div>
      <div class="section-body">
        ${marked.parse(section.content)}
      </div>
    </div>
  `;
}

function renderTimelineSection(section, config) {
  const subsections = parseSubsections(section.content);
  let timelineHtml = '<div class="timeline">';
  const timeColors = ["#3B82F6", "#F59E0B", "#10B981", "#8B5CF6"];

  subsections.forEach((sub, i) => {
    const minMatch = sub.title.match(/(\d+)\s*min/i);
    const minutes = minMatch ? minMatch[1] : "";
    const titleClean = sub.title.replace(/\s*\([^)]*\)/, "").trim();

    timelineHtml += `
      <div class="timeline-item">
        <div class="timeline-dot" style="background:${timeColors[i % timeColors.length]}"></div>
        <div class="timeline-content">
          <div class="timeline-header">
            <span class="timeline-title">${titleClean}</span>
            ${minutes ? `<span class="timeline-time" style="background:${timeColors[i % timeColors.length]}22;color:${timeColors[i % timeColors.length]}">${minutes} min</span>` : ""}
          </div>
          <div class="timeline-body">${marked.parse(sub.content)}</div>
        </div>
      </div>
    `;
  });
  timelineHtml += "</div>";

  return `
    <div class="section-card section-${config.color}">
      <div class="section-header">
        <div class="section-icon">${config.icon}</div>
        <h3 class="section-title">${config.title}</h3>
        <span class="section-badge">40 mins</span>
      </div>
      <div class="section-body">
        ${timelineHtml}
      </div>
    </div>
  `;
}

function parseMarkdownSections(markdown) {
  const lines = markdown.split("\n");
  const sections = [];
  let currentSection = null;

  for (const line of lines) {
    // Match these heading formats:
    // ## Section Name
    // **1. Section Name**
    // **Section Name**

    let headingMatch = null;

    // ## heading (not ###)
    if (line.match(/^##\s+/) && !line.match(/^###/)) {
      headingMatch = line.replace(/^##\s+/, "").trim();
    }
    // **1. Section Name** or **Section Name**
    else if (/^\*\*[\d.\s]*[A-Za-z][^*]*\*\*\s*$/.test(line.trim())) {
      headingMatch = line.trim()
        .replace(/^\*\*/, "")
        .replace(/\*\*$/, "")
        .replace(/^\d+\.\s*/, "")
        .trim();
    }

    if (headingMatch) {
      // Skip "Lesson Flow" subsections like **Introduction (5 min)**
      const subsectionWords = ["introduction", "main teaching", "main content", "activity", "activities", "conclusion"];
      const lowerHeading = headingMatch.toLowerCase().split("(")[0].trim();
      if (subsectionWords.some(w => lowerHeading === w)) {
        // This is a sub-heading inside Lesson Flow, keep it as content
        if (currentSection) {
          currentSection.content += "### " + headingMatch + "\n";
        }
        continue;
      }

      if (currentSection) sections.push(currentSection);
      currentSection = { title: headingMatch, content: "" };
    } else if (currentSection) {
      currentSection.content += line + "\n";
    }
  }
  if (currentSection) sections.push(currentSection);

  // FALLBACK: if no sections were parsed, return the whole thing as one section
  if (sections.length === 0 && markdown.trim().length > 0) {
    sections.push({ title: "Lesson Plan", content: markdown });
  }

  return sections;
}

function parseSubsections(text) {
  const lines = text.split("\n");
  const subs = [];
  let current = null;
  for (const line of lines) {
    let headingMatch = null;

    // ### Subsection
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) headingMatch = h3[1].trim();
    // **Introduction (5 min)** style
    else if (/^\*\*[^*]+\*\*\s*$/.test(line.trim())) {
      headingMatch = line.trim().replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
    }

    if (headingMatch) {
      if (current) subs.push(current);
      current = { title: headingMatch, content: "" };
    } else if (current) {
      current.content += line + "\n";
    }
  }
  if (current) subs.push(current);
  return subs;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function copyLessonPlan() {
  const text = document.getElementById("lessonContent").innerText;
  navigator.clipboard.writeText(text).then(() => {
    showToast("Lesson plan copied!");
  }).catch(() => {
    showToast("Failed to copy", true);
  });
}

function printLessonPlan() {
  window.print();
}

function showToast(message, isError) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = "toast show" + (isError ? " toast-error" : "");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

// ── Drag & Drop ──
function setupDragDrop() {
  const overlay = document.getElementById("dropOverlay");
  if (!overlay) {
    console.error("Drop overlay element not found");
    return;
  }
  let hideTimeout = null;

  function showOverlay() {
    clearTimeout(hideTimeout);
    overlay.classList.remove("hidden");
  }

  function hideOverlay() {
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      overlay.classList.add("hidden");
    }, 100);
  }

  // Prevent default browser behavior (open PDF in browser tab)
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentUser) return;
    if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes("Files")) {
      // Don't show overlay if modal is already open (avoid confusion)
      const modal = document.getElementById("uploadModal");
      if (modal && !modal.classList.contains("hidden")) return;
      showOverlay();
    }
  });

  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only hide if leaving the window entirely
    if (e.clientX === 0 && e.clientY === 0) {
      hideOverlay();
    } else if (!e.relatedTarget) {
      hideOverlay();
    }
  });

  window.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    overlay.classList.add("hidden");

    if (!currentUser) {
      alert("Please login first");
      return;
    }

    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    if (file.type !== "application/pdf") {
      alert("Please drop a PDF file");
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      alert("File too large (max 50 MB)");
      return;
    }

    // Open upload modal with file pre-filled
    showUploadModal();
    const fileInput = document.getElementById("uploadFile");
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;
    } catch (err) {
      console.warn("Could not pre-fill file input:", err);
    }

    // Auto-fill title from filename
    const fileName = file.name.replace(/\.pdf$/i, "").replace(/[_\-]/g, " ");
    document.getElementById("uploadTitle").value = fileName;
  });
}

// Enter key support
document.addEventListener("DOMContentLoaded", () => {
  initSupabase();
  setupDragDrop();

  document.getElementById("topicInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") generateLesson();
  });
  document.getElementById("loginPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") login();
  });
  document.getElementById("signupPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") signup();
  });
});
