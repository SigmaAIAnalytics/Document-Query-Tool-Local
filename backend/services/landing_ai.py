import os
import asyncio
import httpx
from dotenv import load_dotenv

load_dotenv()

JOBS_URL = "https://api.va.landing.ai/v1/ade/parse/jobs"
POLL_INTERVAL = 10  # seconds between status checks
MAX_WAIT = 3600     # 60 minutes max


async def submit_job(file_bytes: bytes, filename: str) -> str:
    """Submit PDF to Landing.ai and return job_id immediately."""
    api_key = os.getenv("LANDING_AI_API_KEY")
    if not api_key:
        raise RuntimeError("LANDING_AI_API_KEY not set")

    headers = {"Authorization": f"Basic {api_key}"}

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            JOBS_URL,
            headers=headers,
            files={"document": (filename, file_bytes, "application/pdf")},
        )
        if not response.is_success:
            raise RuntimeError(f"Landing.ai submit error {response.status_code}: {response.text}")

        job_data = response.json()
        job_id = (
            job_data.get("job_id")
            or job_data.get("data", {}).get("job_id")
            or job_data.get("id")
        )
        if not job_id:
            raise RuntimeError(f"No job_id in Landing.ai response: {job_data}")

        return job_id


async def poll_job(job_id: str) -> dict:
    """Poll a job until complete. Returns the raw completed response dict."""
    api_key = os.getenv("LANDING_AI_API_KEY")
    headers = {"Authorization": f"Basic {api_key}"}
    status_url = f"{JOBS_URL}/{job_id}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        elapsed = 0
        while elapsed < MAX_WAIT:
            await asyncio.sleep(POLL_INTERVAL)
            elapsed += POLL_INTERVAL

            poll = await client.get(status_url, headers=headers)
            if not poll.is_success:
                raise RuntimeError(f"Landing.ai poll error {poll.status_code}: {poll.text}")

            poll_data = poll.json()
            status = (
                poll_data.get("status")
                or poll_data.get("data", {}).get("status")
                or ""
            ).lower()
            progress = poll_data.get("progress", 0)

            print(f"[Landing.ai] job={job_id} status={status!r} progress={progress:.0%} elapsed={elapsed}s")

            if status in ("completed", "succeeded", "done", "success", "complete"):
                output_url = poll_data.get("output_url")
                if output_url:
                    output = await client.get(output_url)
                    if not output.is_success:
                        raise RuntimeError(f"Failed to fetch output: {output.status_code}: {output.text}")
                    return output.json()
                return poll_data

            if status in ("failed", "error", "cancelled"):
                reason = poll_data.get("failure_reason") or status
                raise RuntimeError(f"Landing.ai job failed: {reason}")

    raise RuntimeError(f"Landing.ai job {job_id} timed out after {MAX_WAIT}s")


def extract_chunks(data: dict) -> list[dict]:
    # Unwrap envelope if results are nested under "data"
    if isinstance(data.get("data"), dict) and "chunks" in data["data"]:
        data = data["data"]

    raw_chunks = data.get("chunks") or []

    if raw_chunks and isinstance(raw_chunks, list):
        chunks = []
        for i, chunk in enumerate(raw_chunks):
            text = chunk.get("markdown") or chunk.get("text") or chunk.get("content") or ""
            # grounding is a dict with {"box": {...}, "page": N} — page is 0-indexed
            grounding = chunk.get("grounding") or {}
            page_num = grounding.get("page", i)
            if isinstance(page_num, (int, float)):
                page_num = int(page_num) + 1  # convert to 1-indexed
            else:
                page_num = i + 1
            # Strip HTML anchor tags Landing.ai injects
            clean_text = _strip_anchors(text)
            if clean_text:
                chunks.append({"text": clean_text, "page": page_num, "chunk_index": i})
        if chunks:
            return chunks

    # Fallback: split full markdown by double newline
    markdown = _strip_anchors(data.get("markdown") or "")
    if markdown:
        sections = [s.strip() for s in markdown.split("\n\n") if s.strip()]
        return [{"text": s, "page": i + 1, "chunk_index": i} for i, s in enumerate(sections)]

    return [{"text": str(data), "page": 1, "chunk_index": 0}]


def _strip_anchors(text: str) -> str:
    import re
    return re.sub(r"<a [^>]+></a>\n?", "", text).strip()
