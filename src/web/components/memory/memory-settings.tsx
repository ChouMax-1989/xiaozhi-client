import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { memoryError, useMemoryResource } from "@/hooks/useMemoryResource";
import { memoryApi } from "@/services/memoryApi";
import { ChevronRight, Download, KeyRound, Save } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import type { MemoryAdminSettings } from "../../../types/memory-admin";
import { MemoryErrorState, MemoryLoading } from "./memory-common";
import { MemoryRecordingRules } from "./memory-recording-rules";
import { MemoryRestartHint } from "./memory-restart-hint";

export function MemorySettings({
  ready,
  onChanged,
  legacyImport,
  recordingPrompt = "",
}: {
  ready: boolean;
  onChanged: () => void;
  legacyImport?: ReactNode;
  recordingPrompt?: string;
}) {
  const settings = useMemoryResource(memoryApi.settings);
  if (settings.loading) return <MemoryLoading label="正在读取设置…" />;
  if (settings.error)
    return (
      <MemoryErrorState message={settings.error} retry={settings.refresh} />
    );
  if (!settings.data) return null;
  return (
    <MemorySettingsForm
      settings={settings.data}
      ready={ready}
      legacyImport={legacyImport}
      recordingPrompt={recordingPrompt}
      onSaved={(value) => {
        settings.setData(value);
        onChanged();
      }}
      onCredentialSaved={() => {
        settings.refresh();
        onChanged();
      }}
    />
  );
}

