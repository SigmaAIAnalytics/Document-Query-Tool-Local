# Architecture

A deep-dive into the design decisions behind this SEC filings RAG application, including alternatives considered and the tradeoffs involved.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Document Ingestion Pipeline](#1-document-ingestion-pipeline)
3. [Chunking Strategy](#2-chunking-strategy)
4. [Embedding Model](#3-embedding-model)
5. [Vector Store](#4-vector-store)
6. [Retrieval Strategy](#5-retrieval-strategy)
7. [Anchor Chunk System](#6-anchor-chunk-system)
8. [Frontend Architecture](#7-frontend-architecture)
9. [Summary](#summary)

---

## System Overview

```
┌──────────────┐     ┌────────────┐     ┌─────────────┐     ┌───────────┐
│  PDF Upload  │────▶│ Landing.ai │────▶│  ChromaDB   │────▶│  Claude   │
│  (FastAPI)   │     │  (parser)  │     │ (vector db) │     │ (tool use)│
└──────────────┘     └────────────┘     └─────────────┘     └───────────┘
                           │                                       │
                    Typed chunks +                          Streaming SSE
                    bounding boxes                           to frontend
```

**Stack at a glance**

| Layer | Technology |
|---|---|
| Backend | Python 3.12, FastAPI, Uvicorn |
| PDF parsing | Landing.ai (ADE API) |
| Embeddings | `all-MiniLM-L6-v2` (sentence-transformers, local) |
| Vector store | ChromaDB (persistent, HNSW, cosine similarity) |
| LLM | Claude Sonnet (`claude-sonnet-4-6`) via Anthropic SDK |
| Frontend | React 18, Vite, Tailwind CSS |
| PDF rendering | PyMuPDF (server-side, per-page PNG) |

---

## 1. Document Ingestion Pipeline

**Flow:** `PDF upload → Landing.ai → structured chunks → embed → ChromaDB`

### What we built

When a PDF is uploaded, the backend immediately submits it to Landing.ai's ADE (Agentic Document Extraction) API and returns a `job_id`. A background `asyncio` task polls the job until completion, then:

1. Persists the raw Landing.ai JSON response to disk (`parsed_documents/`)
2. Extracts typed chunks with `extract_chunks()`
3. Embeds all chunk texts in a single batch
4. Saves the original PDF for page rendering
5. Writes all chunks + embeddings + metadata to ChromaDB

### Why Landing.ai for parsing

Landing.ai is a multimodal document AI that understands PDF layout. It returns typed chunks (`text`, `table`, `figure`, `marginalia`) with normalized bounding boxes and page numbers — not just a raw character stream.

This matters for SEC filings because:

- **Tables are preserved as structured markdown** rather than garbled column-shifted strings. Financial statements, segment data, and footnote tables are the most information-dense parts of a 10-K.
- **Bounding boxes** (`box_left`, `box_top`, `box_right`, `box_bottom`) are stored as chunk metadata. These drive the PDF viewer's highlight overlay, connecting a retrieved chunk back to its exact visual location in the document.
- **Section headings** are detected and propagated forward, so every chunk carries a `section_heading` label (e.g., `"Item 1A. Risk Factors"`).
- **Noise is filtered** — `marginalia`, `logo`, `figure`, and `attestation` chunks are skipped at index time.

### Alternatives considered

**PyMuPDF direct extraction**
> PyMuPDF is already present in the project for page rendering.
- Pro: zero cost, fully offline, no external API dependency
- Con: treats the PDF as a character stream — tables come out as misaligned columns, no semantic chunk boundaries, no bounding boxes. Unacceptable quality for financial tables.

**Unstructured.io**
- Open-source partition pipeline, better than raw PyMuPDF
- Con: table extraction still lags a vision model; self-hosting adds infrastructure complexity

**Amazon Textract / Azure Form Recognizer**
- Comparable capability to Landing.ai
- Con: vendor lock-in to AWS/Azure; data residency concerns for sensitive M&A filings

---

## 2. Chunking Strategy

### What we built

We use **Landing.ai's own chunk boundaries** — each semantic block (a paragraph, a table, a caption) becomes exactly one chunk. No recursive text splitting or fixed-size windowing.

### Why

Traditional RAG uses fixed-size chunking (e.g. 512 tokens with 50-token overlap). That approach would split a financial table across two chunks, destroying its meaning. Because Landing.ai already segments by semantic type, we preserve each unit of meaning intact, and the chunk type (`text` vs. `table`) is surfaced in the UI and in the LLM's context header.

### Alternatives considered

**Recursive character splitting** (e.g. LangChain's `RecursiveCharacterTextSplitter`)
- Simpler, no external dependency
- Loses table integrity; no chunk type metadata; no bounding boxes
- Better suited to prose-heavy documents than structured filings

**Semantic chunking** (split on embedding distance changes)
- Computationally expensive at index time
- Still blind to visual layout — cannot distinguish a table from a paragraph

---

## 3. Embedding Model

### What we built

`all-MiniLM-L6-v2` — a 22M-parameter sentence transformer that runs locally on CPU.

### Why

For a single-user research tool over a small document set, the priority is zero marginal cost and no added latency or API dependencies at query time. MiniLM provides strong general-purpose English semantic similarity and loads once at startup.

### Alternatives considered

**OpenAI `text-embedding-3-small`**
- Stronger semantic quality, 1536-dimensional vectors
- Con: per-token API cost; adds external dependency and latency on every query

**`all-mpnet-base-v2`** (local)
- Better quality than MiniLM, still runs locally
- 3–4× slower; larger memory footprint — worth considering as the document library grows

**Voyage AI `voyage-finance-2`**
- Trained specifically on financial text — likely best quality for SEC filings
- Con: proprietary API, cost, and another vendor dependency

---

## 4. Vector Store

### What we built

ChromaDB with:
- Cosine similarity (`hnsw:space: cosine`)
- Persistent local storage
- A single collection (`sec_filings`) covering all documents, with `doc_id` as a metadata filter

### Why ChromaDB

ChromaDB supports three retrieval modes in a single store:

| Mode | ChromaDB API | Use case |
|---|---|---|
| Dense vector search | `collection.query(query_embeddings=...)` | Semantic questions |
| Metadata filtering | `where={"page": N}` | Page-based lookup |
| Full-text substring | `where_document={"$contains": keyword}` | Exact number/ticker search |

This eliminates the need for a separate keyword search index (Elasticsearch, etc.) while keeping the stack simple.

### Alternatives considered

**pgvector (Postgres)**
- Better for production multi-user deployments: ACID guarantees, SQL for complex filtering, mature tooling
- Con: operational overhead; needs a running Postgres instance; overkill for a single-user tool

**Pinecone / Weaviate / Qdrant (hosted)**
- Managed, scalable, production-grade
- Con: cost; network latency; data leaves the local machine (a compliance concern for sensitive filings)

**FAISS**
- Extremely fast pure vector search
- Con: no metadata filtering; no persistence without custom code; no keyword search — would require Elasticsearch alongside it, doubling the infrastructure

---

## 5. Retrieval Strategy

> This is the most architecturally significant decision in the project.

### What we built: tool-use agentic RAG

Rather than a one-shot "embed → top-k → generate" pipeline, the query endpoint runs Claude in a **tool-use loop** (up to 5 iterations). Claude is given four tools and decides which to invoke based on the question:

| Tool | Best for |
|---|---|
| `search_semantic` | Conceptual questions ("what are the risk factors?") |
| `search_by_page` | "What does page 47 say?" |
| `search_by_keyword` | Finding exact numbers, tickers, specific strings across the document |
| `search_similar_to_selection` | "Where else in the document is this mentioned?" (anchored to user selection) |

The loop accumulates a deduplicated chunk set across all tool calls, then makes a final streaming call with all gathered context. This means Claude can triangulate — e.g. do a semantic search, find a revenue figure, then keyword-search that exact number to find every other reference to it in the document.

### Why not naive RAG

The standard pattern (embed query → top-k similarity → stuff context → generate) breaks on SEC filings for several reasons:

- `"What was revenue in Q3?"` requires finding the right table, not just semantically similar prose
- `"Where else in this document is this risk factor mentioned?"` requires similarity search anchored to a specific chunk, not the question
- `"What does page 12 say?"` requires page-based retrieval; embedding similarity is irrelevant

A single retrieval strategy cannot handle all three. The tool-use loop lets the model select the right strategy per question type.

### Alternatives considered

**Hybrid retrieval with fixed strategy** (dense + BM25/TF-IDF + cross-encoder re-ranking)
- Deterministic, faster, no extra LLM calls for tool routing
- Con: cannot adapt to question type; requires heuristics to decide "is this a keyword or conceptual question?"; still misses the page-lookup and user-selection use cases

**LangChain / LlamaIndex agent pipelines**
- Provide abstractions for retrieval chains and agent loops
- We built the loop directly to avoid abstraction overhead, retain full control over the tool contract, and support SSE streaming without working around framework assumptions

### The query flow

```
User question
      │
      ▼
 Inject anchor chunks (if any) into user message
      │
      ▼
 Claude with tools (up to 5 iterations)
      │
      ├── tool_use → execute retrieval → append tool_result → repeat
      │
      └── end_turn
            │
            ▼
      Emit citations (SSE)
            │
            ▼
      Final streaming generation with all accumulated context (SSE)
```

---

## 6. Anchor Chunk System

### What we built

Users can click chunks in the PDF viewer to "anchor" them. Selected chunks are:

1. Fetched directly from ChromaDB by ID (bypassing retrieval entirely)
2. Injected into the LLM's user message as `[ANCHOR CHUNK]` blocks before the question
3. Governed by a system prompt rule: answer from the anchor if possible; only call tools for explicit cross-reference questions ("where else", "compare", "other sections")

Multiple chunks can be anchored simultaneously across different pages or documents.

### Why

This makes the RAG system **user-steerable**. Standard retrieval is probabilistic — the model retrieves what it thinks is relevant. But for financial analysis, the user often already knows exactly which table or paragraph they care about. The anchor system lets them point at specific content and ask questions about it directly, bypassing the retrieval step for that content.

It also enables a natural workflow: browse the PDF → select an interesting chunk → ask "what does this mean?" or "where else is this figure referenced?" without having to paraphrase the content as a search query.

---

## 7. Frontend Architecture

### What we built

A React SPA with:

- **Document library** — lists indexed documents, shows filing type and chunk count
- **Chat interface** — streaming SSE consumer with status messages during tool calls
- **PDF viewer** — server-side rendered pages with bounding-box highlight overlay
- **Chunk selection** — click to anchor chunks from the PDF view into queries
- **Citation linking** — click a source citation in the chat to jump to the relevant page and highlight the source chunk
- **Saved prompts** — store and replay frequently used queries

### Key choice: server-side PDF rendering

`backend/services/pdf_renderer.py` renders PDF pages as PNG images server-side using PyMuPDF, served at `/pages/{doc_id}/{page_number}`. The frontend overlays bounding boxes from chunk metadata as absolutely-positioned `<div>` elements.

**Why not PDF.js (client-side)?**
Landing.ai returns bounding boxes in its own normalized coordinate space (0.0–1.0 relative to page dimensions). Mapping these onto a PDF.js canvas requires knowing the exact rendered page dimensions and DPI, which vary across devices and zoom levels. Server-side rendering to a fixed-size PNG makes the coordinate mapping deterministic — the overlay `<div>` positions are just `box_left * 100%` etc.

---

## Summary

### What this architecture optimises for

| Decision | Optimises for |
|---|---|
| Landing.ai parsing | Table accuracy, bounding boxes, section structure |
| Local MiniLM embeddings | Zero marginal cost, no network dependency at query time |
| ChromaDB | Single store for vector + keyword + metadata filtering |
| Tool-use retrieval loop | Flexibility across question types |
| Anchor chunk system | User control over retrieval context |
| Server-side PDF rendering | Deterministic bounding box coordinate mapping |
| SSE streaming | Low perceived latency on multi-step tool calls |

### Known limitations and future directions

| Limitation | Mitigation path |
|---|---|
| In-memory job state resets on server restart | Replace `_jobs` dict with a persistent job queue (e.g. Redis + Celery) |
| Single ChromaDB collection for all documents | Per-user or per-project collection isolation for multi-tenant use |
| MiniLM quality ceiling | Swap to `voyage-finance-2` or `text-embedding-3-small` for higher recall |
| No re-ranking | Add a cross-encoder re-ranker (e.g. `cross-encoder/ms-marco-MiniLM-L-6-v2`) after retrieval |
| No multi-document comparison | Extend `QueryRequest` to accept a list of `doc_ids` for cross-filing queries |
