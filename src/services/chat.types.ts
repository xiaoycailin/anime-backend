import type { EquippedDecorationDTO } from "./decoration.service";

export type ChatUserSnapshot = {
  id: number;
  name: string;
  username: string;
  fullName: string | null;
  avatar: string | null;
  isVerified: boolean;
  verifiedAt: string | null;
  level: number;
  nageTag: EquippedDecorationDTO;
  frame: EquippedDecorationDTO;
  role: string;
};

export type ChatContextType = "anime" | "episode";

export type ChatContextPayload = {
  type: ChatContextType;
  id: string;
  title: string;
  animeTitle: string | null;
  thumbnail: string | null;
  description: string | null;
  slug: string;
  animeSlug: string | null;
  url: string;
};

export type ChatAllowedLink = {
  url: string;
  rawText: string;
  host: string;
  path: string;
  preview: ChatContextPayload | null;
};

export type ChatReplyPreview = {
  id: string;
  senderId: string;
  senderName: string;
  senderUsername?: string;
  senderFullName?: string | null;
  content: string;
  deletedAt: number | null;
};

export type ChatMessagePayload = {
  id: string;
  roomId: string;
  senderId: string;
  sender: {
    id: string;
    name: string;
    username?: string;
    fullName?: string | null;
    avatar: string | null;
    isVerified: boolean;
    verifiedAt: string | null;
    level?: number;
    nageTag: EquippedDecorationDTO;
    frame: EquippedDecorationDTO;
    role: string | null;
  };
  senderName: string;
  senderUsername?: string;
  senderFullName?: string | null;
  senderLevel?: number;
  senderAvatar: string | null;
  senderNageTag: EquippedDecorationDTO;
  senderFrame: EquippedDecorationDTO;
  content: string;
  context: ChatContextPayload | null;
  contexts: ChatContextPayload[];
  links: ChatAllowedLink[];
  replyTo: ChatReplyPreview | null;
  type: "text" | "system";
  editedAt: number | null;
  deletedAt: number | null;
  deletedBy: string | null;
  deletedByRole: string | null;
  createdAt: number;
  expiresAt: number;
};

export type ChatSlowmodeSetting = {
  enabled: boolean;
  seconds: number;
  updatedBy: string | null;
  updatedAt: number;
};

export type ChatRoomDTO = {
  id: string;
  slug: string;
  type: string;
  title: string;
  description: string | null;
  avatar: string | null;
  isActive: boolean;
  lastMessageAt: number | null;
};

export type ChatSocketUser = {
  id: number;
  email?: string;
  username: string;
  fullName?: string | null;
  role: string;
};