export function MemorySettingsForm({
  settings,
  ready,
  onSaved,
  onCredentialSaved,
  legacyImport,
  recordingPrompt = "",
}: {
  settings: MemoryAdminSettings;
  ready: boolean;
  onSaved: (settings: MemoryAdminSettings) => void;
  onCredentialSaved: () => void;
  legacyImport?: ReactNode;
  recordingPrompt?: string;
}) {
  const [agentId, setAgentId] = useState(settings.agentId);
  const [ownerId, setOwnerId] = useState(settings.ownerId);
  const [automatic, setAutomatic] = useState(settings.syncIntervalSeconds > 0);
  const [interval, setInterval] = useState(
    String(settings.syncIntervalSeconds || 300)
  );
  const [maxRequests, setMaxRequests] = useState(
    String(settings.syncMaxRequests)
  );
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<"export" | "backup" | null>(
    null
  );
  const [backup, setBackup] = useState<{
    fileName: string;
    bytes: number;
  } | null>(null);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const seconds = automatic ? Number(interval) : 0;
    const requests = Number(maxRequests);
    if (!agentId.trim()) {
      setFormError("请填写小智智能体 ID。");
      return;
    }
    if (
      automatic &&
      (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 2147483)
    ) {
      setFormError("自动同步间隔应为 60 到 2147483 秒之间的整数。");
      return;
    }
    if (!Number.isSafeInteger(requests) || requests < 1 || requests > 1000) {
      setFormError("每轮请求上限应为 1 到 1000 之间的整数。");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const saved = await memoryApi.saveSettings({
        agentId: agentId.trim(),
        ownerId: ownerId.trim(),
        syncIntervalSeconds: seconds,
        syncMaxRequests: requests,
      });
      onSaved(saved);
      toast.success("记忆设置已保存，请重启服务使配置生效。");
    } catch (error) {
      setFormError(memoryError(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.trim()) return;
    const value = token.trim();
    setToken("");
    setSavingToken(true);
    setTokenError(null);
    try {
      await memoryApi.saveCredential(value);
      onCredentialSaved();
      toast.success("凭据已保存，输入框已清空。请按页面提示重启服务。");
    } catch (error) {
      setTokenError(memoryError(error));
    } finally {
      setSavingToken(false);
    }
  }

  async function download(kind: "export" | "backup") {
    setDownloadBusy(kind);
    try {
      if (kind === "export") {
        await memoryApi.export();
        toast.success("完整记忆数据已开始下载。");
      } else {
        const result = await memoryApi.backup();
        setBackup(result);
        await memoryApi.downloadBackup(result.fileName);
        toast.success("数据库备份已创建并开始下载。");
      }
    } catch (error) {
      toast.error(memoryError(error));
    } finally {
      setDownloadBusy(null);
    }
  }

  return (
    <div className="memory-settings flex min-w-0 flex-col gap-6">
      {settings.restartRequired ? (
        <Alert>
          <AlertTitle>设置已保存，等待重启</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <MemoryRestartHint containerMode={settings.containerMode} />
          </AlertDescription>
        </Alert>
      ) : null}
      <section
        aria-labelledby="memory-basic-heading"
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1">
          <h3 id="memory-basic-heading" className="font-semibold">
            基础设置
          </h3>
          <p className="text-sm text-muted-foreground">
            复制下方提示词，在小智的「角色介绍」中追加，或替换旧版记忆规则。保留原有人设，保存一次即可。
          </p>
        </div>
        <MemoryRecordingRules prompt={recordingPrompt} />
        <form
          id="memory-settings-form"
          onSubmit={saveSettings}
          className="flex flex-col gap-4"
        >
          {settings.identityLocked ? (
            <p className="text-sm text-muted-foreground">
              身份已绑定，以下标识只读，避免混入其他人的记忆。
            </p>
          ) : null}
          <div className="memory-setting-field">
            <Label htmlFor="memory-agent-id">小智智能体 ID（必填）</Label>
            <Input
              id="memory-agent-id"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              readOnly={settings.identityLocked}
              required
              maxLength={200}
              autoComplete="off"
            />
          </div>
          <div className="memory-setting-field">
            <Label htmlFor="memory-owner-id">记忆归属标识（选填）</Label>
            <div className="flex min-w-0 flex-col gap-2">
              <Input
                id="memory-owner-id"
                value={ownerId}
                onChange={(event) => setOwnerId(event.target.value)}
                readOnly={settings.identityLocked}
                maxLength={200}
                autoComplete="off"
                aria-describedby="memory-owner-help"
              />
              <p
                id="memory-owner-help"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                多人共用请留空，记忆按会话分开。
              </p>
            </div>
          </div>
          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>
              <Save data-icon="inline-start" />
              {saving ? "正在保存…" : "保存设置"}
            </Button>
          </div>
        </form>
      </section>
      <section
        aria-labelledby="memory-data-heading"
        className="memory-settings-section flex flex-col gap-3"
      >
        <h3 id="memory-data-heading" className="font-semibold">
          数据管理
        </h3>
        <p className="text-sm text-muted-foreground">
          导出与备份包含对话正文，请妥善保管。
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!ready || downloadBusy !== null}
            onClick={() => void download("export")}
          >
            <Download data-icon="inline-start" />
            {downloadBusy === "export" ? "正在导出…" : "导出完整 JSON"}
          </Button>
          <Button
            variant="outline"
            disabled={!ready || downloadBusy !== null}
            onClick={() => void download("backup")}
          >
            <Download data-icon="inline-start" />
            {downloadBusy === "backup" ? "正在备份…" : "创建并下载备份"}
          </Button>
        </div>
        {!ready ? (
          <p className="text-sm text-muted-foreground">
            服务就绪后可以导出和备份。
          </p>
        ) : null}
        {backup ? (
          <div className="flex flex-col items-start gap-1">
            <p className="break-all text-xs text-muted-foreground">
              最近备份：{backup.fileName}（
              {Math.max(1, Math.round(backup.bytes / 1024))} KB）
            </p>
            <Button
              variant="link"
              size="sm"
              disabled={downloadBusy !== null}
              onClick={() =>
                void memoryApi
                  .downloadBackup(backup.fileName)
                  .catch((error: unknown) => toast.error(memoryError(error)))
              }
            >
              重新下载这份备份
            </Button>
          </div>
        ) : null}
      </section>
      <details className="memory-disclosure memory-settings-section">
        <summary>
          <ChevronRight aria-hidden="true" />
          高级设置
        </summary>
        <div className="flex flex-col gap-5 pt-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="memory-database-path">数据库路径（只读）</Label>
            <Input
              id="memory-database-path"
              value={settings.databasePath || "首次保存设置后确定"}
              readOnly
            />
          </div>
          <section
            aria-labelledby="memory-import-heading"
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-1">
              <h4 id="memory-import-heading" className="text-sm font-semibold">
                可选：旧记录导入
              </h4>
              <p className="text-sm leading-relaxed text-muted-foreground">
                仅用于补入官方旧档案，需要有效的历史访问凭据。
              </p>
            </div>
            {legacyImport}
            <form onSubmit={saveToken} className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="memory-token">
                  {settings.tokenConfigured ? "替换访问 Token" : "访问 Token"}
                </Label>
                <Badge variant="outline">
                  {settings.tokenConfigured ? "已配置凭据" : "尚未配置凭据"}
                </Badge>
              </div>
              <Input
                id="memory-token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                disabled={savingToken || !settings.configured}
                aria-describedby="memory-token-help"
              />
              <p
                id="memory-token-help"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                填写历史接口的 Bearer 值，不含前缀；不是 MCP
                令牌。仅写入本机，不回显，提交后清空；留空保留现有凭据。
              </p>
              {!settings.configured ? (
                <p className="text-sm text-muted-foreground">
                  请先填写智能体 ID 并保存基础设置。
                </p>
              ) : null}
              {tokenError ? (
                <p role="alert" className="text-sm text-destructive">
                  {tokenError} 请重新输入凭据后重试。
                </p>
              ) : null}
              <Button
                type="submit"
                variant="outline"
                className="self-start"
                disabled={savingToken || !settings.configured || !token.trim()}
              >
                <KeyRound data-icon="inline-start" />
                {savingToken ? "正在保存…" : "保存凭据"}
              </Button>
            </form>
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="memory-auto-sync">自动同步对话历史</Label>
                <p
                  id="memory-auto-help"
                  className="text-xs text-muted-foreground"
                >
                  旧档案导入选项；只保存原文，不自动整理记忆。
                </p>
              </div>
              <Switch
                id="memory-auto-sync"
                checked={automatic}
                onCheckedChange={setAutomatic}
                aria-describedby="memory-auto-help"
              />
            </div>
            {automatic ? (
              <div className="memory-setting-field">
                <Label htmlFor="memory-sync-interval">同步间隔（秒）</Label>
                <Input
                  form="memory-settings-form"
                  id="memory-sync-interval"
                  type="number"
                  min={60}
                  max={2147483}
                  step={1}
                  value={interval}
                  onChange={(event) => setInterval(event.target.value)}
                  required
                />
              </div>
            ) : null}
            <div className="memory-setting-field">
              <Label htmlFor="memory-request-limit">每轮请求上限</Label>
              <Input
                form="memory-settings-form"
                id="memory-request-limit"
                type="number"
                min={1}
                max={1000}
                step={1}
                value={maxRequests}
                onChange={(event) => setMaxRequests(event.target.value)}
                required
              />
            </div>
            <p className="text-xs text-muted-foreground">
              范围 1–1000，达到上限后保留进度。
            </p>
            <Button
              type="submit"
              form="memory-settings-form"
              variant="outline"
              className="self-start"
              disabled={saving}
            >
              <Save data-icon="inline-start" />
              保存导入选项
            </Button>
          </section>
        </div>
      </details>
    </div>
  );
}
