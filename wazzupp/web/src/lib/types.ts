export interface Me {
  id: string; username: string; email: string | null; phone: string | null; displayName: string; bio: string; statusText: string;
  avatarMediaId: string | null; emailVerified: boolean; phoneVerified: boolean; mfaEnabled: boolean; role: string;
  settings: Settings; settingsVersion: number;
}
export interface Settings {
  privacy: { lastSeen: string; online: string; profilePhoto: string; about: string; phoneVisible: string; readReceipts: boolean; groupInvites: string; statusAudience: string; linkPreviews: boolean; discoverable: boolean };
  notifications: { messages: boolean; groups: boolean; calls: boolean; previews: boolean; sound: boolean; quietHours: { enabled: boolean; start: string; end: string; utcOffsetMinutes: number } };
  appearance: { theme: 'system' | 'light' | 'dark'; fontSize: 'sm' | 'md' | 'lg'; wallpaper: 'doodle' | 'plain' | 'emerald'; language: string };
  media: { autoDownloadImages: boolean; autoDownloadVideos: boolean; autoDownloadDocuments: boolean; dataSaver: boolean };
  statusTtlHours: number;
}
export interface MediaInfo { id: string; kind: string; mime: string; size: number; name: string | null; width: number | null; height: number | null; durationMs: number | null; waveform: number[] | null; hasThumb: boolean }
export interface Reaction { userId: string; emoji: string }
export interface Msg {
  id: string; conversationId: string; seq: number; senderId: string | null; clientMsgId: string; kind: string; body: string; meta: Record<string, any>;
  media: MediaInfo | null; replyTo: { id: string; senderId: string | null; kind: string; body: string; deleted: boolean } | null; forwarded: boolean; mentions: string[];
  createdAt: string; editedAt: string | null; deleted: boolean; expiresAt: string | null; pinned: boolean;
  status?: 'sending' | 'queued' | 'failed' | 'sent' | 'delivered' | 'read'; reactions?: Reaction[]; starred?: boolean; votes?: Array<{ userId: string; option: number }>;
  local?: boolean; undelivered?: boolean; senderName?: string | null;
}
export interface Other { id: string; username: string; displayName: string; avatarMediaId: string | null; statusText: string | null; lastSeenAt: string | null; blockedByMe: boolean }
export interface Conv {
  id: string; kind: 'direct' | 'group' | 'channel' | 'announcement'; title: string | null; description: string; avatarMediaId: string | null; announceOnly: boolean;
  membersCanEditInfo: boolean; membersCanInvite: boolean; disappearingSeconds: number | null; communityId: string | null; isPublic: boolean; lastSeq: number; memberCount: number;
  role: string; other: Other | null; lastMessage: Msg | null; lastMessageAt: string | null; unread: number; unreadMentions: number; markedUnread: boolean; muted: boolean;
  mutedUntil: string | null; archived: boolean; pinned: boolean; favorite: boolean; folder: string | null; draft: string | null; version: number; lastReadSeq: number;
}
export interface Member { id: string; username: string; displayName: string; role: string; avatarMediaId: string | null; statusText: string | null }
export interface CallRec { id: string; conversationId: string; initiatorId: string; kind: 'audio' | 'video'; state: string; createdAt: string; answeredAt: string | null; connectedAt: string | null; endedAt: string | null; endReason: string | null }
export interface CallHistory extends CallRec { direction: 'incoming' | 'outgoing'; other: { id: string; displayName: string; username: string; avatarMediaId: string | null }; durationSec: number }
export interface StatusItem { id: string; kind: 'text' | 'image' | 'video'; body: string; caption: string; background: string | null; mediaId: string | null; createdAt: string; expiresAt: string; viewed: boolean; reaction: string | null }
export interface StatusGroup { userId: string; username: string; displayName: string; avatarMediaId: string | null; muted: boolean; allViewed: boolean; latestAt: string; items: StatusItem[] }
export interface Community { id: string; name: string; description: string; visibility: string; avatarMediaId: string | null; members: number; role: string | null; announcementConversationId: string | null; groups: Array<{ id: string; title: string; avatarMediaId: string | null; kind: string; memberCount: number; joined: boolean }> }
export interface Notif { id: string; kind: string; conversationId: string | null; payload: any; createdAt: string; read: boolean }
export interface Contact { id: string; username: string; displayName: string; alias: string | null; favorite: boolean; avatarMediaId: string | null; statusText: string | null }
