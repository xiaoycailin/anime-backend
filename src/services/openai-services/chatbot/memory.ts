import { normalizeChatbotMessages } from "./skills";

export function buildChatbotMemory(input: { messages?: unknown }) {
  return {
    recentMessages: normalizeChatbotMessages(input.messages),
  };
}
