export type Buttons = { text: string; callback_data: string }[][];
export const button = (text: string, command: string) => ({ text, callback_data: command });
export const BACK: Buttons = [[button('‹ Control panel', 'menu')]];
export const HOME: Buttons = [
  [button('🧠 Model', 'model'), button('⚙️ Effort', 'efforts'), button('⚡ Speed', 'fast')],
  [button('💬 Sessions', 'session'), button('➕ New chat', 'new chat')],
  [button('📝 Memory', 'memory'), button('📁 Projects', 'projects')],
  [button('📊 Tokens', 'token count'), button('💵 Cost', 'cost')],
  [button('📎 Files', 'files'), button('ℹ️ Status', 'status')],
  [button('📷 Photo batch', 'batch'), button('📋 Task queue', 'queue')],
  [button('⏰ Schedules', 'schedules'), button('🗑 Trash', 'trash')],
  [button('💾 Backups', 'backup'), button('🩺 Health', 'health')],
  [button('🔑 Key status', 'keys')],
  [button('⏹ Stop task', 'stop'), button('❔ Help', 'help')],
];
