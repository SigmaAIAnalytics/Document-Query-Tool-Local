import { useState, useEffect } from "react";
import UploadPanel from "./components/UploadPanel";
import DocumentLibrary from "./components/DocumentLibrary";
import ChatInterface from "./components/ChatInterface";
import { listDocuments } from "./api";

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [selectedDocId, setSelectedDocId] = useState(null);

  const fetchDocs = async () => {
    try {
      const docs = await listDocuments();
      setDocuments(docs);
    } catch {
      // backend may not be running yet
    }
  };

  useEffect(() => {
    fetchDocs();
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">📊</span>
            <div>
              <h1 className="text-base font-bold text-gray-900 leading-none">SEC Filings RAG</h1>
              <p className="text-xs text-gray-400 mt-0.5">10-K &amp; 8-K Intelligence Platform</p>
            </div>
          </div>
          <span className="text-xs text-gray-400 hidden sm:block">
            Powered by Landing.ai · ChromaDB · Claude
          </span>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6 items-start">
        <div className="space-y-6">
          <UploadPanel onUploaded={fetchDocs} />
          <DocumentLibrary
            documents={documents}
            onDeleted={fetchDocs}
            onSelectDoc={setSelectedDocId}
            selectedDocId={selectedDocId}
          />
        </div>

        <ChatInterface
          selectedDocId={selectedDocId}
          documents={documents}
        />
      </main>
    </div>
  );
}
