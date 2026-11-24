/** What a chat continued from another agent was handed (the seed `chat_handoff_seed` writes). */
export interface Handoff {
  chatId: string;
  from: string;
  context: string;
}

const SEED = /^<lotus-handoff chat="([^"]*)" from="([^"]*)">\n([\s\S]*?)\n<\/lotus-handoff>\s*/;

/** Splits a first message into its handoff seed and the words the user typed. */
export function splitHandoff(message: string): { handoff: Handoff | null; text: string } {
  const match = SEED.exec(message);
  if (!match) return { handoff: null, text: message };
  return { handoff: { chatId: match[1], from: match[2], context: match[3] }, text: message.slice(match[0].length) };
}
