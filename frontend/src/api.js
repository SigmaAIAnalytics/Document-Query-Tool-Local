const BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

export async function uploadDocument(file, companyName, onProgress) {
  const form = new FormData();
  form.append("file", file);
  form.append("company_name", companyName || "");

  // Submit — returns immediately with a job_id
  const res = await fetch(`${BASE}/documents/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Upload failed");
  }
  const { job_id } = await res.json();

  // Poll until done
  while (true) {
    await new Promise((r) => setTimeout(r, 5000));
    const statusRes = await fetch(`${BASE}/documents/jobs/${job_id}`);
    if (!statusRes.ok) throw new Error("Failed to check job status");
    const job = await statusRes.json();

    onProgress?.(job);

    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job.error || "Processing failed");
  }
}

export async function listDocuments() {
  const res = await fetch(`${BASE}/documents`);
  if (!res.ok) throw new Error("Failed to fetch documents");
  return res.json();
}

export async function deleteDocument(docId) {
  const res = await fetch(`${BASE}/documents/${docId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete document");
  return res.json();
}

export async function* streamQuery(question, docId) {
  const res = await fetch(`${BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, doc_id: docId || null }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || "Query failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") return;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.type === "error") throw new Error(parsed.message);
        yield parsed;
      } catch (e) {
        if (e.message && !e.message.includes("JSON")) throw e;
      }
    }
  }
}
