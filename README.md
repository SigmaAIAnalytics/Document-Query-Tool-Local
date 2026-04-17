# SEC Filings RAG

Upload and query SEC 10-K and 8-K filings using Retrieval-Augmented Generation.

**Stack:** FastAPI · Landing.ai ADE · ChromaDB · Anthropic Claude · React · Tailwind CSS

---

## Setup

### 1. Clone and configure environment

```bash
cp .env.example .env
# Edit .env and add your API keys:
#   LANDING_AI_API_KEY=...
#   ANTHROPIC_API_KEY=...
```

### 2. Backend

```bash
cd backend

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Start the server
uvicorn main:app --reload --port 8000
```

The API will be available at http://localhost:8000  
Interactive docs: http://localhost:8000/docs

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

The app will be available at http://localhost:5173

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/documents/upload` | Upload a PDF filing (multipart/form-data: `file`, optional `company_name`) |
| GET | `/documents` | List all indexed documents |
| DELETE | `/documents/{doc_id}` | Remove a document and all its chunks |
| POST | `/query` | Ask a question (`{"question": "...", "doc_id": null}`) — returns SSE stream |

## Usage

1. Upload a 10-K or 8-K PDF via the drag-and-drop panel
2. Wait for parsing and indexing (Landing.ai extracts text, ChromaDB stores embeddings)
3. Ask questions in the chat panel — Claude answers with page-level citations
4. Click a document in the library to scope queries to that filing only

## Notes

- ChromaDB data is persisted in `backend/chroma_data/`
- Filing type (10-K / 8-K) is inferred from the filename; name files accordingly
- The `all-MiniLM-L6-v2` embedding model is downloaded automatically on first run (~80 MB)
