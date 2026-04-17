import { useState } from "react";
import { deleteDocument } from "../api";

const FILING_COLORS = {
  "10-K": "bg-blue-100 text-blue-700",
  "8-K": "bg-purple-100 text-purple-700",
  Unknown: "bg-gray-100 text-gray-600",
};

export default function DocumentLibrary({ documents, onDeleted, onSelectDoc, selectedDocId }) {
  const [deleting, setDeleting] = useState(null);

  const handleDelete = async (doc) => {
    if (!window.confirm(`Delete "${doc.filename}"?`)) return;
    setDeleting(doc.doc_id);
    try {
      await deleteDocument(doc.doc_id);
      onDeleted?.();
    } catch (err) {
      alert(err.message);
    } finally {
      setDeleting(null);
    }
  };

  if (!documents.length) {
    return (
      <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Document Library</h2>
        <p className="text-sm text-gray-400 text-center py-6">No filings uploaded yet.</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">
        Document Library
        <span className="ml-2 text-xs text-gray-400 font-normal">({documents.length} filing{documents.length !== 1 ? "s" : ""})</span>
      </h2>
      <ul className="space-y-2">
        {documents.map((doc) => (
          <li
            key={doc.doc_id}
            onClick={() => onSelectDoc?.(selectedDocId === doc.doc_id ? null : doc.doc_id)}
            className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-colors ${
              selectedDocId === doc.doc_id
                ? "border-blue-400 bg-blue-50"
                : "border-gray-100 hover:border-gray-300 hover:bg-gray-50"
            }`}
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-xl shrink-0">📋</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{doc.company_name}</p>
                <p className="text-xs text-gray-400 truncate">{doc.filename}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  FILING_COLORS[doc.filing_type] || FILING_COLORS.Unknown
                }`}
              >
                {doc.filing_type}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(doc); }}
                disabled={deleting === doc.doc_id}
                className="text-gray-300 hover:text-red-500 transition-colors disabled:opacity-40 text-lg leading-none"
                title="Delete"
              >
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
      {selectedDocId && (
        <p className="mt-3 text-xs text-blue-600 text-center">
          Filtering chat to selected document. Click again to deselect.
        </p>
      )}
    </div>
  );
}
