import os
import json
import anthropic
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from services.embedder import embed
from services.chroma_client import get_collection
from typing import AsyncGenerator

load_dotenv()

router = APIRouter()

TOP_K = 8

SYSTEM_PROMPT = """You are a financial analyst assistant specializing in SEC filings (10-K and 8-K reports).
Answer questions using only the provided document excerpts. Be precise and cite your sources.

When citing sources, always include the document name and page number in this format: [Source: <filename>, page <page>]
If multiple chunks support an answer, cite all relevant sources.
If the provided context does not contain enough information to answer, say so clearly."""


class QueryRequest(BaseModel):
    question: str
    doc_id: str | None = None  # optional: limit to a specific document


@router.post("/query")
async def query_documents(req: QueryRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not set")

    # Retrieve relevant chunks
    collection = get_collection()
    query_embedding = embed([req.question])[0]

    # Cap n_results to what's actually in the collection to avoid ChromaDB error
    total = collection.count()
    if total == 0:
        raise HTTPException(status_code=404, detail="No documents indexed yet. Please upload filings first.")
    n_results = min(TOP_K, total)

    query_kwargs = dict(
        query_embeddings=[query_embedding],
        n_results=n_results,
        include=["documents", "metadatas", "distances"],
    )
    if req.doc_id:
        query_kwargs["where"] = {"doc_id": req.doc_id}

    try:
        results = collection.query(**query_kwargs)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"ChromaDB query error: {exc}")

    docs = results.get("documents", [[]])[0]
    metas = results.get("metadatas", [[]])[0]

    if not docs:
        raise HTTPException(status_code=404, detail="No relevant chunks found for this query.")

    # Build context string
    context_parts = []
    citations = []
    for i, (doc, meta) in enumerate(zip(docs, metas)):
        filename = meta.get("filename", "unknown")
        page = meta.get("page", "?")
        company = meta.get("company_name", "")
        filing_type = meta.get("filing_type", "")
        header = f"[Excerpt {i+1} | {filename} | Page {page}]"
        context_parts.append(f"{header}\n{doc}")
        citations.append({
            "excerpt_index": i + 1,
            "filename": filename,
            "page": page,
            "company_name": company,
            "filing_type": filing_type,
        })

    context = "\n\n---\n\n".join(context_parts)
    user_message = f"Context from SEC filings:\n\n{context}\n\n---\n\nQuestion: {req.question}"

    client = anthropic.AsyncAnthropic(api_key=api_key)

    async def generate() -> AsyncGenerator[str, None]:
        try:
            yield f"data: {json.dumps({'type': 'citations', 'citations': citations})}\n\n"

            async with client.messages.stream(
                model="claude-sonnet-4-6",
                max_tokens=1500,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_message}],
            ) as stream:
                async for text in stream.text_stream:
                    yield f"data: {json.dumps({'type': 'text', 'text': text})}\n\n"

            yield "data: [DONE]\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
