import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";

const DB_NAME = "talking-library-v1";
const STORE_NAME = "documents";
const VAULT_KEY = "talking-library:vault";
const SETTINGS_KEY = "talking-library:settings";
const CHUNK_SIZE = 920;
const CHUNK_OVERLAP = 160;

const state = {
  db: null,
  key: null,
  docs: [],
  selectedDocId: null,
  mode: "local",
};

const $ = (selector) => document.querySelector(selector);

const elements = {
  lockScreen: $("#lockScreen"),
  appShell: $("#appShell"),
  unlockForm: $("#unlockForm"),
  unlockButton: $("#unlockButton"),
  lockIntro: $("#lockIntro"),
  lockMessage: $("#lockMessage"),
  passphrase: $("#passphrase"),
  vaultMeta: $("#vaultMeta"),
  fileInput: $("#fileInput"),
  uploadButton: $("#uploadButton"),
  uploadStatus: $("#uploadStatus"),
  dropZone: $("#dropZone"),
  librarySearch: $("#librarySearch"),
  documentList: $("#documentList"),
  questionForm: $("#questionForm"),
  questionInput: $("#questionInput"),
  askButton: $("#askButton"),
  answerStatus: $("#answerStatus"),
  answerOutput: $("#answerOutput"),
  sourceCount: $("#sourceCount"),
  sourceList: $("#sourceList"),
  exportButton: $("#exportButton"),
  restoreInput: $("#restoreInput"),
  settingsButton: $("#settingsButton"),
  lockButton: $("#lockButton"),
  documentDialog: $("#documentDialog"),
  documentTitle: $("#documentTitle"),
  documentText: $("#documentText"),
  closeDocumentButton: $("#closeDocumentButton"),
  deleteDocumentButton: $("#deleteDocumentButton"),
  settingsDialog: $("#settingsDialog"),
  settingsForm: $("#settingsForm"),
  closeSettingsButton: $("#closeSettingsButton"),
  aiEndpoint: $("#aiEndpoint"),
  aiModel: $("#aiModel"),
  aiToken: $("#aiToken"),
};

function initIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function getVaultConfig() {
  const raw = localStorage.getItem(VAULT_KEY);
  return raw ? JSON.parse(raw) : null;
}

function setVaultConfig(config) {
  localStorage.setItem(VAULT_KEY, JSON.stringify(config));
}

function getSettings() {
  const raw = localStorage.getItem(SETTINGS_KEY);
  return raw ? JSON.parse(raw) : {};
}

function setSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomBase64(length = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return bytesToBase64(bytes);
}

async function deriveKey(passphrase, saltBase64) {
  const passphraseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: base64ToBytes(saltBase64),
      iterations: 210000,
      hash: "SHA-256",
    },
    passphraseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptJson(value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, state.key, plaintext);
  return {
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
  };
}

