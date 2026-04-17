"""
One-time script to index an already-completed Landing.ai job into ChromaDB.
Usage: python index_completed_job.py <landing_job_id> <filename> [company_name]
"""
import sys
import asyncio
import os
import httpx
from dotenv import load_dotenv

load_dotenv()

JOBS_URL = "https://api.va.landing.ai/v1/ade/parse/jobs"


async def main():
    if len(sys.argv) < 3:
        print("Usage: python index_completed_job.py <job_id> <filename> [company_name]")
        sys.exit(1)

    job_id = sys.argv[1]
    filename = sys.argv[2]
    company_name = sys.argv[3] if len(sys.argv) > 3 else filename.rsplit(".", 1)[0]

    api_key = os.getenv("LANDING_AI_API_KEY")
    headers = {"Authorization": f"Basic {api_key}"}

    print(f"Fetching job {job_id}...")
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(f"{JOBS_URL}/{job_id}", headers=headers)
        r.raise_for_status()
        job = r.json()

    status = job.get("status", "").lower()
    print(f"Status: {status}")
    if status != "completed":
        print(f"Job is not completed yet (status={status}). Try again later.")
        sys.exit(1)

    output_url = job.get("output_url")
    if not output_url:
        print("No output_url in response.")
        sys.exit(1)

    print("Downloading output...")
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.get(output_url)
        r.raise_for_status()
        data = r.json()

    # Import services (must run from backend/)
    from services.landing_ai import extract_chunks
    from services.embedder import embed
    from services.chroma_client import get_collection
    import uuid

    chunks = extract_chunks(data)
    print(f"Extracted {len(chunks)} chunks")

    if not chunks:
        print("No chunks extracted.")
        sys.exit(1)

    filing_type = "10-K" if "10-K" in filename.upper() or "10K" in filename.upper() else \
                  "8-K" if "8-K" in filename.upper() or "8K" in filename.upper() else "Unknown"
    doc_id = str(uuid.uuid4())

    print("Embedding and indexing...")
    texts = [c["text"] for c in chunks]
    embeddings = embed(texts)

    collection = get_collection()
    ids = [f"{doc_id}_chunk_{c['chunk_index']}" for c in chunks]
    metadatas = [
        {
            "doc_id": doc_id,
            "filename": filename,
            "company_name": company_name,
            "filing_type": filing_type,
            "page": c["page"],
            "chunk_index": c["chunk_index"],
        }
        for c in chunks
    ]
    collection.add(ids=ids, embeddings=embeddings, documents=texts, metadatas=metadatas)

    print(f"\nDone! Indexed {len(chunks)} chunks")
    print(f"  doc_id:       {doc_id}")
    print(f"  company_name: {company_name}")
    print(f"  filing_type:  {filing_type}")
    print(f"  filename:     {filename}")


asyncio.run(main())
