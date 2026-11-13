import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMemoryResource } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { ArrowLeft, Search } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import type {
  MemoryChatView,
  MemorySourceView,
} from "../../../types/memory-admin";
import {
  MemoryErrorState,
  MemoryLoading,
  MemoryPagination,
  MemorySourceBadge,
  PAGE_SIZE,
  formatMemorySourceTime,
  roleLabel,
} from "./memory-common";

function chatDate(value: string | null) {
  if (!value) return "未记录日期";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "未记录日期"
    : date.toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
}

function MessageBubble({ message }: { message: MemorySourceView }) {
  const tool = message.role === "tool" || message.role === "system";
  return (
    <article
      className={`memory-message ${message.role === "user" ? "memory-message-user" : ""}`}
      aria-label={`${roleLabel(message.role)}消息`}
    >
      <span className="text-xs text-muted-foreground">
        {roleLabel(message.role)}
      </span>
      <div className="memory-bubble">
        {tool ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              {roleLabel(message.role)}内容
            </summary>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7">
              {message.content || "（没有文字正文）"}
            </p>
          </details>
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-7">
            {message.content || "（这条消息没有文字正文）"}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{formatMemorySourceTime(message)}</span>
        <details className="min-w-0">
          <summary className="cursor-pointer">详情</summary>
          <div className="flex max-w-full flex-col items-start gap-2 py-2 text-xs">
            <MemorySourceBadge message={message} />
            <span>
              版本 {message.revision} ·{" "}
              {message.processedRevision >= message.revision
                ? "本版已处理"
                : "等待整理"}
            </span>
            <span className="break-all">消息 ID：{message.id}</span>
          </div>
        </details>
      </div>
    </article>
  );
}

function ChatMessages({
  chat,
  revision,
  onBack,
}: { chat: MemoryChatView; revision: number; onBack: () => void }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const load = useCallback(
    (signal: AbortSignal) =>
      memoryApi.messages(
        { chatId: chat.id, query, page, pageSize: PAGE_SIZE },
        signal
      ),
    [chat.id, query, page]
  );
  const messages = useMemoryResource(load, true, revision);
  function searchMessages(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(search.trim());
    setPage(1);
  }
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label="会话原文"
    >
      <header className="flex shrink-0 flex-col gap-3 border-b px-4 py-4 sm:px-6">
        <div className="flex items-center gap-2">
          <Button
            className="md:hidden"
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label="返回会话列表"
          >
            <ArrowLeft />
          </Button>
          <h3 className="min-w-0 flex-1 truncate font-semibold">
            {chat.title || "未命名会话"}
          </h3>
          <span className="shrink-0 text-xs text-muted-foreground">
            {chat.messageCount} 条消息
          </span>
        </div>
        <form onSubmit={searchMessages} className="flex gap-2">
          <Input
            aria-label="在本会话中搜索原文"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={200}
            placeholder="搜索这段对话"
            className="h-8 bg-background"
          />
          <Button
            size="icon"
            variant="ghost"
            type="submit"
            className="size-8 shrink-0"
            aria-label="搜索原文"
          >
            <Search className="size-4" />
          </Button>
          {query ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setSearch("");
                setQuery("");
                setPage(1);
              }}
            >
              清除
            </Button>
          ) : null}
        </form>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6"
        key={`${chat.id}:${page}:${query}`}
      >
        {messages.loading ? (
          <MemoryLoading label="正在读取对话…" />
        ) : messages.error ? (
          <MemoryErrorState message={messages.error} retry={messages.refresh} />
        ) : messages.data?.items.length ? (
          <div className="flex flex-col gap-5">
            {[...messages.data.items].reverse().map((message) => (
              <MessageBubble
                key={`${message.id}:${message.revision}`}
                message={message}
              />
            ))}
          </div>
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {query
              ? "没有找到匹配的原文，试试其他关键词。"
              : "这段会话还没有消息。"}
          </p>
        )}
      </div>
      {!messages.error && messages.data ? (
        <footer className="memory-chat-pagination shrink-0 border-t px-4 pb-3 pt-1 sm:px-6">
          <MemoryPagination
            page={messages.data.page}
            pageSize={messages.data.pageSize}
            total={messages.data.total}
            loading={messages.loading}
            onPage={setPage}
          />
          {messages.data.total > messages.data.pageSize ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              从最近一页开始，每页按对话顺序阅读。
            </p>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

export function MemoryChats({ revision }: { revision: number }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MemoryChatView | null>(null);
  const [reading, setReading] = useState(false);
  const load = useCallback(
    (signal: AbortSignal) =>
      memoryApi.chats({ query, page, pageSize: PAGE_SIZE }, signal),
    [query, page]
  );
  const chats = useMemoryResource(load, true, revision);
  const activeChat = selected ?? chats.data?.items[0];
  function searchChats(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(search.trim());
    setPage(1);
    setSelected(null);
    setReading(false);
  }
  return (
    <div className="management-panel memory-conversations">
      <aside
        aria-label="会话列表"
        className={`memory-chat-sidebar ${reading ? "hidden md:flex" : "flex"}`}
      >
        <form
          onSubmit={searchChats}
          className="flex shrink-0 gap-1 border-b p-3"
        >
          <Input
            aria-label="搜索会话"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={200}
            placeholder="搜索标题或对话"
            className="border-0 bg-transparent shadow-none"
          />
          <Button
            variant="ghost"
            size="icon"
            type="submit"
            aria-label="搜索会话"
            className="shrink-0"
          >
            <Search className="size-4" />
          </Button>
        </form>
        {query ? (
          <div className="flex items-center justify-between gap-2 px-4 pt-2 text-xs">
            <span className="truncate text-muted-foreground">
              “{query}” 的结果
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery("");
                setSearch("");
                setPage(1);
                setSelected(null);
              }}
            >
              清除
            </Button>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {chats.loading ? (
            <MemoryLoading label="正在读取会话…" />
          ) : chats.error ? (
            <MemoryErrorState message={chats.error} retry={chats.refresh} />
          ) : chats.data?.items.length ? (
            chats.data.items.map((chat, index, items) => (
              <div key={chat.id}>
                {index === 0 ||
                chatDate(items[index - 1].lastMessageAt) !==
                  chatDate(chat.lastMessageAt) ? (
                  <h3 className="px-3 pb-2 pt-4 text-xs font-medium text-muted-foreground">
                    {chatDate(chat.lastMessageAt)}
                  </h3>
                ) : null}
                <button
                  type="button"
                  className={`memory-chat-choice ${activeChat?.id === chat.id ? "memory-chat-selected" : ""}`}
                  aria-pressed={activeChat?.id === chat.id}
                  aria-label={`查看原文：${chat.title || "未命名会话"}`}
                  onClick={() => {
                    setSelected(chat);
                    setReading(true);
                  }}
                >
                  <span className="line-clamp-2 font-medium leading-6">
                    {chat.title || "未命名会话"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {chat.messageCount} 条消息
                  </span>
                </button>
              </div>
            ))
          ) : (
            <p className="px-3 py-12 text-center text-sm leading-6 text-muted-foreground">
              {query
                ? "没有找到匹配的会话。"
                : "还没有保存的对话。配置角色记录规则后，记录会出现在这里。"}
            </p>
          )}
        </div>
        {!chats.error && chats.data ? (
          <div className="memory-chat-pagination shrink-0 border-t px-3 pb-3 pt-1">
            <MemoryPagination
              page={chats.data.page}
              pageSize={chats.data.pageSize}
              total={chats.data.total}
              loading={chats.loading}
              onPage={(next) => {
                setPage(next);
                setSelected(null);
                setReading(false);
              }}
            />
          </div>
        ) : null}
      </aside>
      <div
        className={`min-h-0 min-w-0 flex-col ${reading ? "flex" : "hidden md:flex"}`}
      >
        {activeChat ? (
          <ChatMessages
            key={activeChat.id}
            chat={activeChat}
            revision={revision}
            onBack={() => setReading(false)}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
            选择一段对话，开始阅读
          </div>
        )}
      </div>
    </div>
  );
}
