import { MessageCircle, Send, Hash } from 'lucide-react';

export function ChatAppsVisual() {
  return (
    <div className="bg-surface p-6 flex items-center justify-center gap-4 w-[280px] h-[160px]">
      <div className="w-10 h-10 rounded-full flex items-center justify-center bg-[#25D366]">
        <MessageCircle size={20} color="white" />
      </div>
      <div className="w-10 h-10 rounded-full flex items-center justify-center bg-[#0088CC]">
        <Send size={20} color="white" />
      </div>
      <div className="w-10 h-10 rounded-full flex items-center justify-center bg-[#E01E5A]">
        <Hash size={20} color="white" />
      </div>
    </div>
  );
}
