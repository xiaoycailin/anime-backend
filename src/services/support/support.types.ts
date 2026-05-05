export type SupportConversationStatus =
  | "ai_active"
  | "needs_human"
  | "human_active"
  | "resolved";

export type SupportConversationPriority = "normal" | "high" | "urgent";

export type SupportMessageSenderType = "user" | "ai" | "admin" | "system";

export type SupportMessageSource = "app" | "telegram" | "ai";

export type SupportConversationMeta = {
  id: string;
  userId: number;
  status: SupportConversationStatus;
  priority: SupportConversationPriority;
  assignedAdminId: number | null;
  lastMessageAt: number | null;
  lastUserMessageAt: number | null;
  lastAgentMessageAt: number | null;
  unreadUser: number;
  unreadAdmin: number;
  telegramChatId: string | null;
  telegramThreadId: string | null;
  lastTelegramMessageId: string | null;
  lastFlushedAt: number | null;
  lastFlushedMessageTs: number | null;
  aiFailures: number;
  createdAt: number;
  updatedAt: number;
};

export type SupportMessagePayload = {
  id: string;
  conversationId: string;
  senderType: SupportMessageSenderType;
  senderUserId: number | null;
  senderDisplay: {
    username: string;
    name: string;
    role: "user" | "admin" | "ai" | "system";
  };
  content: string;
  source: SupportMessageSource;
  actions?: Array<{
    type: "handoff";
    label: string;
  }>;
  createdAt: number;
};

export type SupportConversationEnvelope = {
  meta: SupportConversationMeta;
  messages: SupportMessagePayload[];
  serverTime: number;
  nextCursor: string | null;
};

export type SupportListConversationsRow = {
  id: string;
  userId: number;
  username: string;
  fullName: string | null;
  avatar: string | null;
  status: SupportConversationStatus;
  priority: SupportConversationPriority;
  assignedAdminId: number | null;
  lastMessageAt: number | null;
  unreadUser: number;
  unreadAdmin: number;
  updatedAt: number;
};