async function decryptJson(payload) {
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) },
    state.key,
    base64ToBytes(payload.data),
  );
  return JSON.parse(new TextDecoder().decode(decrypted));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txStore(mode = "readonly") {
  return state.db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

function getAllRecords() {
  return new Promise((resolve, reject) => {
    const request = txStore().getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveDoc(doc) {
  const encrypted = await encryptJson(doc);
  return new Promise((resolve, reject) => {
    const request = txStore("readwrite").put({ id: doc.id, encrypted });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function deleteDoc(id) {
  return new Promise((resolve, reject) => {
    const request = txStore("readwrite").delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function clearDocs() {
  return new Promise((resolve, reject) => {
    const request = txStore("readwrite").clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function loadDocs() {
  const records = await getAllRecords();
  const docs = [];
  for (const record of records) {
    try {
      docs.push(await decryptJson(record.encrypted));
    } catch {
      // A corrupted record should not prevent the vault from opening.
    }
  }
  docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  state.docs = docs;
  renderDocuments();
  updateVaultMeta();
}

async function createVault(passphrase) {
  const salt = randomBase64(24);
  state.key = await deriveKey(passphrase, salt);
  const verifier = await encryptJson({ ok: true, createdAt: new Date().toISOString() });
  setVaultConfig({ salt, verifier });
}

async function unlockVault(passphrase) {
  const config = getVaultConfig();
  if (!config) {
    await createVault(passphrase);
    return;
  }

  state.key = await deriveKey(passphrase, config.salt);
  const verifier = await decryptJson(config.verifier);
  if (!verifier.ok) {
    throw new Error("bad-verifier");
  }
}

function showApp() {
  elements.lockScreen.classList.add("hidden");
  elements.appShell.classList.remove("hidden");
  initIcons();
}

function showLock() {
  state.key = null;
  state.docs = [];
  elements.appShell.classList.add("hidden");
  elements.lockScreen.classList.remove("hidden");
  elements.passphrase.value = "";
  elements.passphrase.focus();
}

function updateLockCopy() {
  const hasVault = Boolean(getVaultConfig());
  elements.lockIntro.textContent = hasVault
    ? "用你的口令打开本地加密知识库。"
    : "创建一个只保存在本机浏览器里的加密知识库。";
  elements.unlockButton.querySelector("span").textContent = hasVault ? "打开" : "创建";
}

function updateVaultMeta() {
  const count = state.docs.length;
  const chunks = state.docs.reduce((sum, doc) => sum + doc.chunks.length, 0);
  elements.vaultMeta.textContent = `${count} 份资料 · ${chunks} 个片段`;
}

function fileSizeLabel(size) {
  if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size > 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function dateLabel(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function renderDocuments() {
  const query = elements.librarySearch.value.trim().toLowerCase();
  const template = $("#documentItemTemplate");
  elements.documentList.textContent = "";

  const docs = state.docs.filter((doc) => doc.name.toLowerCase().includes(query));
  if (!docs.length) {
    const empty = document.createElement("div");
    empty.className = "source-item";
    empty.innerHTML = "<strong>暂无资料</strong><p>上传 PDF、TXT、Markdown、JSON、CSV、DOCX 或会议记录。</p>";
    elements.documentList.append(empty);
    return;
  }

  for (const doc of docs) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector("strong").textContent = doc.name;
    node.querySelector("small").textContent = `${fileSizeLabel(doc.size)} · ${doc.chunks.length} 片段 · ${dateLabel(doc.createdAt)}`;
    node.addEventListener("click", () => openDocument(doc.id));
    elements.documentList.append(node);
  }
  initIcons();
}

function cleanText(text) {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkText(text) {
  const normalized = cleanText(text);
  const chunks = [];
  let index = 0;
  let chunkIndex = 1;

  while (index < normalized.length) {
    const targetEnd = Math.min(index + CHUNK_SIZE, normalized.length);
    let end = targetEnd;
    const punctuation = normalized.slice(index, targetEnd).search(/[。！？.!?]\s(?!.*[。！？.!?]\s)/);
    if (punctuation > 420) {
      end = index + punctuation + 1;
    }
    const textChunk = normalized.slice(index, end).trim();
    if (textChunk) {
      chunks.push({ id: chunkIndex, text: textChunk });
      chunkIndex += 1;
    }
    if (end >= normalized.length) break;
    index = Math.max(end - CHUNK_OVERLAP, index + 1);
  }

  return chunks;
}

async function extractPdf(file) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(" ");
    pages.push(`第 ${pageNumber} 页\n${pageText}`);
  }
  return pages.join("\n\n");
}

async function extractDocx(file) {
  if (!window.mammoth) {
    throw new Error("DOCX parser is still loading. Please try again.");
  }
  const arrayBuffer = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

async function extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return extractPdf(file);
  if (name.endsWith(".docx")) return extractDocx(file);
  return file.text();
}

async function importFiles(files) {
  const accepted = [...files].filter((file) =>
    /\.(pdf|txt|md|markdown|json|csv|log|docx)$/i.test(file.name),
  );
  if (!accepted.length) {
    elements.uploadStatus.textContent = "没有可导入的文件";
    return;
  }

  elements.uploadButton.disabled = true;
  for (const file of accepted) {
    elements.uploadStatus.textContent = `解析 ${file.name}`;
    try {
      const text = await extractText(file);
      const chunks = chunkText(text);
      if (!chunks.length) {
        throw new Error("empty-text");
      }
      const doc = {
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type || "document",
        size: file.size,
        createdAt: new Date().toISOString(),
        text: cleanText(text),
        chunks,
      };
      await saveDoc(doc);
      state.docs.unshift(doc);
    } catch (error) {
      console.error(error);
      elements.uploadStatus.textContent = `${file.name} 导入失败`;
    }
  }
  elements.uploadButton.disabled = false;
  elements.fileInput.value = "";
  elements.uploadStatus.textContent = "导入完成";
  renderDocuments();
  updateVaultMeta();
}

function tokenize(input) {
  const text = input.toLowerCase();
  const latin = text.match(/[a-z0-9_]{2,}/g) || [];
  const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
  const cjkPairs = [];
  for (let i = 0; i < cjk.length - 1; i += 1) {
    cjkPairs.push(`${cjk[i]}${cjk[i + 1]}`);
  }
  return [...new Set([...latin, ...cjk, ...cjkPairs])].filter((token) => token.length > 0);
}

function scoreChunk(queryTokens, doc, chunk) {
  const haystack = `${doc.name}\n${chunk.text}`.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    let position = haystack.indexOf(token);
    while (position !== -1) {
      score += token.length > 1 ? 3 : 1;
      position = haystack.indexOf(token, position + token.length);
    }
    if (doc.name.toLowerCase().includes(token)) score += 5;
  }
  return score;
}

function findSources(question, limit = 8) {
  const queryTokens = tokenize(question);
  if (!queryTokens.length) return [];

  const matches = [];
  for (const doc of state.docs) {
    for (const chunk of doc.chunks) {
      const score = scoreChunk(queryTokens, doc, chunk);
      if (score > 0) {
        matches.push({ doc, chunk, score });
      }
    }
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

function bestSentences(question, sources) {
  const tokens = tokenize(question);
  const sentences = [];

  for (const source of sources.slice(0, 5)) {
    const parts = source.chunk.text
      .split(/(?<=[。！？.!?])\s+|\n+/)
      .map((part) => part.trim())
      .filter(Boolean);

    for (const part of parts) {
      const lower = part.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
      if (score > 0) {
        sentences.push({ text: part, score, source });
      }
    }
  }

  return sentences.sort((a, b) => b.score - a.score).slice(0, 6);
}

function buildLocalAnswer(question, sources) {
  if (!state.docs.length) {
    return "资料库还是空的。请先上传 PDF、文档或会议记录。";
  }
  if (!sources.length) {
    return "我没有在当前资料库里找到足够接近的片段。可以换一种问法，或上传更多相关资料。";
  }

  const sentences = bestSentences(question, sources);
  if (!sentences.length) {
    return `我找到了 ${sources.length} 条相关片段，但没有足够明确的句子可以合成答案。请查看右侧引用。`;
  }

  const lines = sentences.map((item, index) => {
    const citation = `【${item.source.doc.name} · 片段 ${item.source.chunk.id}】`;
    return `${index + 1}. ${item.text} ${citation}`;
  });

  return `根据当前资料库，相关线索如下：\n\n${lines.join("\n")}`;
}

function renderSources(sources) {
  elements.sourceList.textContent = "";
  elements.sourceCount.textContent = `${sources.length} 条`;

  for (const source of sources) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "source-item";
    item.innerHTML = `
      <strong>${escapeHtml(source.doc.name)} · 片段 ${source.chunk.id}</strong>
      <p>${escapeHtml(source.chunk.text.slice(0, 360))}${source.chunk.text.length > 360 ? "..." : ""}</p>
      <span class="source-score">相关度 ${source.score}</span>
    `;
    item.addEventListener("click", () => openDocument(source.doc.id, source.chunk.id));
    elements.sourceList.append(item);
  }
}

async function askAiBackend(question, sources) {
  const settings = getSettings();
  if (!settings.endpoint) {
    throw new Error("missing-endpoint");
  }

  const payload = {
    question,
    model: settings.model || "gpt-5.5",
    context: sources.map((source) => ({
      document: source.doc.name,
      chunkId: source.chunk.id,
      text: source.chunk.text,
    })),
  };

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`AI backend returned ${response.status}`);
  }

  const result = await response.json();
  return result.answer || result.text || JSON.stringify(result, null, 2);
}

async function handleQuestion(event) {
  event.preventDefault();
  const question = elements.questionInput.value.trim();
  if (!question) return;

  elements.answerOutput.classList.remove("empty");
  elements.answerStatus.textContent = "检索中";
  elements.answerOutput.textContent = "";

  const sources = findSources(question);
  renderSources(sources);

  try {
    let answer;
    if (state.mode === "ai") {
      elements.answerStatus.textContent = "请求 AI 后端";
      answer = await askAiBackend(question, sources);
    } else {
      answer = buildLocalAnswer(question, sources);
    }
    elements.answerStatus.textContent = "完成";
    elements.answerOutput.textContent = answer;
  } catch (error) {
    elements.answerStatus.textContent = "已切回本地引用";
    elements.answerOutput.textContent =
      error.message === "missing-endpoint"
        ? "还没有配置 AI 后端地址。已在右侧保留本地检索引用。"
        : `AI 后端不可用：${error.message}\n\n${buildLocalAnswer(question, sources)}`;
  }
}

function openDocument(id, chunkId = null) {
  const doc = state.docs.find((item) => item.id === id);
  if (!doc) return;
  state.selectedDocId = id;
  elements.documentTitle.textContent = doc.name;
  elements.documentText.textContent = doc.text;
  elements.documentDialog.showModal();
  if (chunkId) {
    requestAnimationFrame(() => {
      const chunk = doc.chunks.find((item) => item.id === chunkId);
      const index = chunk ? doc.text.indexOf(chunk.text.slice(0, 80)) : -1;
      if (index > -1) {
        const ratio = index / Math.max(doc.text.length, 1);
        elements.documentText.scrollTop =
          ratio * (elements.documentText.scrollHeight - elements.documentText.clientHeight);
      }
    });
  }
}

async function exportBackup() {
  const encryptedDocs = await Promise.all(state.docs.map((doc) => encryptJson(doc)));
  const backup = {
    app: "talking-library",
    version: 1,
    exportedAt: new Date().toISOString(),
    documents: encryptedDocs,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `talking-library-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function restoreBackup(file) {
  const backup = JSON.parse(await file.text());
  if (!backup.documents?.length) {
    throw new Error("Invalid backup");
  }

  const docs = [];
  for (const encrypted of backup.documents) {
    docs.push(await decryptJson(encrypted));
  }

  await clearDocs();
  for (const doc of docs) {
    await saveDoc(doc);
  }
  state.docs = docs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderDocuments();
  updateVaultMeta();
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadSettingsForm() {
  const settings = getSettings();
  elements.aiEndpoint.value = settings.endpoint || "";
  elements.aiModel.value = settings.model || "gpt-5.5";
  elements.aiToken.value = settings.token || "";
}

function bindEvents() {
  elements.unlockForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const passphrase = elements.passphrase.value;
    elements.lockMessage.textContent = "";
    elements.unlockButton.disabled = true;
    try {
      await unlockVault(passphrase);
      await loadDocs();
      showApp();
    } catch {
      elements.lockMessage.textContent = "口令不正确，或本地知识库已损坏。";
      state.key = null;
    } finally {
      elements.unlockButton.disabled = false;
    }
  });

  elements.uploadButton.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", (event) => importFiles(event.target.files));
  elements.librarySearch.addEventListener("input", renderDocuments);
  elements.questionForm.addEventListener("submit", handleQuestion);

  for (const button of document.querySelectorAll(".mode-button")) {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      document.querySelectorAll(".mode-button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
    });
  }

  elements.dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragging");
  });
  elements.dropZone.addEventListener("dragleave", () => elements.dropZone.classList.remove("dragging"));
  elements.dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragging");
    importFiles(event.dataTransfer.files);
  });

  elements.exportButton.addEventListener("click", exportBackup);
  elements.restoreInput.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      await restoreBackup(file);
      elements.uploadStatus.textContent = "备份已导入";
    } catch (error) {
      console.error(error);
      elements.uploadStatus.textContent = "备份导入失败";
    }
    elements.restoreInput.value = "";
  });

  elements.settingsButton.addEventListener("click", () => {
    loadSettingsForm();
    elements.settingsDialog.showModal();
  });
  elements.closeSettingsButton.addEventListener("click", () => elements.settingsDialog.close());
  elements.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    setSettings({
      endpoint: elements.aiEndpoint.value.trim(),
      model: elements.aiModel.value.trim(),
      token: elements.aiToken.value,
    });
    elements.settingsDialog.close();
  });

  elements.lockButton.addEventListener("click", showLock);
  elements.closeDocumentButton.addEventListener("click", () => elements.documentDialog.close());
  elements.deleteDocumentButton.addEventListener("click", async () => {
    if (!state.selectedDocId) return;
    await deleteDoc(state.selectedDocId);
    state.docs = state.docs.filter((doc) => doc.id !== state.selectedDocId);
    state.selectedDocId = null;
    elements.documentDialog.close();
    renderDocuments();
    updateVaultMeta();
  });
}

async function main() {
  state.db = await openDb();
  bindEvents();
  updateLockCopy();
  initIcons();
  elements.passphrase.focus();
}

main().catch((error) => {
  console.error(error);
  elements.lockMessage.textContent = "浏览器不支持本地加密知识库。";
});
