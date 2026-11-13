import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMemoryResource } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { Search } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import type { MemoryChatView } from "../../../types/memory-admin";
import {
  MemoryEmpty,
  MemoryErrorState,
  MemoryLoading,
  MemoryPagination,
  PAGE_SIZE,
  formatMemoryTime,
  roleLabel,
} from "./memory-common";

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
    <section className="flex min-w-0 flex-col gap-4" aria-label="会话原文">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="break-words font-semibold">
            {chat.title || "未命名会话"}
          </h3>
          <p className="break-all text-xs text-muted-foreground">
            会话 ID：{chat.id}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onBack}>
          返回会话列表
        </Button>
      </div>
      <form
        onSubmit={searchMessages}
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="memory-message-search">在本会话中搜索原文</Label>
          <Input
            id="memory-message-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={200}
            placeholder="输入原话关键词"
          />
        </div>
        <Button type="submit">
          <Search data-icon="inline-start" />
          搜索原文
        </Button>
        {query ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSearch("");
              setQuery("");
              setPage(1);
            }}
          >
            清除搜索
          </Button>
        ) : null}
      </form>
      {messages.loading ? (
        <MemoryLoading label="正在读取对话原文…" />
      ) : messages.error ? (
        <MemoryErrorState message={messages.error} retry={messages.refresh} />
      ) : messages.data?.items.length ? (
        <div className="flex min-w-0 flex-col gap-4">
          {messages.data.items.map((message) => (
            <Card key={`${message.id}:${message.revision}`}>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={message.role === "user" ? "default" : "secondary"}
                  >
                    {roleLabel(message.role)}
                  </Badge>
                  <Badge variant="outline">版本 {message.revision}</Badge>
                  <Badge variant="outline">
                    {message.processedRevision >= message.revision
                      ? "本版已处理"
                      : "等待整理"}
                  </Badge>
                </div>
                <CardDescription>
                  {formatMemoryTime(message.createdAt)}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {message.content || "（这条消息没有文字正文）"}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  消息 ID：{message.id}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <MemoryEmpty
          title={query ? "没有找到匹配的原文" : "这段会话还没有消息"}
          description={
            query
              ? "换一个关键词，或清除搜索查看完整会话。"
              : "完成下一轮同步后刷新页面。"
          }
        />
      )}
      {!messages.error && messages.data ? (
        <MemoryPagination
          page={messages.data.page}
          pageSize={messages.data.pageSize}
          total={messages.data.total}
          loading={messages.loading}
          onPage={setPage}
        />
      ) : null}
    </section>
  );
}

export function MemoryChats({ revision }: { revision: number }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MemoryChatView | null>(null);
  const load = useCallback(
    (signal: AbortSignal) =>
      memoryApi.chats({ query, page, pageSize: PAGE_SIZE }, signal),
    [query, page]
  );
  const chats = useMemoryResource(load, selected === null, revision);
  function searchChats(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(search.trim());
    setPage(1);
  }
  if (selected)
    return (
      <ChatMessages
        key={selected.id}
        chat={selected}
        revision={revision}
        onBack={() => setSelected(null)}
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        这里展示已同步到本机的对话原文。选择会话，可以查看每条消息的角色、时间和版本。
      </p>
      <form
        onSubmit={searchChats}
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="memory-chat-search">搜索会话</Label>
          <Input
            id="memory-chat-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={200}
            placeholder="搜索会话标题或原文关键词"
          />
        </div>
        <Button type="submit">
          <Search data-icon="inline-start" />
          搜索会话
        </Button>
        {query ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setSearch("");
              setQuery("");
              setPage(1);
            }}
          >
            清除搜索
          </Button>
        ) : null}
      </form>
      {chats.loading ? (
        <MemoryLoading label="正在读取会话列表…" />
      ) : chats.error ? (
        <MemoryErrorState message={chats.error} retry={chats.refresh} />
      ) : chats.data?.items.length ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {chats.data.items.map((chat) => (
            <Card key={chat.id} className="flex min-w-0 flex-col">
              <CardHeader>
                <CardTitle>{chat.title || "未命名会话"}</CardTitle>
                <CardDescription>
                  {formatMemoryTime(chat.lastMessageAt)}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {chat.preview || "暂无文字预览"}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">{chat.messageCount} 条消息</Badge>
                  {chat.pendingCount > 0 ? (
                    <Badge variant="outline">
                      {chat.pendingCount} 条待整理
                    </Badge>
                  ) : null}
                </div>
              </CardContent>
              <CardFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelected(chat)}
                >
                  查看原文
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : (
        <MemoryEmpty
          title={query ? "没有找到匹配的会话" : "还没有同步的对话"}
          description={
            query
              ? "试试其他关键词，或清除搜索。"
              : "请在设置中配置官方历史凭据，再同步对话历史。同步成功后，会话会出现在这里。"
          }
        />
      )}
      {!chats.error && chats.data ? (
        <MemoryPagination
          page={chats.data.page}
          pageSize={chats.data.pageSize}
          total={chats.data.total}
          loading={chats.loading}
          onPage={setPage}
        />
      ) : null}
    </div>
  );
}
