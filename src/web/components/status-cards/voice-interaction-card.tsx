/**
 * 实时语音卡片组件
 *
 * 展示 ASR/LLM/TTS 配置状态，提供语音交互设置入口。
 */

import { ManagementStatus } from "@/components/management-page";
import { VoiceInteractionSettingDialog } from "@/components/voice-interaction-setting-dialog";
import { useVoiceInteractionConfig } from "@/stores/config";
import { useMemo } from "react";

/**
 * 检查 ASR 是否已配置
 */
function isASRReady(
  asr: { appid?: string; accessToken?: string } | undefined
): boolean {
  return Boolean(asr?.appid && asr?.accessToken);
}

/**
 * 检查 LLM 是否已配置
 */
function isLLMReady(
  llm: { model?: string; apiKey?: string; baseURL?: string } | undefined
): boolean {
  return Boolean(llm?.model && llm?.apiKey && llm?.baseURL);
}

/**
 * 检查 TTS 是否已配置
 */
function isTTSReady(
  tts: { appid?: string; accessToken?: string; voice_type?: string } | undefined
): boolean {
  return Boolean(tts?.appid && tts?.accessToken && tts?.voice_type);
}

/**
 * 实时语音卡片组件
 *
 * 显示 ASR/LLM/TTS 配置完成度，右上角显示配置完成度进度指示器。
 * 底部提供快速打开语音交互设置对话框的按钮。
 */
export function VoiceInteractionCard() {
  const { asr, llm, tts } = useVoiceInteractionConfig();

  // 计算已配置项数量
  const configuredCount = useMemo(() => {
    let count = 0;
    if (isASRReady(asr)) count++;
    if (isLLMReady(llm)) count++;
    if (isTTSReady(tts)) count++;
    return count;
  }, [asr, llm, tts]);

  const totalItems = 3;
  const completionRate = configuredCount / totalItems;

  // 生成状态描述
  const statusParts: string[] = [];
  if (isASRReady(asr)) statusParts.push("ASR");
  if (isLLMReady(llm)) statusParts.push("LLM");
  if (isTTSReady(tts)) statusParts.push("TTS");

  return (
    <ManagementStatus
      title="实时语音"
      value={`${configuredCount}/${totalItems} 就绪`}
      description={
        completionRate === 1
          ? "语音交互已就绪"
          : statusParts.length > 0
            ? `${statusParts.join("、")} 已配置`
            : "自建实时语音时按需配置"
      }
      actions={<VoiceInteractionSettingDialog />}
    />
  );
}
