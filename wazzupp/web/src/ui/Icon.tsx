import type { CSSProperties } from 'react';
import {
  Archive, ArrowLeft, AtSign, Ban, BarChart3, Bell, BellOff, Bold, BookmarkCheck, Calendar, Camera, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Circle, CircleDashed, Clock, Copy, Download,
  Eye, EyeOff, File, FileText, Forward, Globe, Hash, Headphones, HelpCircle, Image, Info, Languages, Link2, Lock, LogOut, MapPin, Megaphone, MessageSquare, MessageSquarePlus, Mic, MicOff, Monitor, MonitorUp, MoreVertical,
  Paintbrush, Palette, Paperclip, Pause, Pencil, Phone, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing, Pin, PinOff, Play, Plus, QrCode, Reply, Search, Send, Settings, Share2, Shield, ShieldCheck, SlidersHorizontal, Smartphone,
  Smile, Star, StickyNote, Sun, Moon, Trash2, Undo2, User, UserPlus, Users, Video, VideoOff, Volume2, X, Tablet, Laptop, Folder, Filter, RefreshCw, KeyRound, Flag, Edit3, Radio, SwitchCamera, ListChecks, Cloud, HardDrive, Database, Sparkles, Wifi, WifiOff, Mail, Gauge, Home, ArrowDownLeft, ArrowUpRight, Zap, ZapOff, Wand2, Square, Grip, Heart, CalendarDays, ImagePlus, PenLine, Disc3, CalendarClock, Keyboard, Delete, Sticker, Crop, Music, AlignCenter
} from 'lucide-react';

const MAP = {
  archive: Archive, back: ArrowLeft, mention: AtSign, ban: Ban, 'bar-chart': BarChart3, bell: Bell, 'bell-off': BellOff, bold: Bold, bookmark: BookmarkCheck, calendar: Calendar, camera: Camera,
  check: Check, 'check-check': CheckCheck, down: ChevronDown, left: ChevronLeft, right: ChevronRight, circle: Circle, dashed: CircleDashed, clock: Clock, copy: Copy, download: Download,
  eye: Eye, 'eye-off': EyeOff, file: File, doc: FileText, forward: Forward, globe: Globe, hash: Hash, headphones: Headphones, help: HelpCircle, image: Image, info: Info, translate: Languages, link: Link2,
  lock: Lock, logout: LogOut, 'map-pin': MapPin, megaphone: Megaphone, chat: MessageSquare, 'chat-plus': MessageSquarePlus, mic: Mic, 'mic-off': MicOff, monitor: Monitor, 'screen-share': MonitorUp,
  more: MoreVertical, paint: Paintbrush, palette: Palette, attach: Paperclip, pause: Pause, edit: Pencil, phone: Phone, 'phone-call': PhoneCall, 'phone-in': PhoneIncoming, 'phone-missed': PhoneMissed,
  'phone-off': PhoneOff, 'phone-out': PhoneOutgoing, pin: Pin, unpin: PinOff, play: Play, plus: Plus, qr: QrCode, reply: Reply, search: Search, send: Send, settings: Settings, share: Share2,
  shield: Shield, 'shield-check': ShieldCheck, sliders: SlidersHorizontal, 'phone-device': Smartphone, smile: Smile, star: Star, note: StickyNote, sun: Sun, moon: Moon, trash: Trash2, undo: Undo2,
  user: User, 'user-plus': UserPlus, users: Users, video: Video, 'video-off': VideoOff, volume: Volume2, x: X, tablet: Tablet, laptop: Laptop, folder: Folder, filter: Filter, refresh: RefreshCw,
  key: KeyRound, flag: Flag, edit3: Edit3, radio: Radio, 'switch-camera': SwitchCamera, tasks: ListChecks, cloud: Cloud, disk: HardDrive, database: Database, sparkles: Sparkles, wifi: Wifi,
  'wifi-off': WifiOff, mail: Mail, gauge: Gauge, home: Home, 'flash': Zap, 'flash-off': ZapOff, wand: Wand2, stop: Square, 'arrow-in': ArrowDownLeft, 'arrow-out': ArrowUpRight, keypad: Grip, heart: Heart, 'cal-grid': CalendarDays, 'image-plus': ImagePlus, pen: PenLine, updates: Disc3, 'cal-clock': CalendarClock, keyboard: Keyboard, backspace: Delete, sticker: Sticker, crop: Crop, music: Music, 'menu-lines': AlignCenter,
} as const;
export type IconName = keyof typeof MAP;

export function Icon({ name, size = 22, stroke = 1.9, className, style, fill }: { name: IconName; size?: number; stroke?: number; className?: string; style?: CSSProperties; fill?: boolean }) {
  const C = MAP[name];
  return <C size={size} strokeWidth={stroke} className={className} style={style} aria-hidden="true" fill={fill ? 'currentColor' : 'none'} />;
}
