import { useState, useRef, useEffect } from "react";
import { streamQuery } from "../api";

function CitationBadge({ citation }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-blue-50 border border-blue-200 text-blue-700 rounded px-2 py-0.5 mr-1 mb-1">
      <span className="font-medium">{citation.filing_type}</span>
      <span className="text-blue-400">·</span>
      <span className="truncate max-w-[140px]">{citation.company_name || citation.filename}</span>
      <span className="text-blue-400">·</span>
      <span>p.{citation.page}</span>
    </span>
  );
}

function Message({ msg }) {
  return (
    <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
          msg.role === "user"
            ? "bg-blue-600 text-white rounded-br-sm"
            : "bg-white border border-gray-200 text-gray-800 rounded-bl-sm shadow-sm"
        }`}
      >
        <p className="whitespace-pre-wrap">{msg.content}</p>
        {msg.citations?.length > 0 && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <p className="text-xs text-gray-400 mb-1.5 font-medium uppercase tracking-wide">Sources</p>
            <div className="flex flex-wrap">
              {msg.citations.map((c, i) => (
                <CitationBadge key={i} citation={c} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatInterface({ selectedDocId, documents }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const bottomRef = useRef();
  const inputRef = useRef();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const selectedDoc = documents?.find((d) => d.doc_id === selectedDocId);

  const handleSend = async () => {
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setError(null);
    const userMsg = { role: "user", content: question };
    setMessages((prev) => [...prev, userMsg]);

    const assistantId = Date.now();
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", citations: [] },
    ]);
    setLoading(true);

    try {
      let citations = [];
      for await (const chunk of streamQuery(question, selectedDocId)) {
        if (chunk.type === "citations") {
          citations = chunk.citations;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, citations } : m
            )
          );
        } else if (chunk.type === "text") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + chunk.text } : m
            )
          );
        }
      }
    } catch (err) {
      setError(err.message);
      setMessages((prev) => prev.filter((m) => m.id !== assistantId));
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col h-full min-h-[520px]">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-800">Ask the Filings</h2>
        {selectedDoc && (
          <span className="text-xs bg-blue-50 border border-blue-200 text-blue-700 px-2 py-1 rounded-lg truncate max-w-[200px]">
            Scoped: {selectedDoc.company_name || selectedDoc.filename}
          </span>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="text-center text-sm text-gray-400 mt-10">
            <p className="text-3xl mb-3">💬</p>
            <p>Ask a question about your SEC filings.</p>
            <p className="mt-1 text-xs">e.g. "What were the key risk factors in the 10-K?"</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <Message key={msg.id || i} msg={msg} />
        ))}
        {loading && messages[messages.length - 1]?.content === "" && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
              <span className="inline-flex gap-1">
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce [animation-delay:300ms]" />
              </span>
            </div>
          </div>
        )}
        {error && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-6 py-4 border-t border-gray-100">
        <div className="flex gap-3 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            rows={1}
            placeholder="Ask a question… (Enter to send, Shift+Enter for newline)"
            className="flex-1 resize-none border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-400 max-h-32 overflow-y-auto"
            style={{ height: "auto" }}
            disabled={loading}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="shrink-0 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-xl px-5 py-3 text-sm font-medium transition-colors"
          >
            {loading ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
